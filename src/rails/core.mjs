/**
 * Rails — ядро принуждения (спецификация §7: `core.decide`).
 *
 * `decide({ action, ctx })` — единственная точка входа: получает нормализованное
 * действие (`actions.mjs`: `{ tool, kind, command?, path?, server?, mcpTool? }`)
 * и контекст вызова (`{ cwd, sessionId, role, event, run? }`), решает
 * `allow` / `deny`. Модуль не имеет побочных эффектов при импорте — весь ввод-вывод
 * (чтение состояния/конфига/графа, запись состояния и журнала) происходит только
 * внутри `decide()`.
 *
 * Хук никогда не падает (§7, последний абзац): `decide()` сама себя оборачивает
 * в try/catch и на любое исключение отвечает `{ decision: "allow" }`, строкой в
 * stderr и (если корень проекта уже известен) записью `type: "error"` в журнал.
 */

import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePathAbs } from 'node:path';

import { findProjectRoot } from '../lib/find-root.mjs';
import { rememberSessionRoot, recallSessionRoot } from './session-memo.mjs';
import { loadRailsConfig } from './rails-config.mjs';
import { loadSkillGraph } from './graph.mjs';
import {
  loadState,
  saveState,
  startState,
  currentNodeInfo,
  checkActionLimit,
  allowedTransitions,
} from './state.mjs';
import { appendDenial, appendEvent } from './journal.mjs';
import { realpathDeep, isInside, matchesGlob } from './paths.mjs';
import { detectShellWrites } from './actions.mjs';

// --- cli.mjs: узнаём вызов служебной команды (§7.4.1) -----------------------

// Регулярка якорится на `rails/cli.mjs` (`rails\cli.mjs` на Windows), а не на
// любой `cli.mjs` — в репозитории есть свой `src/cli.mjs`, который не имеет
// отношения к рельсам и не должен получать инъекцию `--session`.
const CLI_SUBCOMMANDS = ['start', 'goto', 'status', 'reset', 'report', 'check', 'coverage', 'selfcheck'];
const CLI_COMMAND_RE = new RegExp(`(?:^|[\\\\/])rails[\\\\/]cli\\.mjs["']?\\s+(${CLI_SUBCOMMANDS.join('|')})\\b`);
const SESSION_FLAG_RE = /--session\b/;

// «Команда — вызов cli.mjs» (§7.4.1) — это ВСЯ команда целиком, не подстрока
// внутри составной команды: иначе `cli.mjs status && git commit` проходит
// коротким замыканием мимо deny_shell (запрещённая команда стоит в тексте
// открытым текстом — не косвенность, которую §14 оговаривает как границу), а
// инъекция `--session` в `cli.mjs status | tail -5` уезжает в конец пайпа и
// ломает `tail`. Простое детерминированное решение: если в команде есть
// операторы, соединяющие несколько командных сегментов (`;`, `&`, `|`, перевод
// строки) вне кавычек — это уже не «просто cli.mjs», короткое замыкание не
// применяется, команда идёт по общим правилам (canary/deny_shell/…).
function hasShellSeparatorsOutsideQuotes(command) {
  const s = String(command ?? '');
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // `2>&1`, `>&2`, `&>file` — редиректы, не разделители команд (прогоны 2026-09-22:
    // цепочка `cli.mjs goto … 2>&1 && cli.mjs goto …` отклонялась как не-cli).
    if (ch === '&' && (s[i - 1] === '>' || s[i + 1] === '>')) continue;
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      return true;
    }
  }
  return false;
}

// Разбивает команду на сегменты по `&&`, `;` и переводу строки вне кавычек
// (одиночные `|`/`&` остаются внутри сегмента).
function splitTopLevelSegments(command) {
  const s = String(command ?? '');
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\n' || ch === ';' || (ch === '&' && s[i + 1] === '&') || (ch === '|' && s[i + 1] === '|')) {
      segments.push(current);
      current = '';
      if (ch === '&' || ch === '|') i += 1;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((x) => x.trim()).filter((x) => x.length > 0);
}

const CD_PREFIX_RE = /^cd\s+("[^"]*"|'[^']*'|\S+)$/;

