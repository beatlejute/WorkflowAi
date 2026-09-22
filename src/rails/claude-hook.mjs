/**
 * Rails — адаптер Claude Code hooks (спецификация §9.1).
 *
 * Читает JSON со stdin, решает через `core.decide()` / `output-check.mjs`,
 * пишет JSON-ответ хука в stdout. Код выхода процесса всегда 0 — хук никогда
 * не должен ронять сессию Claude Code (§7, последний абзац).
 *
 * `handleHookInput(input, env)` — чистая функция без побочных эффектов на
 * стандартные потоки (только чтение/запись файлов rails через `core.mjs` /
 * `state.mjs` / `journal.mjs`), чтобы тесты могли вызывать её напрямую с
 * синтетическим `input`/`env`, не поднимая настоящий процесс. `main()`
 * запускается только при прямом запуске файла (см. хвост модуля).
 */

import { fileURLToPath } from 'node:url';

import { findProjectRoot } from '../lib/find-root.mjs';
import { decide, loadSkillRuntime } from './core.mjs';
import { fromClaude } from './actions.mjs';
import { loadState, saveState } from './state.mjs';
import { realpathDeep } from './paths.mjs';
import { appendEvent } from './journal.mjs';
import { check as outputCheck, lastAssistantText } from './output-check.mjs';

// --- вспомогательные функции --------------------------------------------------

function truncate(s, max) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// §7.2: роль исполнителя — WORKFLOW_RAILS_ROLE из окружения, либо (для
// Claude) наличие agent_id/agent_type во входе хука (субагент). Поле
// намеренно НЕ задокументировано Claude Code официально — README §9.1
// отмечает его как «не проверенное», покрытое синтетическим тестом.
function resolveRole(input, env) {
  if (input && (input.agent_id || input.agent_type)) return 'executor';
  if (env && typeof env.WORKFLOW_RAILS_ROLE === 'string' && env.WORKFLOW_RAILS_ROLE) {
    return env.WORKFLOW_RAILS_ROLE;
  }
  return undefined;
}

function buildCtx(input, env, event) {
  return {
    cwd: (input && input.cwd) || process.cwd(),
    sessionId: input && input.session_id,
    role: resolveRole(input, env),
    event,
    run: (env && env.WORKFLOW_RAILS_RUN) || null,
    // Дедупликация в core: один и тот же вызов инструмента может прийти дважды,
    // если хуки rails зарегистрированы и у пользователя, и в проекте.
    toolUseId: (input && input.tool_use_id) || null,
  };
}

// --- PreToolUse -----------------------------------------------------------------

function handlePreToolUse(input, env) {
  const action = fromClaude(input);
  const ctx = buildCtx(input, env, 'PreToolUse');
  const result = decide({ action, ctx });

  if (result.decision === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.reason,
      },
    };
  }

  // Открытый вопрос: спецификация не даёт точную форму ответа для инъекции
  // --session (§9.1 таблица говорит только «updatedInput с изменённой
  // командой»). Простое детерминированное решение — тот же конверт
  // hookSpecificOutput, что и для deny, с permissionDecision: "allow" и
  // полем updatedInput, содержащим tool_input с заменённым command.
  if (result.updatedCommand && action.kind === 'shell') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...(input && input.tool_input ? input.tool_input : {}), command: result.updatedCommand },
      },
    };
  }

  return null;
}

// --- PostToolUse ------------------------------------------------------------------
//
// Blocker-находка ревью wp4: PostToolUse раньше повторно вызывал `decide()`
// для того же вызова инструмента, что для `stage_actions.max_per_session`
// означало двойную трату потолка на одно реальное действие (Pre тратит,
// Post тратит второй раз) и фантомные записи `denial` в журнале, когда Post
// натыкался на уже исчерпанный потолок. Правильно: Post не решает allow/deny
// заново (решение уже принято в Pre) — он только читает текущее состояние
// сессии и показывает узел, без единого побочного эффекта (без записи
// состояния, без журнала, без трат потолков).

function buildPostToolContext(input, env) {
  const role = resolveRole(input, env);
  if (role === 'executor') return null;

  const cwd = (input && input.cwd) || process.cwd();
  let root;
  try {
    root = findProjectRoot(cwd);
  } catch {
    return null;
  }

  const sessionId = input && input.session_id;
  if (!sessionId) return null;

  const state = loadState(root, sessionId);
  if (!state || !state.skill) return null;

  let graph;
  try {
    ({ graph } = loadSkillRuntime(root, state.skill));
  } catch {
    return null;
  }

  const label = graph.node(state.node)?.label ?? '';
  return `RAILS: числится ${state.node} «${truncate(label, 80)}»`;
}

