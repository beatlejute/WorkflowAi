/**
 * Запись открытого запуска `.workflow/state/agent-run-open.json` в раннере (PLAN-003,
 * задачи 32–33).
 *
 * Раннер пишет файл до старта агента и удаляет после события `run` журнала
 * `.workflow/metrics/agent-runs.jsonl` с тем же `run_key`. Раннер, снятый без
 * обработчика (`taskkill /F`, `SIGKILL`), или упавший оставляет файл, и следующий старт
 * дописывает по нему событие `aborted` (задача 34). Если файл не пишется, прерванный
 * запуск в журнале не появится вовсе; если не удаляется или его `run_key` расходится с
 * событием, следующий старт допишет второе событие за уже записанный запуск.
 *
 * Что охраняется:
 *  - пока агент работает, файл есть и несёт поля из «Справочных данных → Запись
 *    открытого запуска»: `run_key`, `ts`, `pipeline_run`, `stage`, `skill`, `ticket`,
 *    `ticket_type`, `attempt`, `agent`, `requested`, `model`;
 *  - после успеха, ошибки процесса, fallback A → B, остановки `killCurrentChild()` и
 *    исключения без кода выхода файла нет;
 *  - у каждого события `run` свой `run_key`, равный `run_key` файла своего запуска
 *    (у следующего агента fallback — новый); у исключения без кода выхода события нет;
 *  - у kilo-агента `model` в файле — null (ответившей модели до старта нет, ключ из
 *    `-m` у роутера общий для нескольких агентов), даже когда модель запуска потом
 *    прочитана из базы kilo;
 *  - запуск без правок — `changed_files: 0` при записанном файле: и в проекте без git,
 *    и в проекте, где `.workflow/` не игнорируется git; правка одного файла — 1.
 *
 * Как тест видит файл во время работы: stub-агент копирует его в свой выходной файл вне
 * корня проекта (копия внутри корня сама стала бы правкой запуска). Фейковый kilo —
 * скрипт с именем `kilo`, как у настоящего создающий сессию с переданным `--title` во
 * временной базе SQLite (схема — как в src/tests/kilo-models.test.mjs). Корень — во
 * временном каталоге ОС, удаляется после каждого теста. Имена моделей и агентов —
 * нейтральные (директива PLAN-003 2026-09-26).
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-open.test.mjs
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { StageExecutor } from '../runner.mjs';
import { readRunEvents, OPEN_RUN_FILE } from '../lib/agent-runs.mjs';
import { setKiloDbPathCache } from '../lib/kilo-models.mjs';

let sqlite = null;
try {
  sqlite = await import('node:sqlite');
} catch {}
const skipNoSqlite = sqlite ? false : 'node:sqlite недоступен (Node < 22.5)';

const PIPELINE_RUN = 'run-open-test';
const TICKET = 'IMPL-7';
const STAGE = 'execute-task';
const OPEN_RUN_FIELDS = [
  'agent', 'attempt', 'model', 'pipeline_run', 'requested', 'run_key', 'skill', 'stage', 'ticket', 'ticket_type', 'ts',
].sort();
// Поля записи, которые событие `run` несёт без изменений (`model` события — ключ модели
// запуска, у kilo он другой; `ts` события — время завершения).
const SHARED_FIELDS = ['run_key', 'pipeline_run', 'stage', 'skill', 'ticket', 'ticket_type', 'attempt', 'agent', 'requested'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let base;
let root;
let binDir;
let outDir;
let stubSeq = 0;

function useProject() {
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runs-open-'));
    root = path.join(base, 'project');
    binDir = path.join(base, 'bin');
    outDir = path.join(base, 'out');
    const ticketDir = path.join(root, '.workflow', 'tickets', 'in-progress');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `${TICKET}.md`), `---\nid: ${TICKET}\ntype: impl\n---\n\n# Тикет\n`);
  });
  afterEach(() => {
    setKiloDbPathCache();
    const dir = base;
    base = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert.equal(fs.existsSync(dir), false, 'временный корень удалён');
  });
}

function openRunFile() {
  return path.join(root, ...OPEN_RUN_FILE.split('/'));
}

// Код, общий для stub-агентов: копия записи открытого запуска в выходной файл —
// атомарно (tmp + rename), чтобы опрос теста не прочитал её наполовину.
function copyCode(name) {
  const out = path.join(outDir, `${name}.json`);
  return `
import fs from 'node:fs';
let text = null;
try { text = fs.readFileSync(${JSON.stringify(openRunFile())}, 'utf8'); } catch {}
const copyOut = (extra = {}) => {
  fs.writeFileSync(${JSON.stringify(`${out}.tmp`)}, JSON.stringify({ text, ...extra }));
  fs.renameSync(${JSON.stringify(`${out}.tmp`)}, ${JSON.stringify(out)});
};
`;
}

/**
 * Stub-агент (node). `exitCode` — код выхода (0 — с блоком RESULT), `hold` — работает,
 * пока его не снимут (сам выходит через 20 с), `edit` — путь файла, который он правит.
 */