// Команда — вызов cli.mjs (§7.4.1): один или несколько сегментов, КАЖДЫЙ из которых —
// вызов rails/cli.mjs (пайп вида `| head` внутри сегмента допустим), с необязательным
// первым сегментом `cd <dir>`. Прогоны 2026-09-22: раннер и агенты префиксуют
// `cd "<workdir>" &&`, а цитата P0R4 содержит «git commit» — без этого разбора вызов
// cli.mjs уходил в deny_shell и отклонялся по тексту цитаты. `cli.mjs status && git commit`
// сюда не попадает: второй сегмент не cli.mjs.
function isCliCommand(command) {
  if (typeof command !== 'string') return false;
  const segments = splitTopLevelSegments(command);
  if (segments.length === 0) return false;
  if (segments.length > 1 && CD_PREFIX_RE.test(segments[0])) segments.shift();
  return segments.every((seg) => CLI_COMMAND_RE.test(seg) && !hasShellSeparatorsOutsideQuotes(seg.replace(/\|[^|]*$/g, '')));
}

// Инъекция `--session` в каждый cli-сегмент без него — перед первым `|` вне кавычек
// (иначе флаг уезжает в хвост пайпа и ломает `head`/`tail`).
function injectSession(command, sessionId) {
  const segments = splitTopLevelSegments(command);
  const out = [];
  for (const seg of segments) {
    if (!CLI_COMMAND_RE.test(seg) || SESSION_FLAG_RE.test(seg)) {
      out.push(seg);
      continue;
    }
    let quote = null;
    let cut = -1;
    for (let i = 0; i < seg.length; i += 1) {
      const ch = seg[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '|') {
        cut = i;
        break;
      }
    }
    out.push(cut === -1 ? `${seg} --session ${sessionId}` : `${seg.slice(0, cut).trimEnd()} --session ${sessionId} ${seg.slice(cut)}`);
  }
  return out.join(' && ');
}

// --- loadSkillRuntime: кэш графа/конфига по mtime (§7.4, "хук никогда не падает" не
// применяется здесь — ошибки чтения/парсинга сознательно не глотаются, их ловит
// внешний try/catch в decide()) ------------------------------------------------

// Открытый вопрос: спецификация не уточняет, mtime каких именно файлов участвует
// в инвалидации кэша графа. Реализовано простое детерминированное решение —
// отслеживаются `rails.yaml` и `SKILL.md` (два файла, определяющихконфиг и вход
// графа). Правка ТОЛЬКО файла-фрагмента (`workflows/*.md`) без изменения этих
// двух в течение жизни процесса кэш не инвалидирует — на практике одно
// hook-обращение живёт один процесс, так что для реального использования это не
// имеет значения; риск есть только внутри процесса, который вызывает `decide()`
// многократно (тесты, `cli.mjs`).
const RUNTIME_CACHE = new Map();

