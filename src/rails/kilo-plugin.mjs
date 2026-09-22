/**
 * Rails — адаптер Kilo/opencode plugin (спецификация §9.2).
 *
 * Загружается Kilo из `<root>/.kilo/plugin/*.js` (в проекте — тонкий
 * загрузчик `workflow-rails.js`, реэкспортирующий `WorkflowRails` отсюда).
 * `input = { tool, sessionID, callID }`, `output.args` — аргументы вызова
 * инструмента. `tool.execute.before` отклоняет вызов через `throw` (текст
 * ошибки доходит до модели); `tool.execute.after` дописывает в
 * `output.output`. Инъекция `--session` — мутация `output.args.command`.
 *
 * `createHooks(directory, env)` — синхронная фабрика хуков, вынесенная
 * отдельно от `WorkflowRails`, чтобы тесты могли получить объект хуков без
 * `await` и без реального `process.env` (передают синтетический `env`).
 * `WorkflowRails` — сам интерфейс, которого ждёт Kilo (async-фабрика).
 */

import { findProjectRoot } from '../lib/find-root.mjs';
import { decide, loadSkillRuntime } from './core.mjs';
import { fromKilo } from './actions.mjs';
import { loadState } from './state.mjs';

function truncate(s, max) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Хуки `tool.execute.before` / `tool.execute.after` для каталога проекта
 * `directory`. Модуль не имеет побочных эффектов при импорте — вся работа
 * (чтение состояния/конфига/графа, запись состояния и журнала) происходит
 * только внутри самих хуков, при вызове Kilo.
 *
 * @param {string} directory корень проекта (Kilo передаёт его в `WorkflowRails`)
 * @param {object} [env] окружение (по умолчанию не читается напрямую — тесты
 *   передают синтетический объект вместо process.env)
 * @returns {{ "tool.execute.before": Function, "tool.execute.after": Function }}
 */
export function createHooks(directory, env = {}) {
  function buildCtx(input, event) {
    return {
      cwd: directory,
      sessionId: input && input.sessionID,
      role: env && typeof env.WORKFLOW_RAILS_ROLE === 'string' ? env.WORKFLOW_RAILS_ROLE : undefined,
      event,
      run: (env && env.WORKFLOW_RAILS_RUN) || null,
      toolUseId: (input && input.callID) || null,
    };
  }

  return {
    'tool.execute.before': async (input, output) => {
      const action = fromKilo(input, output);
      const ctx = buildCtx(input, 'tool.execute.before');
      const result = decide({ action, ctx });

      if (result.decision === 'deny') {
        // §9.2: throw в before отклоняет вызов, текст ошибки доходит до модели.
        throw new Error(result.reason);
      }

      if (result.updatedCommand && output && output.args) {
        output.args.command = result.updatedCommand;
      }
    },

    // Blocker-находка ревью wp4: `after` раньше тоже вызывал `decide()` для
    // того же вызова инструмента, что для `stage_actions.max_per_session`
    // означало двойную трату потолка на одно реальное действие (before
    // тратит, after тратит второй раз) и фантомные записи `denial` в
    // журнале, когда after натыкался на уже исчерпанный потолок. Решение
    // уже принято в `before` — `after` только читает текущее состояние
    // сессии и показывает узел, без единого побочного эффекта.
    'tool.execute.after': async (input, output) => {
      const role = env && typeof env.WORKFLOW_RAILS_ROLE === 'string' ? env.WORKFLOW_RAILS_ROLE : undefined;
      if (role === 'executor') return;

      const sessionId = input && input.sessionID;
      if (!sessionId) return;

      let root;
      try {
        root = findProjectRoot(directory);
      } catch {
        return;
      }

      const state = loadState(root, sessionId);
      if (!state || !state.skill) return;

      let graph;
      try {
        ({ graph } = loadSkillRuntime(root, state.skill));
      } catch {
        return;
      }

      const label = graph.node(state.node)?.label ?? '';
      const context = `RAILS: числится ${state.node} «${truncate(label, 80)}»`;
      if (output) {
        output.output = `${output.output ?? ''}\n\n${context}`;
      }
    },
  };
}

/**
 * Интерфейс плагина, которого ждёт Kilo (§9.2).
 *
 * @param {{directory: string}} args
 * @returns {Promise<{ "tool.execute.before": Function, "tool.execute.after": Function }>}
 */
export const WorkflowRails = async ({ directory }) => createHooks(directory, process.env);
