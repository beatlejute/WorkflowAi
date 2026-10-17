/**
 * Rails — адаптер расширения pi (спецификация §9.2, нативные хуки pi).
 *
 * Расширение pi — модуль с фабрикой по умолчанию: `export default function (pi)
 * { pi.on('tool_call', …) }`. Каталоги загрузки — `<каталог агента>/extensions`
 * (по умолчанию `~/.pi/agent/extensions`) и проектный `.pi/extensions`; проектный
 * берётся только в доверенном проекте, а неинтерактивный запуск доверие
 * подтвердить не может, поэтому канон ставится на пользовательском уровне.
 * Каталог агента переопределяется переменной `PI_CODING_AGENT_DIR`.
 *
 * `tool_call` — до выполнения инструмента: решение принимает общее ядро
 * (`decide`), отказ возвращается как `{ block: true, reason }` — текст отказа
 * доходит до модели, а внедрённая команда правит `event.input`. `tool_result` —
 * после выполнения: только подсказка про текущий узел, без повторного решения
 * (второй `decide` списал бы то же действие из потолка дважды).
 *
 * Расширение живёт в процессе pi и грузится для любого проекта, поэтому вне
 * проекта с `.workflow/` оно молчит: корень ищется от рабочего каталога сессии.
 *
 * `createPiHooks(env)` — синхронная фабрика обработчиков, вынесенная отдельно
 * от фабрики расширения, чтобы тесты звали их с синтетическим окружением и без
 * реального `process.env`.
 */

import { findProjectRoot } from '../lib/find-root.mjs';
import { decide, loadSkillRuntime } from './core.mjs';
import { fromPi } from './actions.mjs';
import { loadState, readCompletedMarker } from './state.mjs';

function truncate(s, max) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Контекст рельс для ядра: рабочий каталог вызова, сессия pi, роль и запуск из окружения. */
function buildCtx(cwd, sessionId, eventName, event, env) {
  return {
    cwd,
    sessionId,
    role: env && typeof env.WORKFLOW_RAILS_ROLE === 'string' ? env.WORKFLOW_RAILS_ROLE : undefined,
    event: eventName,
    run: (env && env.WORKFLOW_RAILS_RUN) || null,
    toolUseId: (event && event.toolCallId) || null,
  };
}

/** Рабочий каталог вызова: cwd из контекста pi, иначе каталог процесса. */
function callCwd(ctx) {
  return (ctx && ctx.cwd) || process.cwd();
}

/** Идентификатор сессии pi; менеджер сессий без него — undefined. */
function sessionIdOf(ctx) {
  try {
    return (ctx && ctx.sessionManager && ctx.sessionManager.getSessionId && ctx.sessionManager.getSessionId()) || undefined;
  } catch {
    return undefined;
  }
}

/** Корень проекта и идентификатор сессии pi; вне проекта — null (расширение молчит). */
function railContext(ctx) {
  const cwd = callCwd(ctx);
  let root;
  try {
    root = findProjectRoot(cwd);
  } catch {
    return null;
  }
  return { root, sessionId: sessionIdOf(ctx), cwd };
}

/**
 * Обработчики событий pi.
 *
 * @param {object} [env] окружение (по умолчанию не читается напрямую — тесты
 *   передают синтетический объект вместо process.env)
 * @returns {{ "tool_call": Function, "tool_result": Function }}
 */
export function createPiHooks(env = {}) {
  return {
    tool_call: async (event, ctx) => {
      // Решение принимается всегда: корень проекта ядро ищет по cwd само и вне проекта
      // молчит, а песочница тестов (WORKFLOW_SANDBOX_ROOT) проверяется до поиска корня
      // и от наличия .workflow/ не зависит.
      const action = fromPi(event);
      const result = decide({ action, ctx: buildCtx(callCwd(ctx), sessionIdOf(ctx), 'tool_call', event, env) });

      if (result.decision === 'deny') {
        return { block: true, reason: result.reason };
      }
      if (result.updatedCommand && event && event.input && typeof event.input.command === 'string') {
        event.input.command = result.updatedCommand;
      }
      return undefined;
    },

    tool_result: async (event, ctx) => {
      try {
        const role = env && typeof env.WORKFLOW_RAILS_ROLE === 'string' ? env.WORKFLOW_RAILS_ROLE : undefined;
        if (role === 'executor') return undefined;

        const where = railContext(ctx);
        if (!where || !where.sessionId) return undefined;

        const state = loadState(where.root, where.sessionId);
        if (!state || !state.skill || readCompletedMarker(where.root, where.sessionId)) return undefined;

        let graph;
        try {
          ({ graph } = loadSkillRuntime(where.root, state.skill, state));
        } catch {
          return undefined;
        }

        const context = `RAILS: числится ${state.node} «${truncate(graph.node(state.node)?.label ?? '', 80)}»`;
        if (Array.isArray(event && event.content)) {
          return { content: [...event.content, { type: 'text', text: context }] };
        }
        return undefined;
      } catch {
        // Подсказка не роняет вызов инструмента: защиту держит tool_call (decide fail-closed).
        return undefined;
      }
    },
  };
}

/**
 * Фабрика расширения pi (то, что ждёт `pi.on`).
 *
 * @param {{on: Function}} pi
 */
export default function workflowRails(pi) {
  const hooks = createPiHooks(process.env);
  pi.on('tool_call', (event, ctx) => hooks.tool_call(event, ctx));
  pi.on('tool_result', (event, ctx) => hooks.tool_result(event, ctx));
}
