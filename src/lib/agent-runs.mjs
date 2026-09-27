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
 *   - `unban`  — человек снял запрет.
 * Промптов, вывода агента и содержимого файлов в журнале нет. Строка, не разбираемая
 * как JSON, при чтении пропускается.
 *
 * Градации, запреты и таблица статистики не хранятся, а вычисляются из журнала:
 * смена правил пересчитывает всю историю, снятие запрета — событие, а не правка файла.
 *
 * Градация — только у запуска исполнителя (стадия со скилом `execute-task`), первая
 * ступень, на которой остановилась его работа: `crashed`, `refused`, `stopped`,
 * `empty`, `artifacts_failed`, `review_failed`, `accepted`, `pending` (gradeRuns).
 * Неудача модели — `empty` и `artifacts_failed`; успех — пройденный контроль
 * артефактов (`artifacts_passed: true`), даже если потом не пройдено ревью.
 *
 * Запреты:
 *   - постоянный, модель + тип тикета, с последнего снятия (`unban` с этим типом):
 *     правило 1 — неудач ≥ 3 и ни одного успеха; правило 2 — не меньше 10 оценённых
 *     запусков и среди последних 10 успехов < 3 (permanentBans);
 *   - временный, модель целиком: последний запуск модели, кроме `stopped`, после
 *     последнего снятия (`unban` без типа) — сбой, и его TTL ещё не истёк (crashBans).
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
// Наибольшее время, которое представимо в Date (ECMAScript: ±8.64e15 мс).
const MAX_DATE_MS = 8.64e15;
export const ROUTER_RESTARTS = 2;

/**
 * Статусы запуска, которые считаются сбоем процесса. `aborted` — только без признака
 * остановки пайплайна (`stop_requested`, `interrupted`): агент снят сигналом мимо
 * остановки (решение 2026-09-27, вопрос 7: «Да, временный запрет»).
 */
const CRASH_STATUSES = new Set(['error', 'timeout', 'rate_limit', 'network_error', 'auth_error', 'aborted']);

export const GRADES = Object.freeze([
  'crashed', 'refused', 'stopped', 'empty', 'artifacts_failed', 'review_failed', 'accepted', 'pending',
]);

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

/** Статус запуска — сбой процесса (см. CRASH_STATUSES). */
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
  if (run.status === 'blocked') return { grade: 'refused', crashed_after_work: false, artifacts_passed: null };
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
    }
  }
  return runs.map(({ event, index, verify, review }) => {
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
 * последнего снятия (решение 2026-09-26, вопрос 1: «С десяти запусков»).
 * @returns {Array<{model, ticket_type, rule: 1|2, failures, successes, evidence}>}
 */
export function permanentBans(events) {
  const pairs = new Map();
  for (const { run, index } of gradeIndexed(events)) {
    if (!run.model || run.grade === 'stopped') continue;
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
 * исполнителя без градации `stopped` после последнего `unban` этой модели без типа
 * тикета — сбой (`crashed` или `crashed_after_work`) и `ts + crash_ttl_ms` позже `now`.
 * Тип тикета не учитывается. `stopped` пропускается: остановка `model_banned` — тоже
 * запуск этой модели, и без пропуска первая же остановка снимала бы запрет.
 * @returns {Array<{model, until: string, crash_ttl_ms: number, evidence}>}
 */
export function crashBans(events, now = Date.now()) {
  const lastByModel = new Map();
  for (const { run, index } of gradeIndexed(events)) {
    if (!run.model || run.grade === 'stopped') continue;
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

/** Действующие запреты: постоянные и временные. */
export function activeBans(events, now = Date.now()) {
  return { permanent: permanentBans(events), crash: crashBans(events, now) };
}

/**
 * Запрет модели для типа тикета или null. Постоянный — по паре, временный — на модель
 * целиком.
 */
export function findBan(bans, model, ticketType) {
  if (!bans || !model) return null;
  const permanent = bans.permanent.find((b) => b.model === model && (b.ticket_type ?? null) === (ticketType ?? null));
  if (permanent) return { kind: 'permanent', ...permanent };
  const crash = bans.crash.find((b) => b.model === model);
  if (crash) return { kind: 'crash', ...crash };
  return null;
}

/** Причина запрета одной строкой — для лога. */
export function describeBan(ban) {
  if (!ban) return '';
  if (ban.kind === 'crash') return `temporary ban until ${ban.until} (crash at ${ban.evidence[0]?.ts})`;
  return ban.rule === 1
    ? `permanent ban for type "${ban.ticket_type}" by rule 1 (${ban.failures} failures, 0 successes since last unban)`
    : `permanent ban for type "${ban.ticket_type}" by rule 2 (${ban.successes} successes in last ${RULE2_WINDOW} evaluated runs)`;
}

// ---------------------------------------------------------------------------
// Таблица статистики и снятие запрета — для MCP
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
      const crash = bans.crash.find((b) => b.model === row.model);
      if (crash) rowBans.push({ kind: 'crash', ...crash });
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
 * запрета пары, без него — временного запрета модели. Запрета нет — отказ, строка не
 * пишется.
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
