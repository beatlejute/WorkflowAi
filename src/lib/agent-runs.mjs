/**
 * Журнал запусков агентов `.workflow/metrics/agent-runs.jsonl` и отсев моделей по нему
 * (PLAN-003).
 *
 * Журнал — файл проекта, только дописывание, одна строка — один JSON-объект, одна
 * строка на событие. Виды событий (`type`):
 *   - `run`    — агент стадии со списком агентов завершился (успех, ошибка,
 *                `model_banned`, остановка пайплайна) или прерван без записи исхода
 *                (дописывает следующий старт пайплайна, `interrupted: true`);
 *   - `verify` — завершилась стадия контроля артефактов с блоком RESULT;
 *   - `review` — завершилась стадия ревью;
 *   - `unban`  — человек снял запрет;
 *   - `reset`  — человек обнулил историю модели (PLAN-004, решение 1): запуски модели,
 *                записанные раньше её последнего `reset`, в градации не идут (gradeRuns).
 * Промптов, вывода агента и содержимого файлов в журнале нет. Строка, не разбираемая
 * как JSON, при чтении пропускается.
 *
 * Градации, запреты и таблица статистики не хранятся, а вычисляются из журнала:
 * смена правил пересчитывает всю историю, снятие запрета — событие, а не правка файла.
 *
 * Градация — только у запуска исполнителя (стадия со скилом `execute-task`), первая
 * ступень, на которой остановилась его работа: `crashed`, `refused`, `stopped`,
 * `throttled`, `empty`, `artifacts_failed`, `review_failed`, `accepted`, `pending`
 * (gradeRuns). Неудача модели — `empty` и `artifacts_failed`; успех — пройденный
 * контроль артефактов (`artifacts_passed: true`), даже если потом не пройдено ревью.
 * `stopped` и `throttled` (агент упал на ограничении провайдера, статус `rate_limit`)
 * модели не засчитываются: ни неудачи, ни успеха, ни временного запрета за сбой, ни
 * серии «модель недоступна».
 *
 * Запреты:
 *   - постоянный, модель + тип тикета, с последнего снятия (`unban` с этим типом):
 *     правило 1 — неудач ≥ 3 и ни одного успеха; правило 2 — не меньше 10 оценённых
 *     запусков и среди последних 10 успехов < 3 (permanentBans);
 *   - временный, модель целиком: последний запуск модели, кроме `stopped` и
 *     `throttled`, после последнего снятия (`unban` без типа) — сбой, и его TTL ещё
 *     не истёк (crashBans);
 *   - временный «модель недоступна», модель целиком: последние запуски модели после
 *     последнего снятия (`unban` без типа) — не меньше 3 сбоев процесса `error` и
 *     `timeout` подряд без пройденного после них контроля артефактов; `stopped`,
 *     `throttled` и сбои `network_error`, `auth_error`, `aborted` без пройденного
 *     контроля серию не продолжают и не прерывают, любой другой запуск — в том числе
 *     пройденный контроль после любого сбоя — её обнуляет (UNAVAILABLE_STATUSES);
 *     TTL — час на первой серии и вдвое больше на каждой следующей, не больше суток
 *     (unavailableBans). Оба временных запрета — в списке `crash` (activeBans), второй —
 *     с `rule: 'unavailable'`.
 * Запуски с `model: null` (модель kilo не прочитана) ни в одно правило не идут.
 *
 * Запись открытого запуска `.workflow/state/agent-run-open.json` — файл состояния
 * раннера, не журнал: раннер пишет его до старта агента и удаляет после события `run`
 * с тем же `run_key`. Раннер, снятый без обработчика (`taskkill /F`, `SIGKILL`), падение
 * раннера или машины оставляют файл, и следующий старт пайплайна под `.pipeline.lock`
 * закрывает его событием `run` со статусом `aborted` и `interrupted: true`
 * (closeInterruptedRun).
 *
 * Код не различает агентов и модели по имени: ключ модели выводится из записи агента
 * и данных запуска по общим правилам (runModelKey, configuredModelKey).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isKiloRun, requestedKiloModel, kiloModelKey } from './kilo-models.mjs';

export const RUNS_LOG = '.workflow/metrics/agent-runs.jsonl';
export const OPEN_RUN_FILE = '.workflow/state/agent-run-open.json';

/** Скил стадии исполнителя: только его запуски получают градацию и отсеиваются. */
export const EXECUTOR_SKILL = 'execute-task';