function writeStub(name, { exitCode = 0, hold = false, edit = null } = {}) {
  const file = path.join(binDir, `${name}-${++stubSeq}.mjs`);
  let body = copyCode(name);
  if (edit) body += `fs.writeFileSync(${JSON.stringify(edit)}, 'правка агента\\n');\n`;
  body += 'copyOut();\n';
  if (hold) {
    body += 'setTimeout(() => process.exit(0), 20000);\n';
  } else if (exitCode === 0) {
    body += "process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');\nprocess.exit(0);\n";
  } else {
    body += `process.stderr.write('agent failed\\n');\nprocess.exit(${exitCode});\n`;
  }
  fs.writeFileSync(file, body);
  return file;
}

/**
 * Фейковый kilo: копирует запись открытого запуска, при заданной базе создаёт в ней
 * сессию с переданным `--title` (модель сессии `model-a`) и один шаг без модели — как
 * kilo с фиксированной моделью — и отвечает блоком RESULT.
 */
function writeFakeKilo(name, dbPath = null) {
  const dir = path.join(binDir, `kilo-${++stubSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'kilo-stub.mjs');
  fs.writeFileSync(script, `${copyCode(name)}
const args = process.argv.slice(2);
const title = args.includes('--title') ? args[args.indexOf('--title') + 1] : null;
const DB = ${JSON.stringify(dbPath)};
if (DB) {
  process.removeAllListeners('warning');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.prepare('INSERT INTO session (id, title, parent_id, model) VALUES (?, ?, ?, ?)')
    .run('ses_k', title, null, JSON.stringify({ id: 'model-a', providerID: 'prov' }));
  db.prepare('INSERT INTO part (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    .run('ses_k-1', 'ses_k', Date.now(), JSON.stringify({ type: 'step-finish' }));
  db.close();
}
copyOut({ title });
process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');
`);
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'kilo.cmd');
    fs.writeFileSync(cmd, '@node "%~dp0kilo-stub.mjs" %*\r\n');
    return cmd;
  }
  const sh = path.join(dir, 'kilo');
  fs.writeFileSync(sh, '#!/bin/sh\nexec node "$(dirname "$0")/kilo-stub.mjs" "$@"\n');
  fs.chmodSync(sh, 0o755);
  return sh;
}

function makeKiloDb(file) {
  const db = new sqlite.DatabaseSync(file);
  // Как у настоящей базы kilo: в режиме WAL чтение раннера не блокирует запись агента.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT, model TEXT);
           CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);`);
  db.close();
}

/** Копия записи открытого запуска, снятая агентом во время работы, или null — агент не запускался. */
function readCopy(name) {
  const file = path.join(outDir, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  const { text, ...extra } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.notEqual(text, null, `пока агент ${name} работал, ${OPEN_RUN_FILE} был на месте`);
  return { record: JSON.parse(text), ...extra };
}

function makeLogger() {
  const lines = [];
  const push = (level) => (msg) => lines.push(`${level} ${msg}`);
  return {
    lines,
    info: push('INFO'), warn: push('WARN'), error: push('ERROR'),
    stageStart() {}, stageComplete() {}, cliCall() {}, timeout() {},
  };
}

function makeConfig(agents, execution = {}) {
  return {
    pipeline: {
      name: 'agent-runs-open', version: '1.0',
      agents,
      execution: { artifact_snapshot_enabled: false, timeout_per_stage: 30, ...execution },
      stages: {}, entry: 'none', context: {},
    },
  };
}

function makeExecutor(config, counters = {}) {
  const logger = makeLogger();
  const executor = new StageExecutor(config, { ticket_id: TICKET }, counters, {}, null, logger, root, { runId: PIPELINE_RUN });
  executor.kiloModelsPollMs = 50;
  return { executor, logger };
}

function stageOf(agents, extra = {}) {
  return { agents, instructions: 'Выполни тикет', skill: STAGE, ...extra };
}

function runEvents() {
  return readRunEvents(root).filter((event) => event.type === 'run');
}

function assertOpenRunGone(when) {
  assert.equal(fs.existsSync(openRunFile()), false, `после ${when} ${OPEN_RUN_FILE} нет`);
}

function assertNoJournalWarnings(logger) {
  const warnings = logger.lines.filter((line) => line.includes('agent-runs:'));
  assert.deepEqual(warnings, [], 'запись журнала и файла открытого запуска без WARN');
}

/** Поля записи открытого запуска по «Справочным данным». */
function assertRecord(record, expected) {
  assert.deepEqual(Object.keys(record).sort(), OPEN_RUN_FIELDS, 'запись открытого запуска — ровно поля из плана');
  assert.match(record.run_key, UUID_RE, 'run_key — UUID');
  assert.ok(Number.isFinite(Date.parse(record.ts)), `ts — время старта в ISO: ${record.ts}`);
  assert.equal(record.pipeline_run, PIPELINE_RUN);
  assert.equal(record.stage, STAGE);
  assert.equal(record.skill, STAGE);
  assert.equal(record.ticket, TICKET);
  assert.equal(record.ticket_type, 'impl');
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(record[key], value, `поле ${key}`);
}

/** Событие `run` — того же запуска, что и запись: `run_key` и общие поля совпадают. */
function assertEventOf(event, record) {
  assert.equal(event.type, 'run');
  assert.equal(event.run_key, record.run_key, 'run_key события — run_key файла своего запуска');
  for (const key of SHARED_FIELDS) assert.deepEqual(event[key], record[key], `поле ${key} события — как в записи`);
  assert.ok(Date.parse(event.ts) >= Date.parse(record.ts), 'событие записано после старта');
}

describe('запись открытого запуска: CLI-агент', () => {
  useProject();

  test('успех: во время работы файл есть со всеми полями, после — файла нет, событие с тем же run_key', async () => {
    const stub = writeStub('a');
    const config = makeConfig({ 'agent-a': { command: 'node', args: [stub, '--model', 'prov/model-a'], capabilities: ['text'] } });
    // Счётчик попыток 1 — вторая попытка: attempt записи берётся из выбора агента.
    const { executor, logger } = makeExecutor(config, { task_attempts: 1 });

    const result = await executor.executeWithFallback(STAGE, stageOf(['agent-a'], { counter: 'task_attempts' }));

    assert.equal(result.status, 'passed');
    const { record } = readCopy('a');
    assertRecord(record, { agent: 'agent-a', attempt: 2, requested: 'prov/model-a', model: 'prov/model-a' });
    assertOpenRunGone('успеха');
    const events = runEvents();
    assert.equal(events.length, 1, 'одно событие run');
    assertEventOf(events[0], record);
    assert.equal(events[0].status, 'ok');
    assert.equal(events[0].model, 'prov/model-a');
    assert.equal(events[0].changed_files, 0);
    assertNoJournalWarnings(logger);
  });

  test('ошибка процесса: событие error с run_key своего запуска, файла нет', async () => {
    const stub = writeStub('a', { exitCode: 1 });
    const config = makeConfig({ 'agent-a': { command: 'node', args: [stub], capabilities: ['text'] } });
    const { executor, logger } = makeExecutor(config);

    await assert.rejects(executor.executeWithFallback(STAGE, stageOf(['agent-a'])), /exited with code 1/);

    const { record } = readCopy('a');
    assertRecord(record, { agent: 'agent-a', attempt: 1, requested: null, model: 'agent-a' });
    assertOpenRunGone('ошибки процесса');
    const events = runEvents();
    assert.equal(events.length, 1, 'одно событие run');
    assertEventOf(events[0], record);
    assert.equal(events[0].status, 'error');
    assert.equal(events[0].exit_code, 1);
    assert.equal(typeof events[0].crash_ttl_ms, 'number', 'сбой несёт crash_ttl_ms');
    assertNoJournalWarnings(logger);
  });

  test('fallback A → B: у каждого запуска свой run_key, равный run_key файла своего запуска', async () => {
    // Снимок артефактов включён: без него ошибка A блокирует fallback. Область снимка —
    // `src`, агенты её не трогают, и история работы в тикете после A его не меняет.
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'keep.txt'), 'исходник\n');
    const config = makeConfig(
      {
        'agent-a': { command: 'node', args: [writeStub('a', { exitCode: 1 })], capabilities: ['text'] },
        'agent-b': { command: 'node', args: [writeStub('b')], capabilities: ['text'] },
      },
      { artifact_snapshot_enabled: true, snapshot_paths: ['src'] },
    );
    const { executor, logger } = makeExecutor(config);

    const result = await executor.executeWithFallback(STAGE, stageOf(['agent-a', 'agent-b']));

    assert.equal(result.status, 'passed', 'итог — от агента B');
    const a = readCopy('a').record;
    const b = readCopy('b').record;
    assertRecord(a, { agent: 'agent-a', attempt: 1 });
    assertRecord(b, { agent: 'agent-b', attempt: 1 });
    assert.notEqual(a.run_key, b.run_key, 'у следующего агента fallback — новый run_key');
    assertOpenRunGone('fallback');
    const events = runEvents();
    assert.deepEqual(events.map((e) => [e.agent, e.status]), [['agent-a', 'error'], ['agent-b', 'ok']]);
    assertEventOf(events[0], a);
    assertEventOf(events[1], b);
    assertNoJournalWarnings(logger);
  });

  test('остановка killCurrentChild: событие aborted со stop_requested и run_key своего запуска, файла нет', async () => {
    const config = makeConfig({
      'agent-a': { command: 'node', args: [writeStub('a', { hold: true })], capabilities: ['text'] },
      'agent-b': { command: 'node', args: [writeStub('b')], capabilities: ['text'] },
    });
    const { executor, logger } = makeExecutor(config);

    let settled = false;
    const stage = executor.executeWithFallback(STAGE, stageOf(['agent-a', 'agent-b']));
    stage.then(() => { settled = true; }, () => { settled = true; });
    try {
      const copy = path.join(outDir, 'a.json');
      for (let i = 0; i < 200 && !fs.existsSync(copy) && !settled; i++) await wait(25);
      assert.ok(fs.existsSync(copy), 'агент A запущен и снял копию записи');
      const started = Date.now();
      executor.killCurrentChild();
      await assert.rejects(stage);
      assert.ok(Date.now() - started < 10000, 'агент снят остановкой, а не собственным выходом через 20 с');
    } finally {
      // Упавшая проверка не должна оставить агента жить в удаляемом каталоге (EBUSY на Windows).
      if (!settled) {
        executor.killCurrentChild();
        await stage.catch(() => {});
      }
    }

    const { record } = readCopy('a');
    assertRecord(record, { agent: 'agent-a', attempt: 1 });
    assert.equal(readCopy('b'), null, 'следующий агент после остановки не запускался');
    assertOpenRunGone('остановки');
    const events = runEvents();
    assert.equal(events.length, 1, 'одно событие run');
    assertEventOf(events[0], record);
    assert.equal(events[0].status, 'aborted');
    assert.equal(events[0].stop_requested, true);
    assert.equal('crash_ttl_ms' in events[0], false, 'остановка пайплайна — не сбой');
    assertNoJournalWarnings(logger);
  });

  test('исключение без кода выхода: события нет, файл всё равно удалён', async () => {
    const config = makeConfig({ 'agent-a': { command: 'node', args: ['unused.mjs'], capabilities: ['text'] } });
    const { executor, logger } = makeExecutor(config);
    let during = null;
    executor.callAgent = async () => {
      during = fs.existsSync(openRunFile()) ? JSON.parse(fs.readFileSync(openRunFile(), 'utf8')) : null;
      throw new Error('boom without exit code');
    };

    await assert.rejects(executor.executeWithFallback(STAGE, stageOf(['agent-a'])), /boom without exit code/);

    assert.notEqual(during, null, 'во время вызова файл был на месте');
    assertRecord(during, { agent: 'agent-a', attempt: 1 });
    assertOpenRunGone('исключения');
    assert.deepEqual(runEvents(), [], 'у исключения без кода выхода события run нет');
    assertNoJournalWarnings(logger);
  });
});