function handlePostToolUse(input, env) {
  const context = buildPostToolContext(input, env);
  if (!context) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: context,
    },
  };
}

// --- Stop (§8: выходной слой для Claude) -------------------------------------------

function handleStop(input, env) {
  if (input && input.stop_hook_active) return null;

  const cwd = (input && input.cwd) || process.cwd();
  const sessionId = input && input.session_id;
  if (!sessionId) return null;

  let root;
  try {
    root = findProjectRoot(cwd);
  } catch {
    return null;
  }

  const state = loadState(root, sessionId);
  if (!state || !state.skill) return null;

  let config;
  try {
    ({ config } = loadSkillRuntime(root, state.skill));
  } catch {
    return null;
  }

  const text = lastAssistantText((input && input.transcript_path) || '');
  const result = outputCheck(text, config, state);
  if (result.ok) return null;

  const node = state.node;
  const key = `stop_blocks:${node}`;
  const maxStopBlocks = Number.isFinite(config?.output?.max_stop_blocks) ? config.output.max_stop_blocks : 2;
  const count = (state.counters && state.counters[key]) || 0;
  const exhausted = count >= maxStopBlocks;
  const run = (env && env.WORKFLOW_RAILS_RUN) || null;

  try {
    appendEvent(root, {
      type: 'stop_block',
      session: sessionId,
      skill: state.skill,
      node,
      run,
      missing: result.missing,
      exhausted,
    });
  } catch {
    // журнал не должен ронять хук
  }

  if (exhausted) {
    // §8: счётчик ≤ max_stop_blocks, дальше — allow с записью в журнал (уже сделана выше).
    return null;
  }

  state.counters ??= {};
  state.counters[key] = count + 1;
  state.updated = new Date().toISOString();
  try {
    saveState(root, state);
  } catch {
    // сохранение состояния не должно ронять хук
  }

  return {
    decision: 'block',
    reason: `Финальный ответ не соответствует rails.yaml.output: ${result.missing.join('; ')}`,
  };
}

// --- UserPromptSubmit ---------------------------------------------------------------

// §9.1: маркеры коррекции стейкхолдера. `^нет\b` — только в начале текста
// (иначе «нет проблем» ложно триггерит), остальные — где угодно в тексте.
//
// `\b` в JS-регулярках определён через ASCII `\w` — он не видит границу
// между кириллической буквой и не-словом (`нет,` не даёт границы после
// «т»), поэтому вместо `\b` — Unicode-осознанные (`\p{L}`, флаг `u`)
// отрицательные lookahead/lookbehind.
const CORRECTION_START_RE = /^\s*нет(?!\p{L})/iu;
const CORRECTION_ANYWHERE_RE = /(?<!\p{L})(?:не то|не туда|почему не)(?!\p{L})/iu;

function hasCorrectionMarker(prompt) {
  const t = String(prompt ?? '');
  return CORRECTION_START_RE.test(t) || CORRECTION_ANYWHERE_RE.test(t);
}

function handleUserPromptSubmit(input, env) {
  const prompt = (input && input.prompt) ?? '';
  if (!hasCorrectionMarker(prompt)) return null;

  const cwd = (input && input.cwd) || process.cwd();
  const sessionId = input && input.session_id;

  let root = null;
  try {
    root = findProjectRoot(cwd);
  } catch {
    root = null;
  }

  let node = null;
  let label = '';
  if (root && sessionId) {
    const state = loadState(root, sessionId);
    if (state && state.skill) {
      state.flags ??= {};
      state.flags.correction_pending = true;
      state.updated = new Date().toISOString();
      try {
        saveState(root, state);
      } catch {
        // сохранение состояния не должно ронять хук
      }
      node = state.node;
      try {
        const { graph } = loadSkillRuntime(root, state.skill);
        label = graph.node(node)?.label ?? '';
      } catch {
        // граф может быть недоступен — подсказка обойдётся без лейбла
      }
    }
  }

  const suffix = node ? ` узла ${node} «${truncate(label, 80)}»` : '';
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `RAILS: похоже на коррекцию курса — сверься с ГЛАВНЫМ ПРАВИЛОМ${suffix} прежде чем продолжать`,
    },
  };
}