function mtimeOf(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Конфиг и граф скила, с кэшем по mtime `rails.yaml`/`SKILL.md` в памяти
 * процесса (§1 «модули без побочных эффектов при импорте» — кэш лежит здесь,
 * а не на уровне модуля, потому что первый вызов происходит только из
 * `decide()`).
 *
 * @param {string} root
 * @param {string} skill
 * @returns {{config: object, graph: import('./graph.mjs').Graph}}
 */
export function loadSkillRuntime(root, skill) {
  const skillDir = join(root, '.workflow', 'src', 'skills', skill);
  const configMtime = mtimeOf(join(skillDir, 'rails.yaml'));
  const skillMdMtime = mtimeOf(join(skillDir, 'SKILL.md'));

  const cached = RUNTIME_CACHE.get(skillDir);
  if (cached && cached.configMtime === configMtime && cached.skillMdMtime === skillMdMtime) {
    return { config: cached.config, graph: cached.graph };
  }

  const config = loadRailsConfig(skillDir);
  const graph = loadSkillGraph(skillDir, config);
  RUNTIME_CACHE.set(skillDir, { configMtime, skillMdMtime, config, graph });
  return { config, graph };
}

// --- текст отказа из трёх частей (§7.5) --------------------------------------

/**
 * Собирает текст отказа из трёх частей: что отклонено, почему, что доступно
 * взамен (§7.5).
 *
 * @param {{what: string, why: string, allowed: string}} parts
 * @returns {string}
 */
export function buildDenyReason({ what, why, allowed } = {}) {
  const whatText = what ?? '';
  const whyText = why ?? '';
  const allowedText = Array.isArray(allowed) ? allowed.join('; ') : (allowed ?? '');
  return `Отклонено: ${whatText}\nПочему: ${whyText}\nДоступно: ${allowedText}`;
}

// --- вспомогательные функции ---------------------------------------------------

function truncate(s, max) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function resolveMaybeRelative(p, cwd) {
  if (typeof p !== 'string' || p.length === 0) return p;
  return isAbsolute(p) ? p : resolvePathAbs(cwd || process.cwd(), p);
}

function safeRealpath(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  try {
    return realpathDeep(p);
  } catch {
    return null;
  }
}

// Цели записи действия: одна для edit/write (по `action.path`), несколько для
// shell (по `detectShellWrites`, §6). Маркер `"?"` (путь не удалось извлечь) —
// отдельный элемент `{ marker: true }`, без realpath (его негде взять).
function collectWriteTargets(action, ctx) {
  if (!action) return [];
  if (action.kind === 'edit' || action.kind === 'write') {
    if (!action.path) return [];
    const real = safeRealpath(resolveMaybeRelative(action.path, ctx?.cwd));
    if (real === null) return [{ marker: true, display: action.path }];
    return [{ real, display: action.path }];
  }
  if (action.kind === 'shell') {
    const writes = detectShellWrites(action.command);
    return writes.map((w) => {
      if (w === '?') return { marker: true, display: '?' };
      const real = safeRealpath(resolveMaybeRelative(w, ctx?.cwd));
      if (real === null) return { marker: true, display: w };
      return { real, display: w };
    });
  }
  return [];
}

function describeWhat(action) {
  const tool = action?.tool ?? '(неизвестный инструмент)';
  if (action?.kind === 'shell') return `${tool}: ${action.command ?? ''}`;
  if (action?.kind === 'edit' || action?.kind === 'write') return `${tool}: ${action.path ?? ''}`;
  if (action?.kind === 'mcp') return `${tool} (mcp ${action.server ?? '?'}/${action.mcpTool ?? '?'})`;
  return `${tool}`;
}

// «Что доступно» (§7.5): допустимые переходы из текущего узла + действия
// текущего этапа (stage_actions, чей rule.stages включает текущий этап). На
// E-узле сами действия этапа ещё запрещены (E-прозрачность, §5) — перечислять
// их как «доступные» противоречило бы причине отказа, поэтому на E-узле эта
// часть подсказки либо опускается, либо помечается «после перехода».
function describeAllowed(state, graph, config) {
  const info = currentNodeInfo(state);
  const transitions = allowedTransitions(state, graph).map((t) => `${t.id}: ${t.label}`);

  const parts = [];
  if (transitions.length > 0) parts.push(`переходы: ${transitions.join('; ')}`);
  if (!info.isEntry) {
    const actions = Object.entries(config?.stage_actions || {})
      .filter(([, rule]) => Array.isArray(rule.stages) && rule.stages.includes(info.stage))
      .map(([name]) => name);
    if (actions.length > 0) parts.push(`действия этапа: ${actions.join(', ')}`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'переходов и действий этапа нет';
}

// Лейбл текущего узла для «почему» (§7.5: «цитата лейбла узла или правило
// rails.yaml с incident») — используется там, где отказ вызван самим узлом
// (этап/E-прозрачность), а не отдельным правилом rails.yaml с incident.
function currentNodeLabel(state, graph) {
  const node = graph?.node(state?.node);
  return node ? truncate(node.label, 80) : '';
}

function sameCanary(command, canary) {
  return String(command ?? '').trim() === String(canary ?? '').trim();
}

function matchesDenyShell(command, rule) {
  if (!rule || typeof rule.pattern !== 'string') return false;
  let re;
  try {
    re = new RegExp(rule.pattern);
  } catch {
    return false;
  }
  return re.test(String(command ?? ''));
}

// Правило `stage_actions` применимо к действию: kind совпадает, match —
// регулярка по тексту команды (shell) или glob по realpath (edit/write); §4/§6.
// Для read/agent/mcp/other форма `match` спецификацией не описана (примеры §4
// только для shell/edit/write) — открытый вопрос, детерминированное решение:
// правило для таких kind никогда не матчится (нет данных для сравнения, а
// значит нет права ни разрешать, ни запрещать по догадке).
function ruleMatches(action, rule, root, editRealPath) {
  if (!Array.isArray(rule?.kind) || !rule.kind.includes(action?.kind)) return false;
  if (typeof rule.match !== 'string') return false;
  if (action.kind === 'shell') {
    let re;
    try {
      re = new RegExp(rule.match);
    } catch {
      return false;
    }
    return re.test(action.command ?? '');
  }
  if (action.kind === 'edit' || action.kind === 'write') {
    if (!editRealPath) return false;
    return matchesGlob(editRealPath, rule.match, root);
  }
  return false;
}

// --- G0: режим без скила (§7.3) ------------------------------------------------

function decideNoSkillMode(root, action, ctx) {
  if (action?.kind === 'edit' || action?.kind === 'write') {
    const real = action.path ? safeRealpath(resolveMaybeRelative(action.path, ctx?.cwd)) : null;
    const skillsDir = join(root, '.workflow', 'src', 'skills');
    if (real && isInside(real, skillsDir)) {
      const reason = 'правки скилов только через коуча на рельсах: `node .workflow/src/rails/cli.mjs start coach`';
      try {
        appendDenial(root, {
          session: ctx?.sessionId ?? null,
          skill: null,
          node: null,
          run: ctx?.run ?? null,
          reason,
          tool: action.tool,
          path: action.path,
        });
      } catch {
        // журнал не должен ронять decide()
      }
      return { decision: 'deny', reason };
    }
  }
  return { decision: 'allow' };
}

// --- запись отказа: журнал + счётчик denials[node] (§7.5) -------------------

function denyAndLog({ root, ctx, state, action, what, why, allowedText }) {
  const node = state?.node ?? null;
  let count = null;
  if (node) {
    state.denials ??= {};
    count = (state.denials[node] || 0) + 1;
    state.denials[node] = count;
    state.updated = new Date().toISOString();
  }
  const fullWhy = node ? `${why}; по ${node} это ${count}-й отказ за сессию` : why;
  const reason = buildDenyReason({ what, why: fullWhy, allowed: allowedText });

  try {
    appendDenial(root, {
      session: ctx?.sessionId ?? null,
      skill: state?.skill ?? null,
      node,
      run: ctx?.run ?? null,
      reason,
      tool: action?.tool,
      path: action?.path,
      command: action?.command,
    });
  } catch {
    // журнал не должен ронять decide()
  }
  try {
    if (state) saveState(root, state);
  } catch {
    // сохранение состояния не должно ронять decide()
  }
  return { decision: 'deny', reason };
}

// --- режим скила (§7.4) --------------------------------------------------------

function decideSkillMode({ root, action, ctx, state, config, graph }) {
  // 1. cli.mjs — служебная команда: allow, при отсутствии --session — инъекция.
  if (action?.kind === 'shell' && isCliCommand(action.command)) {
    const result = { decision: 'allow' };
    if (ctx?.sessionId) {
      const injected = injectSession(action.command, ctx.sessionId);
      if (injected !== action.command) result.updatedCommand = injected;
    }
    return result;
  }

  const deny = (what, why) =>
    denyAndLog({ root, ctx, state, action, what, why, allowedText: describeAllowed(state, graph, config) });

  // 2. Канарейка.
  if (action?.kind === 'shell' && config.canary && sameCanary(action.command, config.canary)) {
    return deny(describeWhat(action), `RAILS_CANARY: рельсы активны, узел ${state.node}`);
  }

  // 3. deny_shell.
  if (action?.kind === 'shell' && Array.isArray(config.deny_shell)) {
    for (const rule of config.deny_shell) {
      if (matchesDenyShell(action.command, rule)) {
        const why = rule.incident ? `${rule.reason ?? 'запрещённая команда'} (${rule.incident})` : (rule.reason ?? 'запрещённая команда');
        return deny(describeWhat(action), why);
      }
    }
  }

  // 4. deny_mcp.
  if (action?.kind === 'mcp' && Array.isArray(config.deny_mcp) && config.deny_mcp.includes(action.mcpTool)) {
    return deny(describeWhat(action), `MCP-инструмент «${action.mcpTool}» запрещён правилом deny_mcp`);
  }

  const targets = collectWriteTargets(action, ctx);

  // 5. write_deny.
  if (Array.isArray(config.write_deny) && config.write_deny.length > 0) {
    for (const t of targets) {
      if (t.marker) continue; // маркер "?" разбирается на шаге 6, не здесь.
      for (const pattern of config.write_deny) {
        if (matchesGlob(t.real, pattern, root)) {
          return deny(describeWhat(action), `путь «${t.display}» запрещён явным правилом write_deny`);
        }
      }
    }
  }

  // 6. write_scope (+ allow_temp).
  for (const t of targets) {
    if (t.marker) {
      return deny(
        describeWhat(action),
        'команда похожа на запись, но путь не удалось определить — используй Edit/Write или укажи путь явно'
      );
    }
    const inScope = (config.write_scope || []).some((pattern) => matchesGlob(t.real, pattern, root));
    // followLinks: false — ссылки внутри os.tmpdir() не нужны, а обход %TEMP% стоил до 9 с (2026-09-22).
    // Внутри корня проекта allow_temp не действует: изолированные workdir тестов живут в %TEMP%,
    // и без этого исключения вся песочница (тикеты, планы) становилась бы записываемой.
    const inTemp = Boolean(config.allow_temp)
      && isInside(t.real, tmpdir(), { followLinks: false })
      && !isInside(t.real, root, { followLinks: false });
    if (!inScope && !inTemp) {
      return deny(describeWhat(action), `путь «${t.display}» вне write_scope`);
    }
  }

  // 7. stage_actions.
  const editRealPath = (action?.kind === 'edit' || action?.kind === 'write') && targets[0] && !targets[0].marker
    ? targets[0].real
    : null;
  const info = currentNodeInfo(state);

  // Два прохода: сначала проверяем ВСЕ совпавшие правила (этап/E-прозрачность/
  // потолок) без побочных эффектов, и только если ни одно не отказало —
  // тратим потолки (checkActionLimit). Иначе правило A (совпало и прошло)
  // успевает инкрементировать и сохранить свой счётчик, хотя итоговое решение —
  // deny от следующего правила B: отклонённое действие «съедает» потолок.
  const nodeLabel = currentNodeLabel(state, graph);
  const matchedRuleNames = [];
  for (const [name, rule] of Object.entries(config.stage_actions || {})) {
    if (!ruleMatches(action, rule, root, editRealPath)) continue;

    if (!Array.isArray(rule.stages) || !rule.stages.includes(info.stage)) {
      return deny(
        describeWhat(action),
        `действие «${name}» разрешено только на этапах ${JSON.stringify(rule.stages ?? [])}, текущий этап ${info.stage} (узел ${state.node} «${nodeLabel}»)`
      );
    }
    if (info.isEntry) {
      return deny(
        describeWhat(action),
        `узел ${state.node} — вход этапа «${nodeLabel}»; сначала перейди в правило/шаг/гейт этапа (goto), действия этапа с входа запрещены`
      );
    }
    const key = `action:${name}`;
    const count = (state.counters && state.counters[key]) || 0;
    if (typeof rule.max_per_session === 'number' && count >= rule.max_per_session) {
      return deny(
        describeWhat(action),
        `потолок действия «${name}»: ${rule.max_per_session} за сессию исчерпан — выход к человеку`
      );
    }
    matchedRuleNames.push(name);
  }
  for (const name of matchedRuleNames) {
    checkActionLimit(state, name, config.stage_actions[name].max_per_session);
  }

  // 8. allow.
  try {
    saveState(root, state); // могли измениться counters (checkActionLimit) или это только что созданное состояние.
  } catch {
    // сохранение состояния не должно ронять decide()
  }
  const node = state.node;
  const label = graph.node(node)?.label ?? '';
  return { decision: 'allow', context: `RAILS: числится ${node} «${truncate(label, 80)}»` };
}

// Корень проекта от пути цели: ближайший предок с `.workflow/src/skills`, а не любой
// `.workflow/` (в каноне встречался бродячий `src/.workflow/logs`, из-за которого
// findProjectRoot принимал `src/` за проект). Глубина подъёма — как у find-root.
function projectRootFromPath(absPath) {
  let current = dirname(absPath);
  for (let i = 0; i < 20; i += 1) {
    if (existsSync(join(current, '.workflow', 'src', 'skills'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// --- decide: точка входа (§7) ---------------------------------------------------

function decideInProject(root, action, ctx) {
  const role = ctx?.role ?? process.env.WORKFLOW_RAILS_ROLE;
  if (role === 'executor') return { decision: 'allow' };

  const sessionId = ctx?.sessionId;
  let state = sessionId ? loadState(root, sessionId) : null;

  if (!state) {
    const skillEnv = process.env.WORKFLOW_RAILS_SKILL;
    if (!skillEnv) {
      return decideNoSkillMode(root, action, ctx);
    }
    if (!sessionId) {
      // Открытый вопрос спецификации: §5 отдаёт создание состояния при
      // WORKFLOW_RAILS_SKILL на откуп «первому действию», не уточняя случай
      // «адаптер не передал sessionId». Без sessionId состояние ни создать,
      // ни загрузить (state.mjs требует непустой sessionId) — если это не
      // перехватить явно, `startState` бросает исключение, его ловит внешний
      // catch в `decide()` и результат неотличим от обычной ошибки хука
      // (`type: "error"` в журнале), хотя по сути это «рельсы сейчас никого
      // не ведут» — другой класс события. Простое детерминированное решение:
      // явно предупредить в stderr и вести себя как G0 (единственный гард —
      // правки `.workflow/src/skills/**`), не как ошибка.
      try {
        process.stderr.write(
          'rails: WORKFLOW_RAILS_SKILL задан, но ctx.sessionId отсутствует — состояние сессии недоступно, включён режим G0\n'
        );
      } catch {
        // stderr недоступен — не наша забота.
      }
      return decideNoSkillMode(root, action, ctx);
    }
    // §5: «если состояния нет, но задан WORKFLOW_RAILS_SKILL... хук создаёт
    // состояние сам при первом действии».
    const { config } = loadSkillRuntime(root, skillEnv);
    state = startState({ root, sessionId, skill: skillEnv, entry: config.entry, run: ctx?.run ?? null });
  }

  const { config, graph } = loadSkillRuntime(root, state.skill);

  // Дедупликация по идентификатору вызова инструмента (Claude tool_use_id, Kilo callID):
  // хуки могут быть зарегистрированы и у пользователя, и в проекте — один вызов
  // приходит дважды, а счётчики (denials, max_per_session, cycle) должны расти один раз.
  const dedupeKey = ctx?.toolUseId ? `${ctx.event || 'PreToolUse'}:${ctx.toolUseId}` : null;
  if (dedupeKey && state.dedupe && state.dedupe[dedupeKey]) {
    return { ...state.dedupe[dedupeKey], deduped: true };
  }
  const result = decideSkillMode({ root, action, ctx, state, config, graph });
  if (dedupeKey) {
    try {
      const fresh = loadState(root, state.session || ctx?.sessionId) || state;
      fresh.dedupe ??= {};
      const keys = Object.keys(fresh.dedupe);
      for (const k of keys.slice(0, Math.max(0, keys.length - 7))) delete fresh.dedupe[k];
      fresh.dedupe[dedupeKey] = { decision: result.decision, reason: result.reason, context: result.context, updatedCommand: result.updatedCommand };
      saveState(root, fresh);
    } catch {
      // дедупликация — удобство, не гард: её сбой не должен ронять decide()
    }
  }
  return result;
}

/**
 * Единая логика решений (§7). Никогда не бросает исключений — любая ошибка
 * (включая «нет корня проекта», что не ошибка, а штатный silent-allow) в
 * худшем случае превращается в `{ decision: "allow" }` плюс строка в stderr и
 * запись `type: "error"` в журнал (если корень проекта уже был найден).
 *
 * @param {{action: object, ctx: {cwd: string, sessionId?: string, role?: string, event?: string, run?: string|null}}} args
 * @returns {{decision: 'allow'|'deny', reason?: string, context?: string, updatedCommand?: string}}
 */
export function decide({ action, ctx } = {}) {
  let root;
  try {
    root = findProjectRoot(ctx?.cwd);
  } catch {
    // §7.1: нет корня проекта по cwd. Сессия могла стартовать из каталога-зонтика
    // (D:\Dev) над проектами — тогда корень берётся от пути цели edit/write
    // (регистрация хука на уровне зонтика, 2026-09-22). Нет и его — allow без текста.
    root = null;
    if ((action?.kind === 'edit' || action?.kind === 'write') && typeof action.path === 'string' && action.path) {
      root = projectRootFromPath(resolveMaybeRelative(action.path, ctx?.cwd));
      if (root) rememberSessionRoot(ctx?.sessionId, root);
    }
    // Команда без пути (shell, mcp, read): корень — из памяти «сессия → корень»,
    // заполненной `rails start --session` из каталога проекта или прошлым edit/write.
    if (!root) root = recallSessionRoot(ctx?.sessionId);
    if (!root) return { decision: 'allow' };
  }

  try {
    return decideInProject(root, action, ctx);
  } catch (err) {
    try {
      process.stderr.write(`rails: decide() поймала исключение, снимаю рельсы: ${err && err.stack ? err.stack : err}\n`);
    } catch {
      // stderr недоступен — не наша забота, decide() всё равно не должна падать.
    }
    try {
      appendEvent(root, {
        type: 'error',
        session: ctx?.sessionId ?? null,
        message: String(err && err.message ? err.message : err),
      });
    } catch {
      // журнал недоступен — тоже не должен ронять decide().
    }
    return { decision: 'allow' };
  }
}
