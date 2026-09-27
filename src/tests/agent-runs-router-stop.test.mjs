/**
 * Остановка kilo-агента при ответе запрещённой модели и перезапуск после неё
 * (PLAN-003, задачи 21–22; автотест задачи 23).
 *
 * Роутер kilo выбирает модель сам, и по ключу роутера агент при выборе не отсеять:
 * ответившая модель становится известна только из базы kilo, пока агент работает.
 * Поэтому на стадии исполнителя (скил `execute-task`) опрос базы снимает агента, как
 * только в его сессии ответила модель под запретом журнала `.workflow/metrics/agent-runs.jsonl`,
 * вызов отклоняется с `MODEL_BANNED`, и тот же агент заходит снова — новая сессия kilo,
 * роутер может выбрать другую модель. Не больше двух перезапусков, затем следующий
 * агент стадии.
 *
 * Что охраняется:
 *  - роутер всегда отвечает запрещённой моделью — три остановки (запуск и два
 *    перезапуска), каждая до конца работы фейкового kilo, затем выбран следующий агент
 *    стадии; так и при постоянном запрете пары «модель + тип тикета», и при временном
 *    запрете модели за сбой (он действует на модель целиком, при любом типе тикета);
 *  - роутер со второго запуска отвечает разрешённой моделью — стадию завершает этот же
 *    агент, следующий не вызывается;
 *  - переход к следующему агенту не блокируется изменёнными артефактами (`src/`): после
 *    остановки за модель прежний запрет fallback при непустом diff не действует;
 *  - агент не помечается нездоровым в `.workflow/state/agent-health.json`;
 *  - у каждого запуска после `MODEL_BANNED` своё событие `run` со статусом
 *    `model_banned` и свой `run_key`, равный `run_key` записи открытого запуска
 *    `.workflow/state/agent-run-open.json` на время этого запуска (фейковый kilo
 *    копирует запись в свой выходной файл);
 *  - на стадии не исполнителя тот же фейковый kilo с той же запрещённой моделью
 *    доходит до конца (решение 2026-09-26, вопрос 3: «Только исполнитель»).
 *
 * База kilo — временный SQLite в WAL со схемой, которую читает src/lib/kilo-models.mjs
 * (session: id, title, parent_id, model JSON; part: id, session_id, time_created, data),
 * как в src/tests/kilo-models.test.mjs. Фейковый kilo на каждом запуске берёт
 * следующую строку плана (модель шага, пауза до ответа, правка `src/`) по счётчику
 * запусков в управляющем каталоге. Управляющий каталог, база и фейковый kilo лежат
 * вне корня проекта: иначе попали бы в подсчёт изменённых файлов. Имена моделей и
 * агентов — нейтральные (директива PLAN-003 2026-09-26).
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-router-stop.test.mjs
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setKiloDbPathCache } from '../lib/kilo-models.mjs';
import {
  appendRunEvent, readRunEvents, permanentBans, crashBans, OPEN_RUN_FILE, ROUTER_RESTARTS,
} from '../lib/agent-runs.mjs';
import { isHealthy } from '../lib/agent-health-registry.mjs';
import { StageExecutor } from '../runner.mjs';

let sqlite = null;
try {
  process.removeAllListeners('warning');
  sqlite = await import('node:sqlite');
} catch {}
const skipNoSqlite = sqlite ? false : 'node:sqlite недоступен (Node < 22.5)';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runs-router-stop-'));
after(() => {
  setKiloDbPathCache();
  fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const BAD = 'model-bad';
const GOOD = 'model-good';
const ROUTER = 'router-agent';
const NEXT = 'agent-b';
// Пауза фейкового kilo до ответа у запуска, который должен быть снят: опрос раз в 50 мс
// видит шаг за доли секунды, а без остановки запуск закончился бы позже и оставил
// отметку done-<n>.
const HOLD_UNTIL_KILLED_MS = 10000;

// ---------------------------------------------------------------------------
// Фейковый kilo и следующий агент стадии
// ---------------------------------------------------------------------------

const BIN = path.join(BASE, 'bin');
fs.mkdirSync(BIN, { recursive: true });

/**
 * Фейковый kilo: управляющий каталог — FAKE_KILO_CTL (plan.json, counter). На запуске
 * n берёт строку плана launches[n-1] (последнюю, если запусков больше строк), копирует
 * запись открытого запуска в open-run-<n>.json, по флагу пишет src/work-<n>.txt,
 * создаёт корневую сессию с переданным --title и один шаг ответившей модели, ждёт
 * holdMs и только тогда пишет done-<n> и блок RESULT.
 */