describe('запись открытого запуска: kilo-агент', () => {
  useProject();

  test('model в файле — null, requested — из -m; событие с тем же run_key', async () => {
    // `kilo db path` не дал путь базы: модель запуска не прочитана.
    setKiloDbPathCache(null);
    const kilo = writeFakeKilo('k');
    const config = makeConfig({ 'agent-k': { command: kilo, args: ['-m', 'prov/model-a', 'run', '--auto'], capabilities: ['text'] } });
    const { executor, logger } = makeExecutor(config);

    const result = await executor.executeWithFallback(STAGE, stageOf(['agent-k']));

    assert.equal(result.status, 'passed');
    const { record, title } = readCopy('k');
    assert.match(title, /^workflow-/, 'агент — kilo-запуск с меткой сессии');
    assertRecord(record, { agent: 'agent-k', attempt: 1, requested: 'prov/model-a', model: null });
    assertOpenRunGone('kilo-запуска');
    const events = runEvents();
    assert.equal(events.length, 1);
    assertEventOf(events[0], record);
    assert.equal(events[0].model, null, 'модель kilo не прочитана — null, ключ из -m не подставляется');
    assert.equal(events[0].changed_files, 0);
    assertNoJournalWarnings(logger);
  });

  test('с базой kilo: в файле model null, в событии — модель, прочитанная после запуска', { skip: skipNoSqlite }, async () => {
    const dbPath = path.join(base, 'kilo.db');
    makeKiloDb(dbPath);
    setKiloDbPathCache(dbPath);
    const kilo = writeFakeKilo('k', dbPath);
    const config = makeConfig({ 'agent-k': { command: kilo, args: ['-m', 'prov/model-a', 'run', '--auto'], capabilities: ['text'] } });
    const { executor, logger } = makeExecutor(config);

    const result = await executor.executeWithFallback(STAGE, stageOf(['agent-k']));

    assert.equal(result.status, 'passed');
    const { record } = readCopy('k');
    assertRecord(record, { agent: 'agent-k', requested: 'prov/model-a', model: null });
    assertOpenRunGone('kilo-запуска');
    const events = runEvents();
    assert.equal(events.length, 1);
    assertEventOf(events[0], record);
    assert.equal(events[0].model, 'model-a', 'модель запуска — из базы kilo');
    assert.deepEqual(events[0].models, [{ model: 'model-a', steps: 1 }]);
    assertNoJournalWarnings(logger);
  });
});