// Числа правил — решение стейкхолдера 2026-09-25 и 2026-09-26 (PLAN-003).
export const RULE1_MIN_FAILURES = 3;
export const RULE2_WINDOW = 10;
export const RULE2_MIN_SUCCESS = 3;
export const CRASH_TTL_DEFAULT_MS = 60 * 60 * 1000;
// Запрет «модель недоступна» (unavailableBans) — 2026-10-01, разбор прогонов PulseProxy
// PLAN-020 и ListeningGlass PLAN-001 29–30.09: модели без единого успеха снова и снова
// шли в пул — в журнале PulseProxy у nemotron-3-super 5 сбоев подряд. Временный запрет
// за сбой смотрит только на последний запуск, его TTL — TTL сработавшего правила health,
// без правила — час (CRASH_TTL_DEFAULT_MS), и сбои между собой не складывались. Серия —
// только сбои процесса `error` и `timeout` (UNAVAILABLE_STATUSES; PLAN-004 «rate_limit
// запрета модели не даёт»). Модель, которая упирается в ограничение провайдера, правило
// не покрывает: у gemini-3.5-flash-lite там же 11 запусков `rate_limit` подряд, и запрета
// нет. Такую модель выводят из выбора только health-реестр (общее правило
// `provider-rate-limit`, 15 мин) и шлагбаум места-пула `models.gate`, если он настроен.
export const UNAVAILABLE_MIN_FAILURES = 3;
export const UNAVAILABLE_TTL_BASE_MS = 60 * 60 * 1000;
export const UNAVAILABLE_TTL_MAX_MS = 24 * 60 * 60 * 1000;
// Доказательства запрета «модель недоступна» — последние запуски серии, не вся серия:
// у модели, которая не отвечает сутками, серия — десятки запусков, а запрет
// get_model_stats повторяет в каждой строке модели (по строке на тип тикета). Полная
// длина серии — в `failures` (ревью 2026-10-01).
export const UNAVAILABLE_EVIDENCE_MAX = 10;
// Наибольшее время, которое представимо в Date (ECMAScript: ±8.64e15 мс).
const MAX_DATE_MS = 8.64e15;

/**
 * Статусы запуска, которые считаются сбоем процесса. `aborted` — только без признака
 * остановки пайплайна (`stop_requested`, `interrupted`): агент снят сигналом мимо
 * остановки (решение 2026-09-27, вопрос 7: «Да, временный запрет»).
 */
const CRASH_STATUSES = new Set(['error', 'timeout', 'network_error', 'auth_error', 'aborted']);

/**
 * Сбои процесса, которые идут в серию «модель недоступна» (unavailableBans): `error`
 * (агент вышел с ошибкой, в том числе снят раннером досрочно по правилу health) и
 * `timeout` (не уложился в лимит стадии — и тогда, когда модель отвечала и правила
 * файлы). Остальные сбои процесса — `network_error`, `auth_error` и `aborted` без
 * остановки (агента сняли сигналом извне) — серию не продолжают и не прерывают;
 * временный запрет за сбой (crashBans) они по-прежнему дают.
 *
 * Замысел — не запрещать модели за сбой сети, прокси или ключа, но эти классы неточны:
 * classifyAgentResult (src/lib/agent-history.mjs) ставит `network_error` и `auth_error`
 * по совпадению во всём stderr, а у kilo там телеметрия («PostHogFetchNetworkError»),
 * синхронизация сессии («error=network … share sync failed») и вывод тестов проекта.
 * В PulseProxy 29–30.09 все 3 запуска исполнителя с `network_error` — досрочные снятия
 * kilo по перегрузке провайдера (правило health `kilo-provider-overloaded`), как и
 * 5 запусков с `error` (у одного `model: null`): одна причина в серию то идёт, то нет.
 * Точный признак — правило досрочного снятия в событии `run` или сетевые признаки
 * только в конце stderr — вне этого модуля.
 */
const UNAVAILABLE_STATUSES = new Set(['error', 'timeout']);

/**
 * Статус запуска, упавшего на ограничении провайдера (HTTP 429, rate limit, quota
 * exceeded в конце stderr — класс classifyAgentResult, PROVIDER_RATE_LIMIT_PATTERN;
 * 429 из середины, после которых агент продолжил работу, не в счёт). Это не дефект
 * модели: градация `throttled`, без временного запрета за сбой, вне правил 1 и 2 и вне
 * серии «модель недоступна» (unavailableBans: не продолжает и не прерывает её; PLAN-004
 * «rate_limit запрета модели не даёт»). Случай 2026-09-27, PulseProxy: kilo-роутер
 * 15 минут работал на модели, провайдер которой отвечал «Rate limit exceeded»; запуск
 * записан сбоем, и часовой временный запрет модели снимал второй роутер всякий раз,
 * когда тот выбирал ту же модель. Агента на это время выводит из выбора health-реестр:
 * CLI-агента — общее правило `provider-rate-limit` (configs/agent-health-rules.yaml),
 * агента `kind: http` и шага model_io — ошибка клиента модели `rate_limit` (src/runner.mjs).
 */
const THROTTLED_STATUS = 'rate_limit';

export const GRADES = Object.freeze([
  'crashed', 'refused', 'stopped', 'throttled', 'empty', 'artifacts_failed', 'review_failed', 'accepted', 'pending',
]);

// Градации, которые модели не засчитываются: ни в правила 1 и 2, ни во временный запрет
// за сбой, ни в серию «модель недоступна» (и не закрывают их — последним запуском модели
// не считаются, серию не прерывают).
const UNCOUNTED_GRADES = new Set(['stopped', 'throttled']);
const FAILURE_GRADES = new Set(['empty', 'artifacts_failed']);
const ARTIFACTS_PASSED = new Set(['all_green', 'passed', 'legacy']);
const REVIEW_VERDICTS = new Set(['passed', 'failed']);