function writeFakeKilo() {
  const script = path.join(BIN, 'kilo-stub.mjs');
  fs.writeFileSync(script, `
process.removeAllListeners('warning');
const fs = await import('node:fs');
const path = await import('node:path');
const { DatabaseSync } = await import('node:sqlite');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = process.env.FAKE_KILO_CTL;
const plan = JSON.parse(fs.readFileSync(path.join(ctl, 'plan.json'), 'utf8'));
const counterFile = path.join(ctl, 'counter');
const n = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1;
fs.writeFileSync(counterFile, String(n));
const launch = plan.launches[Math.min(n, plan.launches.length) - 1];
const args = process.argv.slice(2);
const title = args[args.indexOf('--title') + 1];
const openRun = path.join(process.cwd(), ${JSON.stringify(OPEN_RUN_FILE)});
fs.writeFileSync(path.join(ctl, 'open-run-' + n + '.json'), fs.existsSync(openRun) ? fs.readFileSync(openRun, 'utf8') : 'null');
if (launch.writeSrc) {
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync(path.join('src', 'work-' + n + '.txt'), 'launch ' + n + '\\n');
}
const db = new DatabaseSync(plan.db);
db.exec('PRAGMA busy_timeout = 5000;');
const sid = 'ses_' + n;
db.prepare('INSERT INTO session (id, title, parent_id, model) VALUES (?, ?, NULL, ?)')
  .run(sid, title, JSON.stringify({ id: plan.sessionModel, providerID: 'kilo' }));
db.prepare('INSERT INTO part (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
  .run(sid + '-p1', sid, Date.now(), JSON.stringify({ type: 'step-finish', reason: 'stop', model: { providerID: 'prov', modelID: launch.model } }));
db.close();
await sleep(launch.holdMs);
fs.writeFileSync(path.join(ctl, 'done-' + n), 'done');
process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');
`);
  if (process.platform === 'win32') {
    const cmd = path.join(BIN, 'kilo.cmd');
    fs.writeFileSync(cmd, `@node "%~dp0kilo-stub.mjs" %*\r\n`);
    return cmd;
  }
  const sh = path.join(BIN, 'kilo');
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "$(dirname "$0")/kilo-stub.mjs" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

/** Следующий агент стадии (не kilo): отмечает вызов и копирует запись открытого запуска. */
function writeNextAgent() {
  const script = path.join(BIN, 'next-agent.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
const ctl = process.env.FAKE_KILO_CTL;
const openRun = path.join(process.cwd(), ${JSON.stringify(OPEN_RUN_FILE)});
fs.writeFileSync(path.join(ctl, 'next-open-run.json'), fs.existsSync(openRun) ? fs.readFileSync(openRun, 'utf8') : 'null');
fs.writeFileSync(path.join(ctl, 'next-called'), 'called');
process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');
`);
  return script;
}

const FAKE_KILO = writeFakeKilo();
const NEXT_AGENT = writeNextAgent();

const AGENTS = {
  [ROUTER]: { command: FAKE_KILO, args: ['-m', 'kilo/router-x/free', '--agent', 'code', 'run', '--auto'], capabilities: ['text'] },
  [NEXT]: { command: 'node', args: [NEXT_AGENT], capabilities: ['text'] },
};

// ---------------------------------------------------------------------------
// Журнал-фикстура
// ---------------------------------------------------------------------------

const iso = (ms) => new Date(ms).toISOString();

/** Три запуска модели с проваленным контролем артефактов — постоянный запрет пары по правилу 1. */
function permanentBanJournal(model, ticketType) {
  const t0 = Date.now() - 3 * 60 * 60 * 1000;
  const events = [];
  for (let i = 1; i <= 3; i++) {
    const ticket = `${ticketType.toUpperCase()}-9${i}`;
    events.push({
      type: 'run', ts: iso(t0 + i * 60000), run_key: `seed-${i}`, pipeline_run: 'seed', stage: 'execute-task',
      skill: 'execute-task', ticket, ticket_type: ticketType, attempt: 1, agent: 'agent-z', requested: null,
      models: null, model, status: 'ok', exit_code: 0, changed_files: 2, duration_ms: 1000,
    });
    events.push({
      type: 'verify', ts: iso(t0 + i * 60000 + 1000), pipeline_run: 'seed', ticket, ticket_type: ticketType,
      status: 'failed', reason: null, dod_completion_pct: 50, result_filled: true, missing_files: ['src/x.mjs'],
      unchanged_files: [], evidence_file: null, dod_check_total: null, dod_check_failed: null,
      fail_reasons: ['missing_files'],
    });
  }
  return events;
}

/** Сбой запуска модели минуту назад — временный запрет модели целиком (TTL 1 ч). */
function crashBanJournal(model) {
  return [{
    type: 'run', ts: iso(Date.now() - 60000), run_key: 'seed-crash', pipeline_run: 'seed', stage: 'execute-task',
    skill: 'execute-task', ticket: 'IMPL-90', ticket_type: 'impl', attempt: 1, agent: 'agent-z', requested: null,
    models: null, model, status: 'error', exit_code: 1, changed_files: 0, duration_ms: 1000,
    crash_ttl_ms: 60 * 60 * 1000,
  }];
}

// ---------------------------------------------------------------------------
// Проект, исполнитель стадии, прогон
// ---------------------------------------------------------------------------

function makeLogger() {
  const lines = [];
  const push = (level) => (msg) => lines.push(`${level} ${msg}`);
  return {
    lines,
    info: push('INFO'), warn: push('WARN'), error: push('ERROR'),
    stageStart() {}, stageComplete() {}, cliCall() {}, timeout() {},
  };
}

let projectSeq = 0;

/**
 * Временный проект с тикетом, журналом-фикстурой и планом фейкового kilo.
 * `launches` — строки плана: { model, holdMs, writeSrc }.
 */
function makeProject({ ticketId, journal, launches }) {
  projectSeq += 1;
  const name = `p${projectSeq}`;
  const root = path.join(BASE, name);
  const ticketDir = path.join(root, '.workflow', 'tickets', 'in-progress');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `${ticketId}.md`), `---\nid: ${ticketId}\n---\n\n# Тикет\n`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.txt'), 'app\n');
  for (const event of journal) {
    const written = appendRunEvent(root, event);
    assert.ok(written.ok, `журнал-фикстура не записан: ${written.error}`);
  }

  const ctl = path.join(BASE, `${name}-ctl`);
  fs.mkdirSync(ctl, { recursive: true });
  const dbPath = path.join(BASE, `${name}-kilo.db`);
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT, model TEXT);
           CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);`);
  db.close();
  fs.writeFileSync(path.join(ctl, 'plan.json'), JSON.stringify({ db: dbPath, sessionModel: 'router-x/free', launches }));
  return { root, ctl, dbPath, ticketId, pipelineRun: `run-${name}` };
}

async function runStage(project, stage, { pollMs = 50 } = {}) {
  setKiloDbPathCache(project.dbPath);
  const logger = makeLogger();
  const config = {
    pipeline: {
      name: 'router-stop', version: '1.0', agents: AGENTS,
      // artifact_snapshot_enabled по умолчанию включён, область — src и configs: правка
      // src/ прежде блокировала бы переход к следующему агенту.
      execution: { timeout_per_stage: 30 },
      stages: {}, entry: 'none', context: {},
    },
  };
  const executor = new StageExecutor(config, {}, {}, {}, null, logger, project.root, { runId: project.pipelineRun });
  executor.context = { ticket_id: project.ticketId };
  executor.kiloModelsPollMs = pollMs;

  const saved = process.env.FAKE_KILO_CTL;
  process.env.FAKE_KILO_CTL = project.ctl;
  const started = Date.now();
  try {
    const result = await executor.executeWithFallback(stage.id, stage.def);
    return { result, logger, ms: Date.now() - started };
  } finally {
    if (saved === undefined) delete process.env.FAKE_KILO_CTL; else process.env.FAKE_KILO_CTL = saved;
  }
}

const EXECUTOR_STAGE = { id: 'execute-task', def: { agents: [ROUTER, NEXT], instructions: 'Выполни тикет', skill: 'execute-task' } };

function launches(project) {
  const file = path.join(project.ctl, 'counter');
  return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
}

const done = (project, n) => fs.existsSync(path.join(project.ctl, `done-${n}`));
const nextCalled = (project) => fs.existsSync(path.join(project.ctl, 'next-called'));

function openRunCopy(project, file) {
  const text = fs.readFileSync(path.join(project.ctl, file), 'utf8');
  const record = JSON.parse(text);
  assert.ok(record && typeof record.run_key === 'string', `в ${file} нет записи открытого запуска: ${text}`);
  return record;
}

/** События run этого прогона — без фикстуры. */
function stageRuns(project) {
  return readRunEvents(project.root).filter((e) => e.type === 'run' && e.pipeline_run === project.pipelineRun);
}

function logText(logger) {
  return logger.lines.join('\n');
}

const bannedLines = (logger) => logger.lines.filter((l) => l.startsWith('WARN MODEL_BANNED '));
const selectedLines = (logger) => logger.lines.filter((l) => l.startsWith('INFO Agent selected: '));

function assertNoHealthMark(project, logger) {
  assert.equal(isHealthy(project.root, ROUTER), true, 'агент роутера не помечен нездоровым');
  const healthFile = path.join(project.root, '.workflow', 'state', 'agent-health.json');
  if (fs.existsSync(healthFile)) {
    const health = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
    assert.equal(health.agents?.[ROUTER], undefined, `в agent-health.json есть отметка агента роутера: ${JSON.stringify(health)}`);
  }
  assert.ok(!logger.lines.some((l) => l.includes('marked unhealthy')), logText(logger));
}

/**
 * Три остановки (запуск и ROUTER_RESTARTS перезапусков), затем следующий агент:
 * общие проверки для постоянного и временного запрета.
 */
function assertThreeStopsThenNext(project, { result, logger }) {
  const stops = ROUTER_RESTARTS + 1;
  assert.equal(result.status, 'passed', logText(logger));
  assert.equal(result.agentId, NEXT, 'стадию завершил следующий агент');
  assert.ok(nextCalled(project), 'следующий агент стадии вызван');

  assert.equal(launches(project), stops, 'фейковый kilo запущен ровно три раза');
  for (let n = 1; n <= stops; n++) {
    assert.equal(done(project, n), false, `запуск ${n} снят до своего завершения`);
  }

  const banned = bannedLines(logger);
  assert.equal(banned.length, stops, `в логе три остановки:\n${logText(logger)}`);
  for (const line of banned) {
    assert.match(line, new RegExp(`agent="${ROUTER}" model="${BAD}"`));
  }
  const text = logText(logger);
  assert.match(text, /restart 1\/2/);
  assert.match(text, /restart 2\/2/);
  assert.match(text, /restarts exhausted, falling back in-stage/);

  const selected = selectedLines(logger);
  assert.deepEqual(
    selected.map((l) => l.match(/^INFO Agent selected: (\S+)/)[1]),
    [ROUTER, ROUTER, ROUTER, NEXT],
    'три захода агента роутера, затем следующий агент',
  );
  const lastBanned = logger.lines.lastIndexOf(banned.at(-1));
  const nextSelected = logger.lines.indexOf(selected.at(-1));
  assert.ok(nextSelected > lastBanned, 'следующий агент выбран после третьей остановки');

  const runs = stageRuns(project);
  assert.equal(runs.length, stops + 1, JSON.stringify(runs, null, 2));
  const bannedRuns = runs.slice(0, stops);
  for (const [i, event] of bannedRuns.entries()) {
    const n = i + 1;
    assert.equal(event.status, 'model_banned', `запуск ${n}: статус`);
    assert.equal(event.agent, ROUTER, `запуск ${n}: агент`);
    assert.equal(event.model, BAD, `запуск ${n}: модель — ответившая модель роутера`);
    assert.equal(event.stop_requested, undefined, `запуск ${n}: не остановка пайплайна`);
    assert.equal(event.crash_ttl_ms, undefined, `запуск ${n}: не сбой`);
    assert.equal(event.run_key, openRunCopy(project, `open-run-${n}.json`).run_key,
      `запуск ${n}: run_key события — run_key записи открытого запуска на время запуска`);
  }
  assert.equal(new Set(bannedRuns.map((e) => e.run_key)).size, stops, 'у каждого перезапуска свой run_key');

  const last = runs.at(-1);
  assert.equal(last.agent, NEXT);
  assert.equal(last.status, 'ok');
  assert.equal(last.run_key, openRunCopy(project, 'next-open-run.json').run_key);
  assert.ok(!bannedRuns.some((e) => e.run_key === last.run_key));

  assert.equal(fs.existsSync(path.join(project.root, OPEN_RUN_FILE)), false, 'запись открытого запуска снята');
  assertNoHealthMark(project, logger);
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

describe('остановка kilo-агента за запрещённую модель', { skip: skipNoSqlite }, () => {
  test('фикстуры журнала дают запреты, которые проверяет раннер', () => {
    const permanent = permanentBans(permanentBanJournal(BAD, 'impl'));
    assert.equal(permanent.length, 1);
    assert.equal(permanent[0].model, BAD);
    assert.equal(permanent[0].ticket_type, 'impl');
    assert.equal(permanent[0].rule, 1);
    const crash = crashBans(crashBanJournal(BAD));
    assert.equal(crash.length, 1);
    assert.equal(crash[0].model, BAD);
    assert.equal(ROUTER_RESTARTS, 2, 'число перезапусков из решения стейкхолдера');
  });

  test('роутер всегда отвечает запрещённой моделью (постоянный запрет): три остановки, затем следующий агент; правка src/ fallback не блокирует', async () => {
    const project = makeProject({
      ticketId: 'IMPL-1',
      journal: permanentBanJournal(BAD, 'impl'),
      launches: [{ model: BAD, holdMs: HOLD_UNTIL_KILLED_MS, writeSrc: true }],
    });
    const run = await runStage(project, EXECUTOR_STAGE);
    assertThreeStopsThenNext(project, run);

    // Артефакты изменены каждым снятым запуском, и переход всё равно состоялся.
    for (let n = 1; n <= 3; n++) {
      assert.ok(fs.existsSync(path.join(project.root, 'src', `work-${n}.txt`)), `запуск ${n} изменил src/`);
    }
    for (const event of stageRuns(project).slice(0, 3)) {
      assert.ok(event.changed_files >= 1, `изменения снятого запуска посчитаны: ${JSON.stringify(event)}`);
    }
    assert.ok(!run.logger.lines.some((l) => l.includes('fallback blocked')), logText(run.logger));
  });

  test('временный запрет модели за сбой действует при любом типе тикета: три остановки, затем следующий агент', async () => {
    const project = makeProject({
      ticketId: 'DOCS-1',
      journal: crashBanJournal(BAD),
      launches: [{ model: BAD, holdMs: HOLD_UNTIL_KILLED_MS, writeSrc: false }],
    });
    const run = await runStage(project, EXECUTOR_STAGE);
    assertThreeStopsThenNext(project, run);
    for (const event of stageRuns(project).slice(0, 3)) assert.equal(event.ticket_type, 'docs');
  });

  test('роутер со второго запуска отвечает разрешённой моделью: стадию завершает тот же агент', async () => {
    const project = makeProject({
      ticketId: 'IMPL-1',
      journal: permanentBanJournal(BAD, 'impl'),
      launches: [
        { model: BAD, holdMs: HOLD_UNTIL_KILLED_MS, writeSrc: true },
        { model: GOOD, holdMs: 300, writeSrc: false },
      ],
    });
    const { result, logger } = await runStage(project, EXECUTOR_STAGE);
    assert.equal(result.status, 'passed', logText(logger));
    assert.equal(result.agentId, ROUTER, 'стадию завершил агент роутера');
    assert.equal(nextCalled(project), false, 'следующий агент не вызывался');
    assert.equal(launches(project), 2);
    assert.equal(done(project, 1), false, 'первый запуск снят до завершения');
    assert.equal(done(project, 2), true, 'второй запуск дошёл до конца');

    assert.equal(bannedLines(logger).length, 1, logText(logger));
    assert.match(logText(logger), /restart 1\/2/);
    assert.doesNotMatch(logText(logger), /restarts exhausted/);
    assert.doesNotMatch(logText(logger), /fallback blocked/);

    const runs = stageRuns(project);
    assert.equal(runs.length, 2, JSON.stringify(runs, null, 2));
    assert.equal(runs[0].status, 'model_banned');
    assert.equal(runs[0].model, BAD);
    assert.equal(runs[0].run_key, openRunCopy(project, 'open-run-1.json').run_key);
    assert.equal(runs[1].status, 'ok');
    assert.equal(runs[1].agent, ROUTER);
    assert.equal(runs[1].model, GOOD);
    assert.equal(runs[1].run_key, openRunCopy(project, 'open-run-2.json').run_key);
    assert.notEqual(runs[0].run_key, runs[1].run_key, 'перезапуск получил новый run_key');
    assert.equal(fs.existsSync(path.join(project.root, OPEN_RUN_FILE)), false, 'запись открытого запуска снята');
    assertNoHealthMark(project, logger);
  });

  test('запрещённая модель ответила после последнего опроса: агент уже вышел, запуск — model_banned и перезапуск', async () => {
    const project = makeProject({
      ticketId: 'IMPL-1',
      journal: permanentBanJournal(BAD, 'impl'),
      launches: [
        { model: BAD, holdMs: 100, writeSrc: false },
        { model: GOOD, holdMs: 100, writeSrc: false },
      ],
    });
    // Опрос реже, чем живёт запуск: запрещённую модель видит только финальное чтение.
    const { result, logger } = await runStage(project, EXECUTOR_STAGE, { pollMs: 60000 });
    assert.equal(result.status, 'passed', logText(logger));
    assert.equal(result.agentId, ROUTER);
    assert.equal(launches(project), 2);
    assert.equal(done(project, 1), true, 'первый запуск завершился сам — снимать было нечего');
    assert.equal(nextCalled(project), false);
    const banned = bannedLines(logger);
    assert.equal(banned.length, 1, logText(logger));
    assert.match(banned[0], /agent already exited/);
    assert.match(logText(logger), /restart 1\/2/);

    const runs = stageRuns(project);
    assert.equal(runs.length, 2, JSON.stringify(runs, null, 2));
    assert.equal(runs[0].status, 'model_banned');
    assert.equal(runs[0].model, BAD);
    assert.equal(runs[1].status, 'ok');
    assert.equal(runs[1].model, GOOD);
    assertNoHealthMark(project, logger);
  });

  test('на стадии не исполнителя тот же фейковый kilo с запрещённой моделью доходит до конца', async () => {
    const project = makeProject({
      ticketId: 'IMPL-1',
      journal: permanentBanJournal(BAD, 'impl'),
      // Секунда при опросе раз в 50 мс — два десятка опросов с запрещённой моделью в базе.
      launches: [{ model: BAD, holdMs: 1000, writeSrc: false }],
    });
    const { result, logger } = await runStage(project, {
      id: 'create-report',
      def: { agents: [ROUTER, NEXT], instructions: 'Отчёт', skill: 'create-report' },
    });
    assert.equal(result.status, 'passed', logText(logger));
    assert.equal(result.agentId, ROUTER);
    assert.equal(launches(project), 1);
    assert.equal(done(project, 1), true, 'фейковый kilo дошёл до конца');
    assert.equal(nextCalled(project), false);
    assert.equal(bannedLines(logger).length, 0, logText(logger));
    assert.ok(logger.lines.some((l) => l.startsWith('INFO AGENT_MODELS ') && l.includes(BAD)), 'модель роутера прочитана из базы');

    const runs = stageRuns(project);
    assert.equal(runs.length, 1, JSON.stringify(runs, null, 2));
    assert.equal(runs[0].status, 'ok');
    assert.equal(runs[0].model, BAD);
    assert.equal(runs[0].skill, 'create-report');
  });
});
