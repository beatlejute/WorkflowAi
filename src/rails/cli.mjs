/**
 * Rails — CLI (спецификация §10): `rails start | goto | status | reset |
 * report | check | coverage | selfcheck | complete | exit`.
 *
 * `run(argv, {cwd, env})` — чистая точка входа для тестов: не читает
 * `process.argv`/`process.env`/`process.cwd()` напрямую, возвращает
 * `{code, stdout}` вместо печати. `main()` (запускается только при прямом
 * запуске файла) оборачивает `run()` вводом/выводом настоящего процесса.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { findProjectRoot } from '../lib/find-root.mjs';
import { loadSkillRuntime, buildDenyReason } from './core.mjs';
import { loadRailsConfig, validateRailsConfig } from './rails-config.mjs';
import { loadSkillGraph } from './graph.mjs';
import { realpathDeep } from './paths.mjs';
import {
  loadState,
  saveState,
  startState,
  deleteState,
  applyGoto,
  describeTransitions,
  currentNodeInfo,
  newestSessionId,
  listSessionIds,
  RAILS_CLI,
} from './state.mjs';
import { appendDenial, appendEvent, readJournal, readJournalFile, summarize } from './journal.mjs';
import { checkCoverage } from './coverage.mjs';
import { rememberSessionRoot } from './session-memo.mjs';
import {
  recordCompletion,
  performExit,
  grantPath,
  grantTemplate,
  verifyTranscriptOwnership,
} from './completion.mjs';

// --- разбор аргументов -------------------------------------------------------------

// Простой детерминированный разбор: `--key value` (value — следующий токен,
// если он сам не начинается с `--`), либо `--key` как булев флаг. Позиционные
// аргументы — всё остальное, по порядку.
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = list[i + 1];
      if (next !== undefined && !String(next).startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// Переход — строкой «id: лейбл → готовая команда» (state.describeTransitions); ребро,
// закрытое стражем, — «закрыто: причина» без команды.
function formatTransitions(state, graph, config, guardCtx) {
  const lines = describeTransitions(state, graph, config, guardCtx);
  if (lines.length === 0) return 'Переходы: нет';
  return `Переходы:\n${lines.map((l) => `  ${l}`).join('\n')}`;
}

// Строка, которую выражение `output.final_requires`/`pause_requires` находит в ответе, или null,
// если литералом её не записать. `\s*` после «:» — пробел, иначе ничего; `\s+` и `\s` — пробел; `\b` — ничего;
// экранированный знак — он сам; группа литеральных вариантов `(a|b)`/`(?:a|b)` — «<a|b>».
// Классы, `.`, квантификаторы, якоря и прочие escape'ы (`\d`, `\n`) — null: такое выражение
// печатается как есть.
const REGEX_META = new Set(['.', '*', '+', '?', '[', ']', '{', '}', '^', '$', '|', ')']);
const ESCAPED_LITERAL_RE = /^[^A-Za-z0-9]$/;
const ALTERNATIVE_RE = /^[\p{L}\p{N}_ -]+$/u;

function requirementLiteral(pattern) {
  const src = String(pattern ?? '');
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) return null;
      i += 1;
      if (n === 's') {
        const q = src[i + 1];
        if (q === '*') {
          i += 1;
          if (out.endsWith(':')) out += ' ';
        } else {
          if (q === '+') i += 1;
          out += ' ';
        }
      } else if (n === 'b') {
        // граница слова — не символ
      } else if (ESCAPED_LITERAL_RE.test(n)) {
        out += n;
      } else {
        return null;
      }
      continue;
    }
    if (c === '(') {
      const close = src.indexOf(')', i);
      if (close === -1 || /^[?*+{]$/.test(src[close + 1] ?? '')) return null;
      const body = src.slice(i + 1, close).replace(/^\?:/, '');
      const variants = body.split('|');
      if (!variants.every((v) => ALTERNATIVE_RE.test(v))) return null;
      out += variants.length > 1 ? `<${variants.join('|')}>` : variants[0];
      i = close;
      continue;
    }
    if (REGEX_META.has(c)) return null;
    out += c;
  }
  return out.trim() ? out : null;
}

// Требования выходного слоя к ответу в терминальном узле (литералы output.final_requires) или
// в узле паузы (output.pause_requires) — рядом с лейблом узла, куда пришёл goto. Анализ
// 2026-10-01 (final-answer-split): строки final_requires стояли в лейбле предыдущего узла,
// терминал говорил только «Остановиться», и Stop-хук отклонял ответ; goto печатал лейбл
// терминала и «Переходы: нет». Узел паузы требует тех же литералов, только из pause_requires
// (output-check берёт набор по положению): без подсказки агент в P6S3 не знает строки RAILS.
function formatFinalRequirements(state, config) {
  const node = state?.node;
  const terminal = Array.isArray(config?.terminal) ? config.terminal : [];
  const pause = Array.isArray(config?.pause_nodes) ? config.pause_nodes : [];
  const atTerminal = terminal.includes(node);
  const atPause = !atTerminal && pause.includes(node);
  if (!atTerminal && !atPause) return null;
  const key = atPause ? 'pause_requires' : 'final_requires';
  const requires = Array.isArray(config?.output?.[key]) ? config.output[key] : [];
  if (requires.length === 0) return null;
  const rows = requires.map((p) => {
    const literal = requirementLiteral(p);
    return literal === null ? `  выражение /${p}/` : `  ${literal}`;
  });
  const head = atPause ? 'Ответ в узле паузы' : 'Финальный ответ';
  return `${head} — здесь, текстом сообщения; выходной слой требует в нём строки (output.${key}):\n${rows.join('\n')}`;
}

// Хвост вывода по текущему узлу — одинаковый у goto и status: требования выходного слоя в
// терминале или узле паузы и допустимые переходы. QA-178: `status | grep «Переходы»` давал
// пусто — перечень переходов печатали только start и goto.
function nodeFooter(state, graph, config, guardCtx) {
  const lines = [];
  const requirements = formatFinalRequirements(state, config);
  if (requirements) lines.push(requirements);
  lines.push(formatTransitions(state, graph, config, guardCtx));
  return lines;
}

// §5: --session, иначе WORKFLOW_RAILS_SESSION, иначе самый свежий файл
// состояния проекта (с предупреждением в stderr — забота CLI).
// Инцидент 2026-09-23: в проекте работали две сессии коуча, команда `goto` без `--session`
// взяла самую свежую сессию (чужую) и записала в её журнал отказ по чужому узлу. Теперь
// угадывание допустимо только при ОДНОЙ сессии проекта; при двух и более — отказ с перечнем
// (ложный отказ дешевле правки чужого состояния). Явные `--session` и WORKFLOW_RAILS_SESSION
// работают всегда.
function resolveSessionId(root, flags, env) {
  if (flags.session) return { sessionId: String(flags.session), guessed: false, sessions: [] };
  if (env && env.WORKFLOW_RAILS_SESSION) return { sessionId: String(env.WORKFLOW_RAILS_SESSION), guessed: false, sessions: [] };

  const sessions = listSessionIds(root);
  if (sessions.length > 1) return { sessionId: null, guessed: false, sessions };
  const newest = sessions[0] ?? null;
  if (newest) {
    try {
      process.stderr.write(`rails: --session не задан, в проекте одна сессия: ${newest}\n`);
    } catch {
      // stderr недоступен — не наша забота
    }
    return { sessionId: newest, guessed: true, sessions };
  }
  return { sessionId: null, guessed: false, sessions };
}

// Текст отказа при неоднозначности: перечень сессий и что делать.
function ambiguousSessionError(sessions) {
  const list = sessions.map((s) => `  ${s}`).join('\n');
  return {
    code: 1,
    stdout: `Ошибка: в проекте ${sessions.length} сессии рельсов, --session не задан — команда могла бы уйти в чужую сессию.\nСессии (от свежей):\n${list}\nЗадай --session <id> или WORKFLOW_RAILS_SESSION.\n`,
  };
}

// Тикет запуска для `{ticket}` в стражах рёбер (§4 edge_guards): сначала из состояния
// сессии — его пишет хук из окружения хоста при первом действии агента, раньше, чем
// выполнится `start` (§5), и команда агента его не меняет; WORKFLOW_RAILS_TICKET окружения
// CLI — только если в состоянии тикета нет (состояние создано без хука). Ревью стража
// 2026-09-27: окружение CLI агент подменяет — `WORKFLOW_RAILS_TICKET=… node …cli.mjs goto`,
// `export`/`env`/`unset` перед вызовом хук не считает cli-вызовом, но на P0Q1 execute-task
// их пропускают общие правила (проверено decide()), а пустой или чужой тикет открывает страж.
function runTicket(state, env) {
  return (state && state.ticket) || (env && env.WORKFLOW_RAILS_TICKET) || null;
}

// Корень проекта и тикет запуска для стражей рёбер; `state` — состояние сессии, из которого
// берётся тикет (runTicket).
function guardContext(root, env, state) {
  return { root, ticket: runTicket(state, env) };
}

// --- start -----------------------------------------------------------------------------

// Скил запуска — WORKFLOW_RAILS_SKILL (ставят раннер стадии и раннер тестов скилов): по нему
// хук создаёт состояние сессии при первом действии, по нему раннер после выхода агента
// проверяет финальный ответ (output-check, терминал этого скила). Прогон PulseProxy
// 2026-09-27: claude-haiku на QA-тикете стадии execute-task принял подсказку «Твоя роль:
// manual-testing» за скил, `start manual-testing` получил «сессия уже привязана к
// execute-task, используй --force», повторил с --force и прошёл граф manual-testing — раннер
// отклонил ответ: узел P9S2 не терминал execute-task. Поэтому при заданном скиле запуска
// (с rails.yaml) другой скил не стартует и с --force; отказ называет скил запуска и как
// продолжить. Скил запуска без rails.yaml раннер не проверяет — там отказа нет.
//
// Признаков скила запуска два, отказ — по любому: переменная окружения процесса CLI и
// состояние сессии, привязанное к запуску раннера (`run`). Его хук создаёт при первом
// действии агента — раньше, чем выполнится сама команда start, — по окружению процесса
// хоста, которое команда агента не меняет. Окружение CLI меняет: `VAR=… node cli.mjs` под
// POSIX, `env`/`export` там, где shell-команду пропускают общие правила. Имя переменной
// агенту не называется — ни здесь, ни в подсказке SessionStart.
function foreignRunSkill(root, env, existing, skill) {
  const envSkill = env && typeof env.WORKFLOW_RAILS_SKILL === 'string' ? env.WORKFLOW_RAILS_SKILL : '';
  if (envSkill && envSkill !== skill && hasRailsYaml(root, envSkill)) return envSkill;
  if (existing && existing.run && existing.skill && existing.skill !== skill) return existing.skill;
  return null;
}

function foreignSkillRefusal({ root, skill, runSkill, sessionId, explicitSession, existing, env }) {
  const lines = [
    `Ошибка: скил этого запуска — "${runSkill}" (его задал раннер): по нему ведётся состояние сессии и проверяется финальный ответ. Скил "${skill}" в этом запуске не стартует, --force этого не меняет.`,
    'Роль и тип задачи в промпте описывают содержание работы, а не скил процедуры.',
  ];
  let node = null;
  if (existing && existing.skill === runSkill) {
    node = existing.node;
    let graph = null;
    let config = null;
    try {
      ({ config, graph } = loadSkillRuntime(root, runSkill, existing));
    } catch {
      // граф может быть битым — отказ всё равно называет узел
    }
    const label = graph ? graph.node(existing.node)?.label ?? '' : '';
    lines.push(`Сессия ${sessionId} уже идёт по "${runSkill}": числится ${existing.node} «${label}» — продолжай оттуда.`);
    if (graph) lines.push(formatTransitions(existing, graph, config, guardContext(root, env, existing)));
  } else {
    const session = explicitSession ? ` --session ${sessionId}` : '';
    lines.push(`Старт скила запуска: node ${RAILS_CLI} start ${runSkill}${session}${existing ? ' --force' : ''}`);
  }
  try {
    appendDenial(root, {
      session: sessionId,
      skill: runSkill,
      node,
      run: (env && env.WORKFLOW_RAILS_RUN) || null,
      reason: `start ${skill}: скил этого запуска — ${runSkill}`,
      command: `start ${skill}`,
    });
  } catch {
    // журнал не должен ронять CLI
  }
  return { code: 2, stdout: `${lines.join('\n')}\n` };
}

function cmdStart(root, positional, flags, env) {
  const skill = positional[0];
  if (!skill) {
    return { code: 1, stdout: 'Ошибка: не указан скил. Использование: start <skill> [--session S] [--force]\n' };
  }

  const explicitSession = Boolean(flags.session || (env && env.WORKFLOW_RAILS_SESSION));
  const sessionId = flags.session ? String(flags.session) : (env && env.WORKFLOW_RAILS_SESSION) || randomUUID();
  // Явный идентификатор сессии (хук или человек) — запомнить «сессия → корень», чтобы
  // хук сессии из каталога-зонтика находил корень для shell-команд (session-memo.mjs).
  if (explicitSession) rememberSessionRoot(sessionId, root);
  const existing = loadState(root, sessionId);
  // Штатный выход: старый запуск не перезаписывается — новый (тем же скилом
  // или другим, даже с --force) открывает владелец новой сессией.
  if (existing?.completed) {
    try {
      appendDenial(root, {
        session: sessionId,
        skill: existing.skill,
        node: existing.node,
        run: (env && env.WORKFLOW_RAILS_RUN) || null,
        reason: `start поверх завершённой сессии отклонён: выход выполнен ${existing.completed.t}, состояние и история сохраняются`,
        command: `start ${skill}`,
      });
    } catch {
      // журнал не должен ронять CLI
    }
    return {
      code: 2,
      stdout: `Ошибка: сессия ${sessionId} завершена штатным выходом (${existing.completed.t}); перезапуск скила "${skill}" в ней не выполняется, --force этого не меняет. Новый запуск открывает владелец новой сессией.\n`,
    };
  }
  const runSkill = foreignRunSkill(root, env, existing, skill);
  if (runSkill) {
    return foreignSkillRefusal({ root, skill, runSkill, sessionId, explicitSession, existing, env });
  }
  // §5: «уже есть состояние для другого скила → отказ, если не --force».
  if (existing && existing.skill !== skill) {
    // Правки исходников скила активирует новый запуск владельца, а не --force
    // поверх закреплённого запуска: иначе правка + force-start заменяла бы
    // полномочия текущего запуска.
    if (existing.runtime) {
      return {
        code: 2,
        stdout: `Ошибка: сессия ${sessionId} идёт по "${existing.skill}" с закреплённым runtime; перезапись другим скилом запрещена. Новый запуск открывает владелец.\n`,
      };
    }
    if (!flags.force) {
      return {
        code: 2,
        stdout: `Ошибка: сессия ${sessionId} уже привязана к скилу "${existing.skill}". Используй --force для перезаписи.\n`,
      };
    }
  }

  // Один и тот же скил — идемпотентный resume: узел, история, счётчики и привязка
  // runtime сохраняются; правки исходников скила это не активирует.
  if (existing && existing.skill === skill) {
    let runtime;
    try {
      runtime = loadSkillRuntime(root, skill, existing);
    } catch (err) {
      return { code: 1, stdout: `Ошибка: сессия уже идёт по "${skill}", но runtime не закреплён: ${err && err.message ? err.message : err}\n` };
    }
    try {
      saveState(root, existing); // закреплённая привязка runtime — на диск
    } catch {
      // сохранение не должно ронять CLI
    }
    const label = runtime.graph.node(existing.node)?.label ?? '';
    const lines = [
      `Числишься: скил "${skill}", сессия ${sessionId}, узел ${existing.node} «${label}» — продолжай оттуда.`,
      ...nodeFooter(existing, runtime.graph, runtime.config, guardContext(root, env, existing)),
    ];
    return { code: 0, stdout: `Старт: скил "${skill}", сессия ${sessionId} — уже идёт.\n${lines.join('\n')}\n` };
  }

  let config;
  let graph;
  try {
    ({ config, graph } = loadSkillRuntime(root, skill));
  } catch (err) {
    return { code: 1, stdout: `Ошибка загрузки скила "${skill}": ${err && err.message ? err.message : err}\n` };
  }
  if (typeof config.entry !== 'string' || !config.entry) {
    return { code: 1, stdout: `Ошибка: rails.yaml скила "${skill}" не задаёт entry.\n` };
  }

  // Тикет запуска из состояния, которое хук создал при первом действии, переживает
  // перезапись состояния: иначе `start` заменял бы его тикетом из окружения CLI (runTicket).
  const ticket = runTicket(existing, env);
  const state = startState({ root, sessionId, skill, entry: config.entry, run: (env && env.WORKFLOW_RAILS_RUN) || null, ticket });
  try {
    loadSkillRuntime(root, skill, state); // закрепить runtime нового запуска сразу
    saveState(root, state);               // и сохранить привязку на диске
  } catch (err) {
    return { code: 1, stdout: `Ошибка: runtime нового запуска не закреплён: ${err && err.message ? err.message : err}\n` };
  }
  const entryNode = graph.node(config.entry);
  const label = entryNode ? entryNode.label : '';

  const lines = [
    `Старт: скил "${skill}", сессия ${sessionId}`,
    `${config.entry}: «${label}»`,
    formatTransitions(state, graph, config, guardContext(root, env, state)),
  ];
  return { code: 0, stdout: `${lines.join('\n')}\n` };
}

// --- goto ------------------------------------------------------------------------------

function cmdGoto(root, positional, flags, env) {
  const node = positional[0];
  if (!node) {
    return { code: 1, stdout: 'Ошибка: не указан целевой узел. Использование: goto <node> --quote "<текст>" [--session S]\n' };
  }
  const quote = typeof flags.quote === 'string' ? flags.quote : '';

  const { sessionId, sessions } = resolveSessionId(root, flags, env);
  if (!sessionId && sessions.length > 1) return ambiguousSessionError(sessions);
  if (!sessionId) {
    return { code: 1, stdout: 'Ошибка: нет активной сессии (задай --session/WORKFLOW_RAILS_SESSION или сначала start).\n' };
  }

  const state = loadState(root, sessionId);
  if (!state) {
    return { code: 1, stdout: `Ошибка: состояние сессии ${sessionId} не найдено. Сначала start.\n` };
  }
  if (state.completed) {
    try {
      appendDenial(root, {
        session: sessionId,
        skill: state.skill,
        node: state.node,
        reason: `goto в завершённой сессии отклонён: выход выполнен ${state.completed.t}`,
        command: `goto ${node}`,
      });
    } catch {
      // журнал не должен ронять CLI
    }
    return {
      code: 2,
      stdout: `Ошибка: сессия ${sessionId} завершена штатным выходом (${state.completed.t}); переходы закрыты, состояние и история сохраняются.\n`,
    };
  }

  let config;
  let graph;
  try {
    ({ config, graph } = loadSkillRuntime(root, state.skill, state));
  } catch (err) {
    return { code: 1, stdout: `Ошибка загрузки скила "${state.skill}": ${err && err.message ? err.message : err}\n` };
  }

  const guardCtx = guardContext(root, env, state);
  const result = applyGoto(state, graph, config, { node, quote, ...guardCtx });
  try {
    saveState(root, state); // и при успехе (node/history), и при отказе (denials) — applyGoto мутирует state на месте.
  } catch {
    // сохранение состояния не должно ронять CLI
  }

  if (!result.ok) {
    try {
      appendDenial(root, {
        session: sessionId,
        skill: state.skill,
        node: state.node,
        run: (env && env.WORKFLOW_RAILS_RUN) || null,
        reason: result.reason,
      });
    } catch {
      // журнал не должен ронять CLI
    }
    const reason = buildDenyReason({
      what: `goto ${node}`,
      why: result.reason,
      allowed: describeTransitions(state, graph, config, guardCtx),
    });
    return { code: 2, stdout: `${reason}\n` };
  }

  const currentNode = graph.node(state.node);
  const label = currentNode ? currentNode.label : '';
  const lines = [`RAILS: числится ${state.node} «${label}»`, ...nodeFooter(state, graph, config, guardCtx)];
  return { code: 0, stdout: `${lines.join('\n')}\n` };
}

// --- status ----------------------------------------------------------------------------

function cmdStatus(root, positional, flags, env) {
  const { sessionId, sessions } = resolveSessionId(root, flags, env);
  if (!sessionId && sessions.length > 1) return ambiguousSessionError(sessions);
  if (!sessionId) return { code: 1, stdout: 'Ошибка: нет активной сессии.\n' };

  const state = loadState(root, sessionId);
  if (!state) return { code: 1, stdout: `Ошибка: состояние сессии ${sessionId} не найдено.\n` };

  let graph = null;
  let config = null;
  try {
    ({ config, graph } = loadSkillRuntime(root, state.skill, state));
  } catch {
    // граф может быть битым — статус всё равно печатаем по состоянию
  }
  const label = graph ? graph.node(state.node)?.label ?? '' : '';
  const info = currentNodeInfo(state);

  const historyTail = (state.history || [])
    .slice(-5)
    .map((h) => `  ${h.t}: ${h.from} -> ${h.to}`)
    .join('\n');

  const lines = [
    `Сессия: ${sessionId}`,
    `Скил: ${state.skill}`,
    `Узел: ${state.node} «${label}» (этап ${info.stage ?? '?'}, тип ${info.type ?? '?'})`,
    ...(state.completed
      ? [`Состояние: завершена штатным выходом ${state.completed.t} — рельсы сессию не ведут`]
      : state.completion
        ? [`Подтверждение завершения: есть (${state.completion.t}), выход — после разрешения владельца (rails exit)`]
        : []),
    `Счётчики: ${JSON.stringify(state.counters || {})}`,
    `Отказы по узлам: ${JSON.stringify(state.denials || {})}`,
    `Последние переходы:${historyTail ? `\n${historyTail}` : ' нет'}`,
  ];
  // Переходы — как у goto; граф не загрузился — перечня нет, и это сказано.
  if (graph) lines.push(...nodeFooter(state, graph, config, guardContext(root, env, state)));
  else lines.push('Переходы: граф скила не загружен (см. cli check --skill)');
  return { code: 0, stdout: `${lines.join('\n')}\n` };
}

// --- reset -----------------------------------------------------------------------------

function cmdReset(root, positional, flags, env) {
  const { sessionId, sessions } = resolveSessionId(root, flags, env);
  if (!sessionId && sessions.length > 1) return ambiguousSessionError(sessions);
  if (!sessionId) return { code: 1, stdout: 'Ошибка: нет активной сессии.\n' };

  const state = loadState(root, sessionId);
  // Завершённая сессия хранится целиком (состояние, история, журнал) — сброс
  // и после штатного выхода запрещён.
  if (state?.completed) {
    try {
      appendDenial(root, {
        session: sessionId,
        skill: state.skill,
        node: state.node,
        reason: `reset завершённой сессии отклонён: выход выполнен ${state.completed.t}, состояние и история сохраняются`,
        command: 'reset',
      });
    } catch {
      // журнал не должен ронять CLI
    }
    return {
      code: 2,
      stdout: `Ошибка: сессия ${sessionId} завершена штатным выходом (${state.completed.t}) — reset отклонён: состояние и история сохраняются.\n`,
    };
  }
  // Сброс закреплённого запуска — не путь активации правок исходников: его
  // открывает владелец через внешнюю политику, а не команда агента.
  if (state?.runtime) {
    try {
      appendDenial(root, {
        session: sessionId,
        skill: state.skill,
        node: state.node,
        reason: 'reset закреплённого запуска отклонён: правки исходников активирует новый запуск владельца',
        command: 'reset',
      });
    } catch {
      // журнал не должен ронять CLI
    }
    return {
      code: 2,
      stdout: `Ошибка: сессия ${sessionId} идёт по "${state.skill}" с закреплённым runtime — reset отклонён: правки исходников активирует новый запуск владельца, не сброс состояния.\n`,
    };
  }
  deleteState(root, sessionId);
  try {
    appendEvent(root, {
      type: 'reset',
      session: sessionId,
      skill: state ? state.skill : null,
      node: state ? state.node : null,
      run: (env && env.WORKFLOW_RAILS_RUN) || null,
    });
  } catch {
    // журнал не должен ронять CLI
  }
  return { code: 0, stdout: `Сброшено: сессия ${sessionId}\n` };
}

// --- complete / exit (штатный выход, README §16) ---------------------------------------

// `complete --transcript <файл>` — доверенная проверка исторического финального
// ответа закреплённого запуска (последнее сообщение ассистента из transcript)
// и запись подтверждения завершения. Transcript обязан принадлежать сессии
// (имя файла и записи); приостановка, не-терминальный узел, чужой/пустой
// ответ подтверждения не создают.
function cmdComplete(root, positional, flags, env, cwd = process.cwd()) {
  if (typeof flags.transcript !== 'string' || !flags.transcript) {
    return { code: 1, stdout: 'Ошибка: нужен --transcript <файл> (jsonl transcript сессии).\n' };
  }
  const { sessionId, sessions } = resolveSessionId(root, flags, env);
  if (!sessionId && sessions.length > 1) return ambiguousSessionError(sessions);
  if (!sessionId) return { code: 1, stdout: 'Ошибка: нет активной сессии.\n' };

  let state;
  try {
    state = loadState(root, sessionId);
  } catch (err) {
    return { code: 1, stdout: `Ошибка: ${err && err.message ? err.message : err}\n` };
  }
  if (!state) return { code: 1, stdout: `Ошибка: состояние сессии ${sessionId} не найдено.\n` };
  if (state.completed) {
    return { code: 2, stdout: `Сессия ${sessionId} уже завершена штатным выходом (${state.completed.t}) — подтверждение не требуется.\n` };
  }

  const transcriptPath = resolvePath(cwd, flags.transcript);
  const ownership = verifyTranscriptOwnership(transcriptPath, sessionId);
  if (!ownership.ok) {
    return { code: 2, stdout: `Ошибка: transcript не принят: ${ownership.reason}\n` };
  }

  const result = recordCompletion({ root, state, source: 'cli-transcript', transcriptPath });
  if (!result.ok) {
    const missing = Array.isArray(result.missing) && result.missing.length > 0 ? `\nНе выполнено: ${result.missing.join('; ')}` : '';
    return { code: 2, stdout: `Подтверждение не создано: ${result.reason}.${missing}\n` };
  }

  const c = result.completion;
  const lines = [
    `Подтверждение завершения записано: сессия ${sessionId}, узел ${c.node}, ответ ${c.answer_sha256.slice(0, 12)}…`,
    `verdict: ${c.verdict ?? 'не указан в ответе'}`,
    'Выход — после одноразового разрешения владельца: rails exit',
  ];
  return { code: 0, stdout: `${lines.join('\n')}\n` };
}

// `exit` — штатный выход из роли: подтверждение + одноразовое разрешение
// владельца (файл в защищённом каталоге состояний, шаблон печатается при
// отказе). Состояние, история, счётчики, runtime и журнал сохраняются; хуки
// и CLI сессию больше не ведут, роль из окружения не возвращается.
function cmdExit(root, positional, flags, env) {
  const { sessionId, sessions } = resolveSessionId(root, flags, env);
  if (!sessionId && sessions.length > 1) return ambiguousSessionError(sessions);
  if (!sessionId) return { code: 1, stdout: 'Ошибка: нет активной сессии.\n' };

  const state = loadState(root, sessionId);
  if (!state) return { code: 1, stdout: `Ошибка: состояние сессии ${sessionId} не найдено.\n` };

  const result = performExit({ root, session: sessionId });
  if (!result.ok) {
    const lines = [`Выход не выполнен: ${result.reason}`];
    if (result.grantPath && result.grantTemplate) {
      lines.push(
        'Разрешение владельца: создай файл своими руками (не средствами агента) —',
        `  ${result.grantPath}`,
        '  с содержимым:',
        JSON.stringify(result.grantTemplate),
        'и повтори: node .workflow/src/rails/cli.mjs exit'
      );
    }
    return { code: 2, stdout: `${lines.join('\n')}\n` };
  }

  const lines = [
    `Выход выполнен: сессия ${sessionId}, скил "${result.state.skill}" завершён (${result.state.completed.t}).`,
    'Состояние, история, счётчики, привязка runtime и журнал сохранены; хуки и CLI сессию больше не ведут.',
    'Роль из окружения хоста не возвращается: перезапуск скила в этой сессии закрыт, новый запуск открывает владелец новой сессией.',
  ];
  return { code: 0, stdout: `${lines.join('\n')}\n` };
}

// --- report ----------------------------------------------------------------------------

// `--journal <файл|каталог>`: вместо журнала проекта — jsonl-файл или все `*.jsonl`
// под каталогом (раннер тестов сохраняет журналы workdir'ов в
// `tests/cases/<TC>/current/<agent>/rails-trial-N.jsonl`).
function collectJournalFiles(target) {
  let st;
  try {
    st = statSync(target);
  } catch {
    return [];
  }
  if (st.isFile()) return [target];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && /\.jsonl$/i.test(ent.name)) out.push(full);
    }
  };
  walk(target, 0);
  return out.sort();
}

function cmdReport(root, positional, flags, cwd = process.cwd()) {
  const days = flags.days !== undefined ? Number(flags.days) : undefined;
  const skill = flags.skill !== undefined ? String(flags.skill) : undefined;
  const opts = { days: Number.isFinite(days) ? days : undefined, skill };
  let entries;
  let source = '';
  if (flags.journal !== undefined) {
    const target = resolvePath(cwd, String(flags.journal));
    const files = collectJournalFiles(target);
    entries = files.flatMap((f) => readJournalFile(f, opts));
    source = ` [${files.length} файл(ов) из ${target}]`;
  } else {
    entries = readJournal(root, opts);
  }
  const summary = summarize(entries);

  const lines = [];
  lines.push(`Отчёт rails${skill ? ` (скил: ${skill})` : ''}${Number.isFinite(days) ? ` за ${days} дн.` : ''}${source}`);
  lines.push(`Всего записей: ${summary.total}`);

  lines.push('Отказы по узлу:');
  const byNode = Object.entries(summary.denialsByNode);
  if (byNode.length === 0) lines.push('  нет');
  for (const [node, count] of byNode) lines.push(`  ${node}: ${count}`);

  lines.push('Узлы с ≥3 повторами в одной сессии:');
  if (summary.repeatedNodes.length === 0) lines.push('  нет');
  for (const r of summary.repeatedNodes) lines.push(`  ${r.node} (сессия ${r.session}): ${r.count}`);

  lines.push(`Срабатывания потолков циклов: ${JSON.stringify(summary.cycleLimitHits)}`);
  lines.push(`Срабатывания потолков действий: ${JSON.stringify(summary.actionLimitHits)}`);
  lines.push(`Сбросы: ${summary.resets}`);
  lines.push(`Подтверждения завершения: ${summary.completions}; штатные выходы: ${summary.exits}`);
  lines.push(`Stop-блоки: ${summary.stopBlocks.total} (${JSON.stringify(summary.stopBlocks.byNode)})`);
  // Канарейка — проверка живости, а не отказ: summarize() не кладёт её в «Отказы по узлу» и в
  // узлы с повторами (журнал 2026-09-30: четверть–треть записей «отказов»), число — здесь.
  lines.push(`Канарейка (проверка живости, не отказ): ${summary.canaries.total} (${JSON.stringify(summary.canaries.byNode)})`);
  lines.push(`Ошибки хука: ${summary.errors}`);

  return { code: 0, stdout: `${lines.join('\n')}\n` };
}

// --- check -----------------------------------------------------------------------------

function listSkills(root) {
  const dir = join(root, '.workflow', 'src', 'skills');
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
}

function checkOneSkill(root, skill) {
  const skillDir = join(root, '.workflow', 'src', 'skills', skill);
  const out = { skill, configErrors: [], graphErrors: [], graphWarnings: [], stats: null, loadError: null };

  let config;
  try {
    config = loadRailsConfig(skillDir);
  } catch (err) {
    out.loadError = `rails.yaml: ${err && err.message ? err.message : err}`;
    return out;
  }
  out.configErrors = validateRailsConfig(config).errors;

  try {
    const graph = loadSkillGraph(skillDir, config);
    const v = graph.validate(config);
    out.graphErrors = v.errors;
    out.graphWarnings = v.warnings;
    out.stats = v.stats;
  } catch (err) {
    out.loadError = `граф: ${err && err.message ? err.message : err}`;
  }
  return out;
}

function formatSkillCheck(r) {
  const lines = [`Скил "${r.skill}":`];
  if (r.loadError) {
    lines.push(`  ОШИБКА ЗАГРУЗКИ: ${r.loadError}`);
    return lines.join('\n');
  }
  if (r.configErrors.length === 0 && r.graphErrors.length === 0) {
    lines.push('  OK');
  }
  for (const e of r.configErrors) lines.push(`  [rails.yaml:${e.code}] ${e.field}: ${e.message}`);
  for (const e of r.graphErrors) lines.push(`  [граф:${e.code}] ${e.message}`);
  for (const w of r.graphWarnings) lines.push(`  [warn:${w.code}] ${w.message}`);
  if (r.stats) {
    lines.push(
      `  Статистика: узлов ${r.stats.nodes} (${JSON.stringify(r.stats.nodesByType)}), рёбер ${r.stats.edges}, этапов ${r.stats.stages}`
    );
  }
  return lines.join('\n');
}

function skillHasErrors(r) {
  return Boolean(r.loadError) || r.configErrors.length > 0 || r.graphErrors.length > 0;
}

// Скил без rails.yaml (major-находка ревью wp4): `--all`/`selfcheck` обходят
// ВСЕ каталоги `.workflow/src/skills`, но не у каждого скила есть rails.yaml —
// он мог ещё не быть переведён на рельсы. Явный `check --skill <name>`
// (пользователь назвал скил прямо) этим фильтром не затрагивается: там
// отсутствующий rails.yaml — по-прежнему loadError через checkOneSkill.
function hasRailsYaml(root, skill) {
  return existsSync(join(root, '.workflow', 'src', 'skills', skill, 'rails.yaml'));
}

function cmdCheck(root, positional, flags) {
  let skills;
  let skippedNoConfig = [];
  if (flags.all) {
    const all = listSkills(root);
    if (all.length === 0) return { code: 0, stdout: 'Скилов не найдено (.workflow/src/skills пуст).\n' };
    skippedNoConfig = all.filter((s) => !hasRailsYaml(root, s));
    skills = all.filter((s) => hasRailsYaml(root, s));
  } else if (flags.skill) {
    skills = [String(flags.skill)];
  } else {
    return { code: 1, stdout: 'Ошибка: укажи --skill <name> или --all.\n' };
  }

  const results = skills.map((s) => checkOneSkill(root, s));
  const lines = results.map(formatSkillCheck);
  for (const s of skippedNoConfig) lines.push(`Скил "${s}":\n  пропущен: нет rails.yaml`);
  lines.push('Примечание: граф разобран собственным парсером подмножества mermaid, не официальным (§3/§14).');
  const stdout = `${lines.join('\n\n')}\n`;
  const hasErrors = results.some(skillHasErrors);
  return { code: hasErrors ? 1 : 0, stdout };
}

// --- coverage --------------------------------------------------------------------------

function cmdCoverage(root, positional, flags, env, cwd) {
  const skill = flags.skill !== undefined ? String(flags.skill) : undefined;
  const baselineRef = flags.baseline !== undefined ? String(flags.baseline) : undefined;
  if (!skill || !baselineRef) {
    return { code: 1, stdout: 'Ошибка: нужны --skill <name> и --baseline <git-ref>.\n' };
  }

  // Карта миграции. Прогон коуча 2026-09-22: `--map rails-migration.yaml` из корня проекта
  // резолвился от cwd в несуществующий файл, loadMap молча отдавал пустую карту — 151/200
  // вместо 200/200 без единого слова об ошибке. Теперь: относительный путь — от cwd, затем
  // от каталога скила; без --map — `<скил>/rails-migration.yaml`, если он есть; явная карта,
  // которой нет ни там, ни там, — ошибка. Какая карта взята — печатается строкой «Карта:».
  const skillDir = join(root, '.workflow', 'src', 'skills', skill);
  let mapFile;
  if (typeof flags.map === 'string') {
    const candidates = isAbsolute(flags.map)
      ? [flags.map]
      : [resolvePath(cwd || root, flags.map), resolvePath(skillDir, flags.map)];
    mapFile = candidates.find((p) => existsSync(p));
    if (!mapFile) {
      return { code: 1, stdout: `Ошибка: карта --map не найдена: ${candidates.join(', ')}\n` };
    }
  } else if (existsSync(join(skillDir, 'rails-migration.yaml'))) {
    mapFile = join(skillDir, 'rails-migration.yaml');
  }

  let covered;
  let missing;
  try {
    ({ covered, missing } = checkCoverage({ root, skill, baselineRef, mapFile }));
  } catch (err) {
    return { code: 1, stdout: `Ошибка: ${err && err.message ? err.message : err}\n` };
  }

  const lines = [`Покрытие скила "${skill}" от ${baselineRef}:`];
  lines.push(`Карта: ${mapFile || 'нет'}`);
  lines.push(`Покрыто: ${covered.length}`);
  lines.push(`Пропущено: ${missing.length}`);
  if (missing.length > 0) {
    lines.push('Непокрытые фразы:');
    for (const m of missing) lines.push(`  - ${m}`);
  }
  return { code: missing.length > 0 ? 1 : 0, stdout: `${lines.join('\n')}\n` };
}

// --- selfcheck -------------------------------------------------------------------------

// Открытый вопрос: точная форма записи хука в `.claude/settings.local.json`
// не в этом пакете работ (её пишет `src/init.mjs`, не файл этой спецификации).
// Простое детерминированное решение — искать записи с `_workflow_rails: true`
// и полем `command`, из которого извлекается путь к скрипту хука первым
// `node "<путь>" ...` или `node <путь> ...` в тексте команды.
function collectRailsHookPaths(settings) {
  const paths = [];
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== 'object') return paths;
  for (const eventHooks of Object.values(hooks)) {
    if (!Array.isArray(eventHooks)) continue;
    for (const matcher of eventHooks) {
      const list = matcher && Array.isArray(matcher.hooks) ? matcher.hooks : [];
      for (const h of list) {
        if (!h || h._workflow_rails !== true || typeof h.command !== 'string') continue;
        const m = /node\s+"([^"]+)"/.exec(h.command) || /node\s+(\S+)/.exec(h.command);
        if (m) paths.push(m[1]);
      }
    }
  }
  return paths;
}

function cmdSelfcheck(root) {
  const issues = [];

  const settingsPath = join(root, '.claude', 'settings.local.json');
  let settings = null;
  if (!existsSync(settingsPath)) {
    issues.push('.claude/settings.local.json отсутствует — хуки rails не зарегистрированы (workflow init).');
  } else {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (err) {
      issues.push(`.claude/settings.local.json: не парсится (${err && err.message ? err.message : err}).`);
    }
  }
  if (settings) {
    const hookPaths = collectRailsHookPaths(settings);
    if (hookPaths.length === 0) {
      issues.push('.claude/settings.local.json: нет хуков с "_workflow_rails": true.');
    }
    for (const p of hookPaths) {
      if (!existsSync(p)) issues.push(`Хук rails ссылается на несуществующий путь: ${p}`);
    }
  }

  const kiloPluginPath = join(root, '.kilo', 'plugin', 'workflow-rails.js');
  if (!existsSync(kiloPluginPath)) {
    issues.push(`.kilo/plugin/workflow-rails.js отсутствует (${kiloPluginPath}).`);
  }

  const skillResults = listSkills(root)
    .filter((s) => hasRailsYaml(root, s))
    .map((s) => checkOneSkill(root, s));
  for (const r of skillResults) {
    if (r.loadError) issues.push(`Скил "${r.skill}": ${r.loadError}`);
    else if (r.configErrors.length > 0 || r.graphErrors.length > 0) {
      issues.push(`Скил "${r.skill}": граф/rails.yaml с ошибками (см. cli check --skill ${r.skill}).`);
    }
  }

  const lines = ['Selfcheck rails:'];
  if (issues.length === 0) {
    lines.push('  OK: хуки зарегистрированы, kilo-плагин на месте, графы скилов валидны.');
  } else {
    for (const i of issues) lines.push(`  ПРОБЛЕМА: ${i}`);
  }
  return { code: issues.length > 0 ? 1 : 0, stdout: `${lines.join('\n')}\n` };
}

// --- точка входа -------------------------------------------------------------------------

/**
 * Выполняет одну команду CLI rails. Чистая относительно stdio (пишет только
 * в возвращаемый `stdout`; предупреждения о «угаданном» `--session» и
 * необработанные исключения по-прежнему уходят в `process.stderr`, как и
 * остальные модули rails, см. `state.mjs`/`core.mjs`).
 *
 * @param {string[]} argv аргументы без имени команды/интерпретатора (`['status', '--session', 'x']`)
 * @param {{cwd?: string, env?: object}} [opts]
 * @returns {{code: number, stdout: string}}
 */