describe('changed_files запуска при записанном файле открытого запуска', () => {
  useProject();

  async function runOnce(name, { edit = null } = {}) {
    const config = makeConfig({ [`agent-${name}`]: { command: 'node', args: [writeStub(name, { edit })], capabilities: ['text'] } });
    const { executor, logger } = makeExecutor(config);
    await executor.executeWithFallback(STAGE, stageOf([`agent-${name}`]));
    const { record } = readCopy(name);
    const event = runEvents().find((e) => e.run_key === record.run_key);
    assert.ok(event, `событие run запуска ${name} записано`);
    assertOpenRunGone(`запуска ${name}`);
    assertNoJournalWarnings(logger);
    return event;
  }

  test('проект без git: без правок — 0, правка одного файла — 1', async () => {
    assert.equal((await runOnce('a')).changed_files, 0, 'запись открытого запуска в changed_files не входит');
    assert.equal((await runOnce('b', { edit: path.join(root, 'notes.txt') })).changed_files, 1, 'контроль: правка считается');
  });

  test('проект в git, .workflow/ не игнорируется: без правок — 0, правка одного файла — 1', async () => {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    git('init', '-q');
    // Глобальные исключения машины не должны скрыть .workflow/ от git.
    const excludes = path.join(base, 'no-excludes');
    fs.writeFileSync(excludes, '');
    git('config', 'core.excludesFile', excludes);
    let ignored = true;
    try {
      git('check-ignore', '-q', OPEN_RUN_FILE);
    } catch (err) {
      ignored = err.status !== 1;
    }
    assert.equal(ignored, false, `${OPEN_RUN_FILE} git не игнорирует`);

    assert.equal((await runOnce('a')).changed_files, 0, 'запись открытого запуска в changed_files не входит');
    assert.equal((await runOnce('b', { edit: path.join(root, 'notes.txt') })).changed_files, 1, 'контроль: правка считается');
  });
});
