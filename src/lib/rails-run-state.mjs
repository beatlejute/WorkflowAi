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
 *
 * Здесь же — повтор по вердикту рельс: продолжение сессии хоста агента
 * (resumeSessionArgs) и тексты вердикта для той же и для новой сессии.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isKiloRun } from './kilo-models.mjs';
import { RAILS_CLI, describeTransitions } from '../rails/state.mjs';
import { loadSkillGraph } from '../rails/graph.mjs';

/**
 * Все состояния сессий rails с данным `run` в корне `root` (порядок каталога). Сессий у
 * одного запуска бывает больше одной: в журнале PulseProxy 2026-09-27 у двух запусков kilo —
 * по две сессии `ses_…` с общим `run` (переменные окружения процесса видят и субагенты).
 */
export function railsStatesByRun(root, run) {
  if (!root || !run) return [];
  const dir = path.join(root, '.workflow', 'state', 'rails');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (state && state.run === run) found.push(state);
    } catch {
      // повреждённый/недописанный файл состояния — пропускаем, как и
      // остальные читатели rails (journal.mjs, state.mjs).
    }
  }
  return found;
}

/** Файл состояния сессии rails с данным `run` в корне `root` (первый по порядку каталога), или null. */
export function findRailsStateByRun(root, run) {
  return railsStatesByRun(root, run)[0] ?? null;
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
 * Хост рельс агента — CLI, в котором хук рельс видит вызовы инструментов: 'kilo', 'claude'
 * или null (хука рельс у такого агента нет). `agent.rails_host` задаёт хост явно — для
 * обёртки с другим именем команды.
 *
 * @param {{command?: string, args?: string[], rails_host?: string}} agent
 * @returns {'kilo'|'claude'|null}
 */
export function railsHost(agent) {
  const explicit = agent?.rails_host;
  if (explicit === 'kilo' || explicit === 'claude') return explicit;
  return commandHost(agent);
}

/** Хост по самой команде агента (`kilo … run`, `claude`), без явного `rails_host`. */
function commandHost(agent) {
  if (isKiloRun(agent)) return 'kilo';
  const base = path.win32.basename(String(agent?.command ?? ''));
  return /^claude(?:\.cmd|\.exe|\.ps1)?$/i.test(base) ? 'claude' : null;
}

// Флаги сессии в записи агента: с любым из них раннер своё продолжение не добавляет —
// сочетание с `--resume` / `--session` не проверено. Списки — `claude --help` 2.1.278 и
// `kilo run --help` 7.7.9.
const CLAUDE_SESSION_FLAGS = new Set([
  '--resume', '-r', '--continue', '-c', '--session-id', '--fork-session', '--no-session-persistence', '--from-pr',
]);
const KILO_SESSION_FLAGS = new Set(['--continue', '-c', '--session', '-s', '--fork', '--cloud-fork']);
// id сессии уходит в командную строку, на Windows — через cmd.exe без кавычек (shell: true):
// только буквы, цифры, `_` и `-` (uuid Claude, `ses_…` kilo).
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Аргументы агента, продолжающие сессию хоста `sessionId` (id сессии из состояния рельс,
 * поле `session`: его пишет хук хоста), или null — продолжить нельзя.
 *
 * Хост — по команде агента, как в railsHost, но без явного `rails_host`: у обёртки с другим
 * именем команды флаги продолжения неизвестны. Проверено запуском 2026-09-27:
 *  - claude 2.1.278: `claude --resume <id> … -p` с промптом через stdin продолжает ту же
 *    сессию — ответ помнит прежний разговор, `session_id` в ответе и во входе хуков
 *    (`SessionStart` с `source: "resume"`, `PreToolUse`) прежний, значит и состояние рельс
 *    (файл `<session>.json`) то же;
 *  - kilo 7.7.9: `kilo … run --session <id> --title <та же метка>` с промптом через stdin
 *    дописывает ту же сессию (в базе kilo та же строка `session`, сообщений стало больше,
 *    метка прежняя), ответ помнит прежний разговор.
 * Флаги сессии уже в записи агента — null (CLAUDE_SESSION_FLAGS, KILO_SESSION_FLAGS).
 *
 * @param {{command?: string, args?: string[]}} agent
 * @param {string} sessionId
 * @returns {string[]|null}
 */
export function resumeSessionArgs(agent, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  const args = Array.isArray(agent?.args) ? agent.args.map(String) : [];
  const flag = (a) => a.split('=')[0];
  const host = commandHost(agent);
  if (host === 'claude') {
    if (args.some((a) => CLAUDE_SESSION_FLAGS.has(flag(a)))) return null;
    return ['--resume', sessionId, ...args];
  }
  if (host === 'kilo') {
    if (args.some((a) => KILO_SESSION_FLAGS.has(flag(a)))) return null;
    const i = args.indexOf('run');
    return [...args.slice(0, i + 1), '--session', sessionId, ...args.slice(i + 1)];
  }
  return null;
}

/**
 * Скрипты хуков рельс из настроек Claude: записи `_workflow_rails` вида `node "<путь>" …`
 * (так их пишет `workflow init`, §11). Нет файла, битый JSON — пусто.
 */
function claudeRailsHookScripts(settingsPath) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return [];
  }
  const out = [];
  for (const groups of Object.values(settings?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (hook?._workflow_rails !== true || typeof hook.command !== 'string') continue;
        const m = /node(?:\.exe)?\s+"([^"]+)"/.exec(hook.command) || /node(?:\.exe)?\s+(\S+)/.exec(hook.command);
        if (m) out.push(m[1]);
      }
    }
  }
  return out;
}