export function run(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const rest = positional.slice(1);

  let root;
  try {
    root = findProjectRoot(cwd);
  } catch (err) {
    return { code: 1, stdout: `Ошибка: не найден корень проекта (.workflow/): ${err && err.message ? err.message : err}\n` };
  }

  try {
    switch (command) {
      case 'start':
        return cmdStart(root, rest, flags, env);
      case 'goto':
        return cmdGoto(root, rest, flags, env);
      case 'status':
        return cmdStatus(root, rest, flags, env);
      case 'reset':
        return cmdReset(root, rest, flags, env);
      case 'complete':
        return cmdComplete(root, rest, flags, env, cwd);
      case 'exit':
        return cmdExit(root, rest, flags, env);
      case 'report':
        return cmdReport(root, rest, flags, cwd);
      case 'check':
        return cmdCheck(root, rest, flags);
      case 'coverage':
        return cmdCoverage(root, rest, flags, env, cwd);
      case 'selfcheck':
        return cmdSelfcheck(root);
      default:
        return {
          code: 1,
          stdout: `Неизвестная команда: ${command ?? '(нет)'}\nДоступно: start | goto | status | reset | report | check | coverage | selfcheck | complete | exit\n`,
        };
    }
  } catch (err) {
    return { code: 1, stdout: `Ошибка: ${err && err.stack ? err.stack : err}\n` };
  }
}

/**
 * Точка входа при прямом запуске файла как процесса: `process.argv` →
 * `run()` → печать `stdout`, код выхода процесса.
 */
export function main() {
  const { code, stdout } = run(process.argv.slice(2), { cwd: process.cwd(), env: process.env });
  if (stdout) {
    try {
      process.stdout.write(stdout);
    } catch {
      // stdout недоступен — не наша забота, код выхода всё равно выставится
    }
  }
  process.exitCode = code;
}

// Дословное сравнение `import.meta.url === pathToFileURL(argv[1]).href` ломается
// в продакшн-раскладке: `<root>/.workflow/src/rails` — junction на канон (§2, §11),
// Node при этом реалпасит `import.meta.url` главного модуля, а `process.argv[1]`
// оставляет путём как он был передан (через junction) — строки расходятся, и
// main() не вызывается. Сравнение — только через realpath обеих сторон.
function isDirectRun() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const self = realpathDeep(fileURLToPath(import.meta.url));
    const entry = realpathDeep(argv1);
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main();
}
