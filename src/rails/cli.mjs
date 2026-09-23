/**
 * Rails — CLI (спецификация §10): `rails start | goto | status | reset |
 * report | check | coverage | selfcheck`.
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
  allowedTransitions,
  currentNodeInfo,
  newestSessionId,
  listSessionIds,
} from './state.mjs';
import { appendDenial, appendEvent, readJournal, readJournalFile, summarize } from './journal.mjs';
import { checkCoverage } from './coverage.mjs';
import { rememberSessionRoot } from './session-memo.mjs';

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

function formatTransitions(transitions) {
  if (!Array.isArray(transitions) || transitions.length === 0) return 'Переходы: нет';
  return `Переходы: ${transitions.map((t) => `${t.id}: ${t.label}`).join('; ')}`;
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

// --- start -----------------------------------------------------------------------------

function cmdStart(root, positional, flags, env) {
  const skill = positional[0];
  if (!skill) {
    return { code: 1, stdout: 'Ошибка: не указан скил. Использование: start <skill> [--session S] [--force]\n' };
  }

  const sessionId = flags.session ? String(flags.session) : (env && env.WORKFLOW_RAILS_SESSION) || randomUUID();
  // Явный идентификатор сессии (хук или человек) — запомнить «сессия → корень», чтобы
  // хук сессии из каталога-зонтика находил корень для shell-команд (session-memo.mjs).
  if (flags.session || (env && env.WORKFLOW_RAILS_SESSION)) rememberSessionRoot(sessionId, root);
  const existing = loadState(root, sessionId);
  // §5: «уже есть состояние для другого скила → отказ, если не --force».
  if (existing && existing.skill !== skill && !flags.force) {
    return {
      code: 2,
      stdout: `Ошибка: сессия ${sessionId} уже привязана к скилу "${existing.skill}". Используй --force для перезаписи.\n`,
    };
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

  const state = startState({ root, sessionId, skill, entry: config.entry, run: (env && env.WORKFLOW_RAILS_RUN) || null });
  const entryNode = graph.node(config.entry);
  const label = entryNode ? entryNode.label : '';

  const lines = [
    `Старт: скил "${skill}", сессия ${sessionId}`,
    `${config.entry}: «${label}»`,
    formatTransitions(allowedTransitions(state, graph)),
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

  let config;
  let graph;
  try {
    ({ config, graph } = loadSkillRuntime(root, state.skill));
  } catch (err) {
    return { code: 1, stdout: `Ошибка загрузки скила "${state.skill}": ${err && err.message ? err.message : err}\n` };
  }

  const result = applyGoto(state, graph, config, { node, quote });
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
      allowed: result.allowed.map((t) => `${t.id}: ${t.label}`),
    });
    return { code: 2, stdout: `${reason}\n` };
  }

  const currentNode = graph.node(state.node);
  const label = currentNode ? currentNode.label : '';
  const lines = [`RAILS: числится ${state.node} «${label}»`, formatTransitions(result.allowed)];
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
  try {
    ({ graph } = loadSkillRuntime(root, state.skill));
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
    `Счётчики: ${JSON.stringify(state.counters || {})}`,
    `Отказы по узлам: ${JSON.stringify(state.denials || {})}`,
    `Последние переходы:${historyTail ? `\n${historyTail}` : ' нет'}`,
  ];
  return { code: 0, stdout: `${lines.join('\n')}\n` };
}

// --- reset -----------------------------------------------------------------------------

function cmdReset(root, positional, flags, env) {
  const { sessionId, sessions } = resolveSessionId(root, flags, env);
  if (!sessionId && sessions.length > 1) return ambiguousSessionError(sessions);
  if (!sessionId) return { code: 1, stdout: 'Ошибка: нет активной сессии.\n' };

  const state = loadState(root, sessionId);
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
  lines.push(`Stop-блоки: ${summary.stopBlocks.total} (${JSON.stringify(summary.stopBlocks.byNode)})`);
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
          stdout: `Неизвестная команда: ${command ?? '(нет)'}\nДоступно: start | goto | status | reset | report | check | coverage | selfcheck\n`,
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