// --- SessionStart ---------------------------------------------------------------------

function handleSessionStart(input) {
  const cwd = (input && input.cwd) || process.cwd();
  const sessionId = input && input.session_id;
  if (!sessionId) return null;

  const reply = (text) => ({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });

  let root;
  try {
    root = findProjectRoot(cwd);
  } catch {
    // Сессия из каталога-зонтика: корня по cwd нет. Агент обязан знать свой session_id,
    // чтобы стартовать скил из каталога проекта явно (session-memo.mjs подхватит корень).
    return reply(
      `RAILS: сессия ${sessionId}; корень проекта по cwd (${cwd}) не найден. Работа по скилу — из каталога проекта: ` +
      `node .workflow/src/rails/cli.mjs start <skill> --session ${sessionId}`
    );
  }

  const state = loadState(root, sessionId);
  if (!state || !state.skill) {
    return reply(`RAILS: сессия ${sessionId}, проект ${root}; скил не запущен — node .workflow/src/rails/cli.mjs start <skill> --session ${sessionId}`);
  }

  let label = '';
  try {
    const { graph } = loadSkillRuntime(root, state.skill);
    label = graph.node(state.node)?.label ?? '';
  } catch {
    // граф может быть недоступен — подсказка обойдётся без лейбла
  }

  return reply(`RAILS: сессия ${sessionId}; активен скил ${state.skill}, узел ${state.node} «${truncate(label, 80)}»`);
}

// --- точка входа для тестов и main() ---------------------------------------------------

/**
 * Обрабатывает один вход хука Claude Code и возвращает объект ответа, или
 * `null`, если хук ничего не хочет сказать (Claude Code трактует это как
 * пустой вывод — allow/без подсказки). Никогда не бросает исключений (§7).
 *
 * @param {object} input распарсенный JSON со stdin хука
 * @param {object} [env] окружение процесса (по умолчанию не читается напрямую —
 *   тесты передают синтетический объект вместо process.env)
 * @returns {object|null}
 */
export function handleHookInput(input, env = {}) {
  try {
    const event = input && input.hook_event_name;
    switch (event) {
      case 'PreToolUse':
        return handlePreToolUse(input, env);
      case 'PostToolUse':
        return handlePostToolUse(input, env);
      case 'Stop':
        return handleStop(input, env);
      case 'UserPromptSubmit':
        return handleUserPromptSubmit(input, env);
      case 'SessionStart':
        return handleSessionStart(input, env);
      default:
        return null;
    }
  } catch (err) {
    try {
      process.stderr.write(
        `rails: claude-hook упал на событии, снимаю рельсы: ${err && err.stack ? err.stack : err}\n`
      );
    } catch {
      // stderr недоступен — не наша забота
    }
    // §7, последний абзац: «любое исключение → allow + строка в stderr + запись
    // error в журнал». `decide()` журналирует свои исключения сама, но эта ветка
    // ловит падения ВНЕ `decide()` (Stop/UserPromptSubmit/SessionStart: чтение
    // состояния/графа, transcript, saveState) — их надо записать здесь же (minor-
    // находка ревью wp4).
    try {
      const cwd = (input && input.cwd) || process.cwd();
      const root = findProjectRoot(cwd);
      // Не перечитываем `input.hook_event_name` здесь: сам этот доступ мог
      // быть причиной исключения (например, поле-геттер, бросающее при
      // чтении) — повторное чтение в catch тихо проваливается во внутренний
      // catch ниже и запись в журнал вообще не происходит.
      appendEvent(root, {
        type: 'error',
        session: (input && input.session_id) ?? null,
        message: String(err && err.message ? err.message : err),
      });
    } catch {
      // нет корня проекта, или журнал недоступен — не наша забота
    }
    return null;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', () => resolve(data));
    } catch {
      resolve('');
    }
  });
}

/**
 * Точка входа при прямом запуске файла как процесса хука: stdin JSON →
 * `handleHookInput` → stdout JSON (или пустой вывод). Код выхода — всегда 0.
 */
export async function main() {
  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    raw = '';
  }

  let input = null;
  try {
    input = raw ? JSON.parse(raw) : null;
  } catch {
    input = null;
  }

  const output = handleHookInput(input, process.env);
  if (output) {
    try {
      process.stdout.write(JSON.stringify(output));
    } catch {
      // stdout недоступен — хук всё равно обязан завершиться кодом 0
    }
  }
  process.exitCode = 0;
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
