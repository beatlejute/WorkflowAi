/**
 * Состояние сессии rails по `run` (rails/README.md §5: поле `run` — id запуска
 * агента раннером) и признак того, зацепились ли рельсы за запуск агента в
 * тесте скила.
 *
 * Раннер тестов даёт агенту песочницу и ищет состояние его сессии там. Нет
 * состояния — хук не записал его в песочнице: агент не вызывал инструментов,
 * хуков рельс в песочнице нет, хук упал или агент работал не в песочнице.
 * Последнее случилось 2026-09-23 и 2026-09-25: `kilo run` 7.7.x брал каталог из
 * унаследованного PWD и писал состояние рельс в настоящий проект (см.
 * lib/agent-env.mjs). Раньше любой такой случай молча отключал output-check;
 * теперь раннер сообщает о нём, а побег в настоящий проект различает отдельно.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Файл состояния сессии rails с данным `run` в корне `root`, или null. */
export function findRailsStateByRun(root, run) {
  if (!root || !run) return null;
  const dir = path.join(root, '.workflow', 'state', 'rails');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (state && state.run === run) return state;
    } catch {
      // повреждённый/недописанный файл состояния — пропускаем, как и
      // остальные читатели rails (journal.mjs, state.mjs).
    }
  }
  return null;
}

/**
 * Зацепились ли рельсы за запуск агента.
 *
 * @param {{ sandboxRoot: string, projectRoot?: string, run: string }} args
 *   sandboxRoot — рабочий каталог запуска (песочница теста),
 *   projectRoot — настоящий проект раннера, куда агент мог уйти мимо песочницы.
 * @returns {{ state: object|null, engaged: boolean, escaped: boolean }}
 *   engaged — состояние с этим run есть в песочнице;
 *   escaped — в песочнице его нет, а в настоящем проекте есть.
 */
export function railsEngagement({ sandboxRoot, projectRoot, run }) {
  const state = findRailsStateByRun(sandboxRoot, run);
  if (state) return { state, engaged: true, escaped: false };
  return { state: null, engaged: false, escaped: Boolean(findRailsStateByRun(projectRoot, run)) };
}

/**
 * Строка предупреждения раннера о запуске без состояния в песочнице. Факт — где
 * состояния нет или где оно нашлось; причина при «нет нигде» раннеру не видна,
 * поэтому перечисляются варианты.
 */
export function railsNotEngagedMessage({ who, escaped, projectRoot }) {
  if (escaped) {
    return `[Runner] ⚠ rails: ${who} — состояние сессии этого запуска найдено в ${projectRoot}, а не в песочнице: `
      + 'агент работал мимо песочницы, изоляция теста нарушена; output-check не выполнен';
  }
  return `[Runner] ⚠ rails: ${who} — состояния сессии этого запуска нет ни в песочнице, ни в ${projectRoot}; `
    + 'output-check не выполнен. Возможные причины: агент не вызывал инструментов; хуков рельс в песочнице нет '
    + '(WORKFLOW_RAILS_WORKDIR_HOOKS, хуки пользователя); хук упал или записал состояние в другой каталог';
}

/**
 * Счётчики по попыткам одной модели: сколько прошло без состояния в песочнице
 * и сколько из них — мимо песочницы. null — у попыток нет отметки rails (скил
 * не на рельсах).
 */
export function railsCounters(trials) {
  const marked = (trials || []).filter((t) => t && t.rails);
  if (marked.length === 0) return null;
  return {
    rails_not_engaged: marked.filter((t) => !t.rails.engaged).length,
    rails_escaped: marked.filter((t) => t.rails.escaped).length,
  };
}

/**
 * Строки для `rails_warnings` блока ---RESULT---: по модели кейса — попытки без
 * состояния в песочнице из общего числа, и сколько из них мимо песочницы.
 */
export function describeRailsEngagement(caseId, aggregated) {
  const out = [];
  for (const [agentId, m] of Object.entries(aggregated?.per_model || {})) {
    if (!m.rails_not_engaged) continue;
    const escaped = m.rails_escaped ? `, вне песочницы ${m.rails_escaped}` : '';
    out.push(`${caseId} ${agentId}: рельсы не зацепились ${m.rails_not_engaged}/${m.total}${escaped}`);
  }
  return out;
}