// ---------------------------------------------------------------------------
// Журнал
// ---------------------------------------------------------------------------

export function runsLogPath(projectRoot) {
  return path.join(projectRoot, ...RUNS_LOG.split('/'));
}

// Файл есть, не пуст и последний байт — не перевод строки.
function endsWithoutNewline(file) {
  let fd;
  try {
    const { size } = fs.statSync(file);
    if (size === 0) return false;
    fd = fs.openSync(file, 'r');
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Дописывает событие одной строкой. `ts` (ISO UTC) ставится, если его нет. Ошибка
 * записи не бросается — возвращается: запись журнала не должна менять ход стадии.
 * @returns {{ok: true, event: object} | {ok: false, error: string}}
 */
export function appendRunEvent(projectRoot, event) {
  const { type, ts, ...fields } = event;
  const full = { type, ts: ts || new Date().toISOString(), ...fields };
  try {
    const file = runsLogPath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Последняя строка оборвана (писатель снят посреди записи, ручная правка без
    // перевода строки) — событие начинается с новой строки: склеенное с обрывком, оно
    // не разобралось бы, и читатель пропустил бы его вместе с обрывком (снятие запрета
    // из MCP отвечало бы «снято», а запрет оставался).
    const lead = endsWithoutNewline(file) ? '\n' : '';
    // Одна запись одним вызовом: строка события не делится между двумя писателями
    // (раннер и снятие запрета из MCP) — проверено одновременной записью из двух
    // процессов (src/tests/agent-runs.test.mjs).
    fs.appendFileSync(file, `${lead}${JSON.stringify(full)}\n`, 'utf8');
    return { ok: true, event: full };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * События журнала в порядке файла. Нет файла — пустой массив; строка, не разбираемая
 * как JSON-объект, пропускается. Ошибка чтения (кроме отсутствия файла) бросается:
 * вызывающий решает, как без журнала работать дальше.
 */
export function readRunEvents(projectRoot) {
  let text;
  try {
    text = fs.readFileSync(runsLogPath(projectRoot), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && !Array.isArray(event) && typeof event.type === 'string') {
        events.push(event);
      }
    } catch {
      // Испорченная строка (оборванная запись) — пропускается.
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Ключ модели
// ---------------------------------------------------------------------------

/** Тип тикета — как в resolveAgent: `task_type` контекста, иначе префикс `ticket_id`. */
export function ticketTypeOf(context = {}) {
  if (context.task_type) return String(context.task_type);
  if (context.ticket_id) return String(context.ticket_id).split('-')[0].toLowerCase();
  return null;
}

/** Модель, которую запросил конфиг: `-m` / `--model` в `args`, у `kind: http` — поле `model`. */
export function requestedModel(agent) {
  if (!agent) return null;
  if (Array.isArray(agent.args)) {
    const requested = requestedKiloModel(agent.args);
    if (requested) return requested;
  }
  if (agent.kind === 'http' && typeof agent.model === 'string' && agent.model) return agent.model;
  return null;
}

/**
 * Ключ модели агента по записи конфига — для отсева при выборе агента. kilo-агент —
 * запрошенная модель без провайдера, как её хранит kilo (`-m prov/x` → `x`); прочий
 * агент с командой — значение `--model` / `-m` как есть; `kind: http` — поле `model`;
 * без модели — id агента. У роутера kilo ключ — ключ роутера: ответившая модель у
 * него другая, поэтому роутер фильтр проходит, а его модели отсеивает остановка.
 */
export function configuredModelKey(agent, agentId) {
  const requested = requestedModel(agent);
  if (requested) return isKiloRun(agent) ? kiloModelKey(requested) : requested;
  return agentId ?? null;
}

/**
 * Ключ модели запуска — кому засчитывается запуск:
 *   - модель из ответа обмена `model_io` (`modelIoModel`);
 *   - kilo-агент — модель последнего шага корневой сессии (`kiloLast`); не прочитана
 *     (упал до первого шага, база не читается) — null: ключ из `args` у роутера — ключ
 *     роутера, общий для нескольких агентов, и сбой до первого шага запретил бы всех;
 *   - иначе — ключ по записи конфига (configuredModelKey).
 * Без данных запуска (до старта агента) — тот же ключ: у kilo-агента null.
 */
export function runModelKey(agent, agentId, { kiloLast = null, modelIoModel = null } = {}) {
  if (modelIoModel) return String(modelIoModel);
  if (isKiloRun(agent)) return kiloLast || null;
  return configuredModelKey(agent, agentId);
}

/** Новый идентификатор запуска агента — общий у записи открытого запуска и события `run`. */
export function newRunKey() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Градации
// ---------------------------------------------------------------------------

function isStopped(run) {
  return run.status === 'model_banned'
    || (run.status === 'aborted' && (run.stop_requested === true || run.interrupted === true));
}

/**
 * Статус запуска — сбой процесса (см. CRASH_STATUSES). Ограничение провайдера
 * (`rate_limit`, THROTTLED_STATUS) — не сбой: `crash_ttl_ms` раннер ему не пишет.
 */
export function isCrashStatus(run) {
  return CRASH_STATUSES.has(run.status) && !isStopped(run);
}

function verifyHasVerdict(event) {
  if (ARTIFACTS_PASSED.has(event.status)) return true;
  // `failed` без причин — сбой самого контроля (путь тикета не разобран, файла нет,
  // исключение скрипта), а не вердикт о тикете.
  return event.status === 'failed' && Array.isArray(event.fail_reasons) && event.fail_reasons.length > 0;
}

function gradeOf(run, verify, review) {
  if (isStopped(run)) return { grade: 'stopped', crashed_after_work: false, artifacts_passed: null };
  // Отказ исполнителя — и класс запуска `blocked`, и `status: blocked` блока RESULT
  // (`result_status`): статус RESULT раннер держит вне данных ответа, и класс
  // `blocked` агенту не достаётся никогда. Без второго условия отказ оценивался по
  // изменениям: PulseProxy FIX-032 2026-09-28 (claude-haiku, `result_status: blocked`,
  // 3 изменённых файла) — `pending`, отказ без изменений был бы `empty` — провалом.
  if (run.status === 'blocked' || run.result_status === 'blocked') {
    return { grade: 'refused', crashed_after_work: false, artifacts_passed: null };
  }
  // При любых изменениях, как `stopped`: работу оборвал провайдер, и контроль после
  // такого запуска о модели ничего не говорит.
  if (run.status === THROTTLED_STATUS) return { grade: 'throttled', crashed_after_work: false, artifacts_passed: null };
  const crash = isCrashStatus(run);
  if (crash && run.changed_files === 0) return { grade: 'crashed', crashed_after_work: false, artifacts_passed: null };
  const crashed_after_work = crash;
  if (!crash && run.changed_files === 0) return { grade: 'empty', crashed_after_work, artifacts_passed: null };
  if (!verify) return { grade: 'pending', crashed_after_work, artifacts_passed: null };
  if (verify.status === 'failed') return { grade: 'artifacts_failed', crashed_after_work, artifacts_passed: false };
  if (verify.status === 'all_green') return { grade: 'accepted', crashed_after_work, artifacts_passed: true };
  if (!review) return { grade: 'pending', crashed_after_work, artifacts_passed: true };
  return {
    grade: review.status === 'passed' ? 'accepted' : 'review_failed',
    crashed_after_work,
    artifacts_passed: true,
  };
}

/**
 * События → запуски исполнителя с градацией, в порядке журнала.
 *
 * Окно запуска — события того же тикета после него и до следующего запуска
 * исполнителя по этому тикету. «Ближайший» контроль — первое в окне событие
 * `verify` с вердиктом (`all_green`, `passed`, `legacy`, `failed` с причинами);
 * «ближайшее ревью» — первое в окне событие `review` со статусом `passed` или
 * `failed` (`default` и `error` — не вердикт).
 *
 * Запуск модели, записанный в журнале раньше последнего `reset` этой модели, в выдачу
 * не попадает, а значит — ни в запреты, ни в таблицу статистики. «Раньше» — по позиции
 * в журнале, как у `unban`. Окно такой запуск держит: иначе его контроль достался бы
 * предыдущему запуску того же тикета.
 *
 * @returns {Array<object>} поля события `run` и `grade`, `crashed_after_work`,
 *   `artifacts_passed` (true — контроль в окне пройден, false — `failed` с причинами,
 *   null — контроля с вердиктом нет или градация до контроля), `crash` (идёт во
 *   временный запрет), `verify`, `review` (события окна или null).
 */
export function gradeRuns(events) {
  return gradeIndexed(events).map(({ run }) => run);
}

// gradeRuns с позицией события `run` в журнале: по ней запуск сравнивается со снятием
// запрета (`unban`).
function gradeIndexed(events) {
  const runs = [];
  const windows = new Map();
  // Модель → позиция её последнего `reset`.
  const lastReset = new Map();
  for (const [index, event] of events.entries()) {
    if (event.type === 'run') {
      if (event.skill !== EXECUTOR_SKILL || !event.ticket) continue;
      const run = { event, index, verify: null, review: null };
      runs.push(run);
      windows.set(event.ticket, run);
    } else if (event.type === 'verify') {
      const run = windows.get(event.ticket);
      if (run && !run.verify && verifyHasVerdict(event)) run.verify = event;
    } else if (event.type === 'review') {
      const run = windows.get(event.ticket);
      if (run && !run.review && REVIEW_VERDICTS.has(event.status)) run.review = event;
    } else if (event.type === 'reset' && typeof event.model === 'string' && event.model) {
      lastReset.set(event.model, index);
    }
  }
  // Окна уже построены со всеми запусками — отсев по `reset` только после них.
  const counted = runs.filter(({ event, index }) => !(event.model && index < (lastReset.get(event.model) ?? -1)));
  return counted.map(({ event, index, verify, review }) => {
    const graded = gradeOf(event, verify, review);
    return {
      index,
      run: {
        ...event,
        ...graded,
        crash: graded.grade === 'crashed' || graded.crashed_after_work,
        verify,
        review,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Запреты
// ---------------------------------------------------------------------------

function evidenceOf(run) {
  return { ts: run.ts, ticket: run.ticket, agent: run.agent, grade: run.grade, run_key: run.run_key ?? null };
}

function lastUnbanIndex(events, match) {
  let index = -1;
  events.forEach((event, i) => { if (event.type === 'unban' && match(event)) index = i; });
  return index;
}

/**
 * Постоянные запреты пар «модель + тип тикета» по правилам 1 и 2. Счёт — с последнего
 * `unban` этой пары. Правило 2 — только при не меньше 10 оценённых запусках пары с
 * последнего снятия (решение 2026-09-26, вопрос 1: «С десяти запусков»). Запуски
 * `stopped` и `throttled` не оцениваются.
 * @returns {Array<{model, ticket_type, rule: 1|2, failures, successes, evidence}>}
 */
export function permanentBans(events) {
  const pairs = new Map();
  for (const { run, index } of gradeIndexed(events)) {
    if (!run.model || UNCOUNTED_GRADES.has(run.grade)) continue;
    const failure = FAILURE_GRADES.has(run.grade);
    const success = run.artifacts_passed === true;
    if (!failure && !success) continue;
    const key = JSON.stringify([run.model, run.ticket_type ?? null]);
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push({ run, index, failure, success });
  }
  const bans = [];
  for (const [key, evaluated] of pairs) {
    const [model, ticketType] = JSON.parse(key);
    const unbanAt = lastUnbanIndex(events, (e) => e.model === model && e.ticket_type && e.ticket_type === ticketType);
    const since = evaluated.filter(({ index }) => index > unbanAt);
    const failures = since.filter((r) => r.failure);
    const successes = since.filter((r) => r.success);
    if (failures.length >= RULE1_MIN_FAILURES && successes.length === 0) {
      bans.push({ model, ticket_type: ticketType, rule: 1, failures: failures.length, successes: 0, evidence: failures.map(({ run }) => evidenceOf(run)) });
      continue;
    }
    if (since.length >= RULE2_WINDOW) {
      const window = since.slice(-RULE2_WINDOW);
      const windowSuccesses = window.filter((r) => r.success).length;
      if (windowSuccesses < RULE2_MIN_SUCCESS) {
        bans.push({
          model, ticket_type: ticketType, rule: 2,
          failures: window.length - windowSuccesses, successes: windowSuccesses,
          evidence: window.map(({ run }) => evidenceOf(run)),
        });
      }
    }
  }
  return bans;
}

/**
 * Временные запреты моделей за сбои. Модель под запретом, если её последний запуск
 * исполнителя без градаций `stopped` и `throttled` после последнего `unban` этой модели
 * без типа тикета — сбой (`crashed` или `crashed_after_work`) и `ts + crash_ttl_ms`
 * позже `now`. Тип тикета не учитывается. `stopped` пропускается: остановка
 * `model_banned` — тоже запуск этой модели, и без пропуска первая же остановка снимала
 * бы запрет. `throttled` пропускается по той же причине: ограничение провайдера о
 * модели ничего не говорит — ни запрета не даёт, ни прежний не снимает.
 * @returns {Array<{model, until: string, crash_ttl_ms: number, evidence}>}
 */
export function crashBans(events, now = Date.now()) {
  const lastByModel = new Map();
  for (const { run, index } of gradeIndexed(events)) {
    if (!run.model || UNCOUNTED_GRADES.has(run.grade)) continue;
    lastByModel.set(run.model, { run, index });
  }
  const bans = [];
  for (const [model, { run, index }] of lastByModel) {
    if (!run.crash) continue;
    const unbanAt = lastUnbanIndex(events, (e) => e.model === model && !e.ticket_type);
    if (index < unbanAt) continue;
    const ttl = Number.isFinite(run.crash_ttl_ms) ? run.crash_ttl_ms : CRASH_TTL_DEFAULT_MS;
    // TTL `infinite` правила health — конец запрета за пределами Date: держится на
    // наибольшем представимом времени, иначе toISOString бросал бы на каждом чтении.
    const until = Math.min(Date.parse(run.ts) + ttl, MAX_DATE_MS);
    if (!(until > now)) continue;
    bans.push({ model, until: new Date(until).toISOString(), crash_ttl_ms: ttl, evidence: [evidenceOf(run)] });
  }
  return bans;
}

// Место запуска в серии «модель недоступна»:
//   - 'skip' — серию не продолжает и не прерывает: `stopped`, `throttled`
//     (UNCOUNTED_GRADES) и сбой процесса вне UNAVAILABLE_STATUSES без пройденного после
//     него контроля артефактов;
//   - 'reset' — модель ответила: не сбой или пройденный контроль после любого сбоя;
//   - 'fail' — признак недоступности: сбой из UNAVAILABLE_STATUSES без пройденного
//     контроля (`crashed`, `crashed_after_work`).
function unavailableRole(run) {
  if (UNCOUNTED_GRADES.has(run.grade)) return 'skip';
  if (!run.crash || run.artifacts_passed === true) return 'reset';
  return UNAVAILABLE_STATUSES.has(run.status) ? 'fail' : 'skip';
}

/**
 * TTL запрета «модель недоступна» серии с номером `series` (1 — первая):
 * UNAVAILABLE_TTL_BASE_MS, вдвое больше на каждой следующей, не больше
 * UNAVAILABLE_TTL_MAX_MS.
 */
export function unavailableTtlMs(series) {
  return Math.min(UNAVAILABLE_TTL_BASE_MS * 2 ** Math.max(0, series - 1), UNAVAILABLE_TTL_MAX_MS);
}

/**
 * Временные запреты «модель недоступна» — по серии неудачных запусков подряд, на модель
 * целиком (тип тикета не учитывается).
 *
 * Серия — хвост запусков исполнителя модели после последнего `unban` этой модели без
 * типа тикета, в котором каждый запуск — сбой процесса `error` или `timeout` без
 * пройденного после него контроля артефактов (unavailableRole). Пропускаются — серию не
 * продолжают и не прерывают — `stopped` (остановка пайплайна, `model_banned`),
 * `throttled` (ограничение провайдера) и сбои `network_error`, `auth_error`, `aborted`
 * без пройденного контроля (UNAVAILABLE_STATUSES: почему они вне серии и чем неточен их
 * класс). Любой другой запуск серию обнуляет: модель ответила — значит, доступна.
 * `reset` обнуляет серию тем, что его запуски выпадают из градаций (gradeRuns).
 *
 * Запрет — при серии из не меньше UNAVAILABLE_MIN_FAILURES запусков: первые
 * UNAVAILABLE_MIN_FAILURES — серия 1, каждый следующий неудачный запуск без успеха —
 * следующая серия, TTL которой вдвое больше (unavailableTtlMs). Отсчёт — от `ts`
 * последнего запуска серии. Так модель, которая после конца запрета снова не ответила,
 * уходит из выбора сразу, а не через ещё UNAVAILABLE_MIN_FAILURES запусков.
 *
 * @returns {Array<{model, rule: 'unavailable', until: string, crash_ttl_ms: number,
 *   failures: number, series: number, evidence}>} `failures` — длина серии, `evidence` —
 *   её последние UNAVAILABLE_EVIDENCE_MAX запусков в порядке журнала.
 */
export function unavailableBans(events, now = Date.now()) {
  const streaks = new Map();
  for (const { run, index } of gradeIndexed(events)) {
    if (!run.model) continue;
    const role = unavailableRole(run);
    if (role === 'skip') continue;
    if (role === 'reset') {
      streaks.set(run.model, []);
      continue;
    }
    if (!streaks.has(run.model)) streaks.set(run.model, []);
    streaks.get(run.model).push({ run, index });
  }
  const bans = [];
  for (const [model, tail] of streaks) {
    if (tail.length < UNAVAILABLE_MIN_FAILURES) continue;
    const unbanAt = lastUnbanIndex(events, (e) => e.model === model && !e.ticket_type);
    const streak = tail.filter(({ index }) => index > unbanAt);
    if (streak.length < UNAVAILABLE_MIN_FAILURES) continue;
    const series = streak.length - UNAVAILABLE_MIN_FAILURES + 1;
    const ttl = unavailableTtlMs(series);
    const last = streak[streak.length - 1].run;
    const until = Date.parse(last.ts) + ttl;
    if (!(until > now)) continue;
    bans.push({
      model,
      rule: 'unavailable',
      until: new Date(until).toISOString(),
      crash_ttl_ms: ttl,
      failures: streak.length,
      series,
      evidence: streak.slice(-UNAVAILABLE_EVIDENCE_MAX).map(({ run }) => evidenceOf(run)),
    });
  }
  return bans;
}

/**
 * Действующие запреты: постоянные и временные. Временные (`crash`) — за сбой последнего
 * запуска (crashBans) и «модель недоступна» (unavailableBans, `rule: 'unavailable'`):
 * у модели их может быть два. Один список — чтобы снятие без типа тикета (recordUnban,
 * unban_model workflow-mcp), выдача get_model_stats и проверка истечения в раннере
 * (`kind: 'crash'`, `until`) работали с обоими одинаково.
 */
export function activeBans(events, now = Date.now()) {
  return { permanent: permanentBans(events), crash: [...crashBans(events, now), ...unavailableBans(events, now)] };
}

/**
 * Запрет модели для типа тикета или null. Постоянный — по паре, временный — на модель
 * целиком; из двух временных — с более поздним концом: раннер сверяет `until` с часами
 * во время запуска, и истёкший ранний запрет не должен снимать действующий поздний.
 */
export function findBan(bans, model, ticketType) {
  if (!bans || !model) return null;
  const permanent = bans.permanent.find((b) => b.model === model && (b.ticket_type ?? null) === (ticketType ?? null));
  if (permanent) return { kind: 'permanent', ...permanent };
  let crash = null;
  for (const b of bans.crash) {
    if (b.model === model && (!crash || Date.parse(b.until) > Date.parse(crash.until))) crash = b;
  }
  if (crash) return { kind: 'crash', ...crash };
  return null;
}

/** Причина запрета одной строкой — для лога. */
export function describeBan(ban) {
  if (!ban) return '';
  if (ban.kind === 'crash' && ban.rule === 'unavailable') {
    return `temporary ban until ${ban.until} (unavailable: ${ban.failures} failed runs in a row, series ${ban.series}, last at ${ban.evidence[ban.evidence.length - 1]?.ts})`;
  }
  if (ban.kind === 'crash') return `temporary ban until ${ban.until} (crash at ${ban.evidence[0]?.ts})`;
  return ban.rule === 1
    ? `permanent ban for type "${ban.ticket_type}" by rule 1 (${ban.failures} failures, 0 successes since last unban)`
    : `permanent ban for type "${ban.ticket_type}" by rule 2 (${ban.successes} successes in last ${RULE2_WINDOW} evaluated runs)`;
}

// ---------------------------------------------------------------------------
// Таблица статистики, снятие запрета и обнуление истории — для MCP и скриптов
// ---------------------------------------------------------------------------

/**
 * Строки «модель + тип тикета»: число запусков исполнителя по каждой градации, доля
 * успехов по контролю артефактов (`artifacts_passed: true` среди запусков с
 * `artifacts_passed` не null), доля принятых на ревью (вердикт `passed` среди запусков
 * с вердиктом ревью; `all_green` ревью не проходит и в долю не входит; для сведения),
 * действующие запреты с доказательствами. Запуски с
 * `model: null` — строкой с `model: null` («модель неизвестна»).
 */
export function statsTable(events, now = Date.now()) {
  const bans = activeBans(events, now);
  const rows = new Map();
  for (const run of gradeRuns(events)) {
    const model = run.model || null;
    const ticketType = run.ticket_type ?? null;
    const key = JSON.stringify([model, ticketType]);
    if (!rows.has(key)) {
      rows.set(key, {
        model,
        ticket_type: ticketType,
        runs: 0,
        grades: Object.fromEntries(GRADES.map((g) => [g, 0])),
        artifacts_passed: 0,
        artifacts_evaluated: 0,
        reviews_passed: 0,
        reviews: 0,
      });
    }
    const row = rows.get(key);
    row.runs += 1;
    row.grades[run.grade] += 1;
    if (run.artifacts_passed !== null) {
      row.artifacts_evaluated += 1;
      if (run.artifacts_passed) row.artifacts_passed += 1;
    }
    // Ревью было: вердикт ревью в окне и контроль не all_green (при all_green ревью нет).
    if ((run.grade === 'accepted' || run.grade === 'review_failed') && run.review && run.verify?.status !== 'all_green') {
      row.reviews += 1;
      if (run.grade === 'accepted') row.reviews_passed += 1;
    }
  }
  return [...rows.values()].map((row) => {
    const rowBans = [];
    if (row.model) {
      const permanent = bans.permanent.find((b) => b.model === row.model && (b.ticket_type ?? null) === row.ticket_type);
      if (permanent) rowBans.push({ kind: 'permanent', ...permanent });
      for (const crash of bans.crash) {
        if (crash.model === row.model) rowBans.push({ kind: 'crash', ...crash });
      }
    }
    return {
      model: row.model,
      ticket_type: row.ticket_type,
      runs: row.runs,
      grades: row.grades,
      artifacts_success_rate: row.artifacts_evaluated ? row.artifacts_passed / row.artifacts_evaluated : null,
      review_accept_rate: row.reviews ? row.reviews_passed / row.reviews : null,
      bans: rowBans,
    };
  });
}

/**
 * Снятие запрета человеком: дописывает `unban`. С `ticket_type` — снятие постоянного
 * запрета пары, без него — временных запретов модели (за сбой и «модель недоступна»:
 * серия считается заново с этого `unban`). Запрета нет — отказ, строка не пишется.
 * @returns {{ok: true, event: object} | {ok: false, code: string, error: string}}
 */
export function recordUnban(projectRoot, { model, ticket_type = null, reason } = {}, now = Date.now()) {
  if (typeof model !== 'string' || !model) return { ok: false, code: 'BAD_INPUT', error: 'model is required' };
  if (typeof reason !== 'string' || !reason.trim()) return { ok: false, code: 'BAD_INPUT', error: 'reason is required' };
  let events;
  try {
    events = readRunEvents(projectRoot);
  } catch (err) {
    return { ok: false, code: 'READ_FAILED', error: err.message };
  }
  const bans = activeBans(events, now);
  const exists = ticket_type
    ? bans.permanent.some((b) => b.model === model && b.ticket_type === ticket_type)
    : bans.crash.some((b) => b.model === model);
  if (!exists) {
    return {
      ok: false,
      code: 'NO_BAN',
      error: ticket_type
        ? `no permanent ban for model "${model}" and ticket type "${ticket_type}"`
        : `no temporary ban for model "${model}"`,
    };
  }
  const event = { type: 'unban', ts: new Date(now).toISOString(), model, ...(ticket_type ? { ticket_type } : {}), reason: reason.trim() };
  const written = appendRunEvent(projectRoot, event);
  if (!written.ok) return { ok: false, code: 'WRITE_FAILED', error: written.error };
  return { ok: true, event: written.event };
}

/**
 * Обнуление истории модели человеком (PLAN-004, решение 1): дописывает `reset`. Запуски
 * модели до него выпадают из градаций, запретов и таблицы статистики (gradeRuns). В
 * отличие от `unban`, запрет не нужен; нужен хотя бы один `run` с этим `model` — защита
 * от опечатки в ключе. Нет — отказ, строка не пишется.
 * @returns {{ok: true, event: object} | {ok: false, code: string, error: string}}
 */
export function recordReset(projectRoot, { model, reason } = {}, now = Date.now()) {
  if (typeof model !== 'string' || !model) return { ok: false, code: 'BAD_INPUT', error: 'model is required' };
  if (typeof reason !== 'string' || !reason.trim()) return { ok: false, code: 'BAD_INPUT', error: 'reason is required' };
  let events;
  try {
    events = readRunEvents(projectRoot);
  } catch (err) {
    return { ok: false, code: 'READ_FAILED', error: err.message };
  }
  if (!events.some((event) => event.type === 'run' && event.model === model)) {
    return { ok: false, code: 'NO_RUNS', error: `no runs of model "${model}" in the log` };
  }
  const written = appendRunEvent(projectRoot, { type: 'reset', ts: new Date(now).toISOString(), model, reason: reason.trim() });
  if (!written.ok) return { ok: false, code: 'WRITE_FAILED', error: written.error };
  return { ok: true, event: written.event };
}

// ---------------------------------------------------------------------------
// Запись открытого запуска
// ---------------------------------------------------------------------------

export function openRunPath(projectRoot) {
  return path.join(projectRoot, ...OPEN_RUN_FILE.split('/'));
}

/** Пишет запись открытого запуска целиком. Ошибка возвращается, не бросается. */
export function writeOpenRun(projectRoot, record) {
  try {
    const file = openRunPath(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Удаляет запись открытого запуска; нет файла — не ошибка. */
export function clearOpenRun(projectRoot) {
  try {
    fs.rmSync(openRunPath(projectRoot), { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Закрывает запись открытого запуска, оставленную прерванным раннером. Вызывается
 * только владельцем `.pipeline.lock`: до его взятия файл может принадлежать живому
 * раннеру.
 *
 * Есть файл и в журнале нет `run` с его `run_key` — дописывается `run` с полями файла,
 * `status: "aborted"`, `interrupted: true`, `started_at` — время старта из файла,
 * `ts` — время дописывания; `exit_code`, `changed_files`, `duration_ms`, `models` —
 * null. Событие уже есть (раннер снят между событием и удалением файла) — второе не
 * пишется. Нечитаемый файл удаляется без события.
 *
 * @returns {{action: 'none'} | {action: 'closed', event} | {action: 'already_logged', run_key}
 *   | {action: 'unreadable', error} | {action: 'failed', error}}
 *   `failed` — не прочитан журнал или не записано событие; файл тогда остаётся.
 */
export function closeInterruptedRun(projectRoot, now = Date.now()) {
  const file = openRunPath(projectRoot);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { action: 'none' };
    clearOpenRun(projectRoot);
    return { action: 'unreadable', error: err.message };
  }
  let record;
  try {
    record = JSON.parse(text);
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.run_key !== 'string' || !record.run_key) {
      throw new Error('no run_key');
    }
  } catch (err) {
    clearOpenRun(projectRoot);
    return { action: 'unreadable', error: err.message };
  }
  let events;
  try {
    events = readRunEvents(projectRoot);
  } catch (err) {
    return { action: 'failed', error: err.message };
  }
  if (events.some((event) => event.type === 'run' && event.run_key === record.run_key)) {
    clearOpenRun(projectRoot);
    return { action: 'already_logged', run_key: record.run_key };
  }
  const { ts: startedAt, ...fields } = record;
  const event = {
    ...fields,
    type: 'run',
    ts: new Date(now).toISOString(),
    started_at: startedAt ?? null,
    models: null,
    status: 'aborted',
    exit_code: null,
    changed_files: null,
    duration_ms: null,
    interrupted: true,
  };
  const written = appendRunEvent(projectRoot, event);
  if (!written.ok) return { action: 'failed', error: written.error };
  clearOpenRun(projectRoot);
  return { action: 'closed', event: written.event };
}