/**
 * Стоят ли рабочие хуки рельс, которые увидит агент хоста `host`, запущенный в `cwd`:
 * kilo — загрузчик `<cwd>/.kilo/plugin/workflow-rails.js` и ядро, на которое он ссылается
 * (`<cwd>/.workflow/src/rails/kilo-plugin.mjs`, §9.2); claude — запись `_workflow_rails` в
 * настройках пользователя или проекта, скрипт которой существует (§9.1). Одной записи мало:
 * хук на удалённый скрипт падает, вызовы проходят без состояния, и раннер принял бы исправного
 * агента за молчащего (ревью 2026-09-25).
 *
 * @param {string|null} host
 * @param {string} cwd
 * @param {{userSettingsPath?: string}} [opts] путь настроек Claude пользователя (для тестов)
 */
export function railsHooksPresent(host, cwd, { userSettingsPath = path.join(os.homedir(), '.claude', 'settings.json') } = {}) {
  if (host === 'kilo') {
    return fs.existsSync(path.join(cwd, '.kilo', 'plugin', 'workflow-rails.js'))
      && fs.existsSync(path.join(cwd, '.workflow', 'src', 'rails', 'kilo-plugin.mjs'));
  }
  if (host === 'claude') {
    return [userSettingsPath, path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json')]
      .some((file) => claudeRailsHookScripts(file).some((script) => fs.existsSync(path.resolve(cwd, script))));
  }
  return false;
}

function terminalText(config) {
  const terminal = Array.isArray(config?.terminal) ? config.terminal : [];
  return terminal.length > 0 ? `Финальный ответ — только в ${terminal.join(', ')}.` : 'Финальный ответ — только в терминальном узле графа.';
}

// Прогон PulseProxy 2026-09-27: повторы claude-haiku в новой сессии дважды ответили за два
// хода без единого вызова инструмента — напечатали команду goto текстом ответа.
const RUN_COMMANDS_TEXT = 'Команды рельс выполняй инструментом shell: команда, напечатанная в ответе, перехода не делает.';

/**
 * Вердикт повтора, когда хуки рельс на месте, а состояния сессии нет: за весь запуск агент
 * не вызвал ни одного инструмента под рельсами — финальный ответ дан без процедуры скила.
 * Прогон deep-research 2026-09-25: gpt-luna во всех трёх попытках ответила отчётом без
 * единого вызова инструмента, output-check не запускался, одна попытка прошла. Повтор —
 * новая сессия (продолжать нечего: id сессии хоста знает только состояние рельс), граф — с
 * первого узла.
 */
export function railsNotEngagedVerdict({ skill, config }) {
  return `RAILS: предыдущий ответ отклонён — скил «${skill}» идёт по рельсам, а за весь запуск не было `
    + 'ни одного вызова инструмента под рельсами: процедура скила не пройдена. '
    + `Пройди граф от первого узла: начни командой \`node ${RAILS_CLI} start ${skill}\` и переходи `
    + `командами goto, которые она печатает. ${RUN_COMMANDS_TEXT} ${terminalText(config)}\n\n`;
}

/**
 * Вердикт повтора по output-check.
 *
 * `sameSession: true` — повтор продолжает ту же сессию хоста (resumeSessionArgs): рельсы
 * помнят узел, и вердикт называет, где агент числится, и готовые команды переходов оттуда
 * (state.describeTransitions; граф не читается — без переходов). Ребро, закрытое стражем
 * (§4 edge_guards), — «закрыто: причина» без команды: иначе вердикт звал бы в переход,
 * который `goto` отклонит. Для стражей нужны `root` (корень проекта) и `ticket` (тикет
 * запуска, `{ticket}`); без `root` стражи не проверяются.
 *
 * По умолчанию повтор — новая сессия: её рельсы начинаются с `entry`, а прежний узел —
 * узел другой сессии. Прогон PulseProxy 2026-09-27: новой сессии сказали «Числишься в
 * P7S1», её `goto P7S2` рельсы отклонили («нет ребра из P0E1 в P7S2»), два других повтора
 * напечатали команду текстом и ответили без процедуры скила. Поэтому для новой сессии
 * вердикт говорит правду: где остановилась прошлая сессия, что граф — заново командой
 * `start`, и что сделанное осталось только в файлах.
 *
 * @param {{verdict: {missing: string[]}, state: object, config: object, skillDir: string,
 *   skill?: string, sameSession?: boolean, root?: string, ticket?: string|null}} args
 *   skill — имя скила для команды `start` (иначе `config.skill`, затем `state.skill`)
 */
export function outputCheckVerdict({ verdict, state, config, skillDir, skill, sameSession = false, root, ticket }) {
  const head = `RAILS: предыдущий ответ отклонён output-check — отсутствует: ${verdict.missing.join('; ')}.`;
  const tail = `${RUN_COMMANDS_TEXT} ${terminalText(config)} Исправь и ответь заново.\n\n`;
  if (!sameSession) {
    const name = skill || config?.skill || state?.skill || '<скил>';
    const stoppedAt = state?.node ? ` Прошлая сессия остановилась в ${state.node}, но это новая сессия:` : ' Это новая сессия:';
    return `${head}${stoppedAt} её рельсы начинаются с первого узла графа — начни командой `
      + `\`node ${RAILS_CLI} start ${name}\` и переходи командами goto, которые она печатает. `
      + 'Сделанное прошлой сессией осталось только в файлах проекта (в том числе в тикете, если он есть): '
      + `сверься с ними и не переделывай готовое. ${tail}`;
  }
  let where = '';
  try {
    const graph = loadSkillGraph(skillDir, config);
    const lines = describeTransitions(state, graph, config, { root, ticket });
    where = ` Сессия та же. Числишься в ${state.node}.${lines.length > 0 ? ` Переходы оттуда:\n${lines.map((l) => `  ${l}`).join('\n')}\n` : ''}`;
  } catch {
    where = state?.node ? ` Сессия та же. Числишься в ${state.node}.` : '';
  }
  return `${head}${where} ${tail}`;
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
    rails_failed: marked.filter((t) => t.rails.failed).length,
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
    const failed = m.rails_failed ? `, провалено без рельс ${m.rails_failed}` : '';
    out.push(`${caseId} ${agentId}: рельсы не зацепились ${m.rails_not_engaged}/${m.total}${escaped}${failed}`);
  }
  return out;
}
