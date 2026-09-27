/**
 * Событие `run` журнала запусков `.workflow/metrics/agent-runs.jsonl` из
 * StageExecutor.executeWithFallback (src/runner.mjs, PLAN-003 задачи 8–9).
 *
 * Журнал — основа отсева плохих моделей: по событиям `run` считаются градации
 * исполнителя и запреты «модель + тип тикета» (src/lib/agent-runs.mjs). Неверный
 * ключ модели запрещает не ту модель, `changed_files`, посчитанный после записи
 * раннера в тикет, никогда не даёт градацию «пусто», а неверный `crash_ttl_ms`
 * держит временный запрет не тот срок.
 *
 * Что охраняется:
 *  - успех: все поля события (run_key, pipeline_run, stage, skill, ticket, ticket_type,
 *    attempt, agent, requested, models, model, status, exit_code, changed_files,
 *    duration_ms), без crash_ttl_ms и stop_requested; запись открытого запуска снята;
 *  - ключ модели агента не kilo — значение `--model` как есть, без модели в args —
 *    id агента;
 *  - ошибка процесса: класс classifyAgentResult, код выхода, crash_ttl_ms — TTL
 *    сработавшего правила health, без правила — 1 час;
 *  - fallback A (упал) → B (успех): две строки `run` с разными run_key;
 *  - kilo-агент: модель — модель последнего шага корневой сессии, models — все
 *    ответившие; сессия без шагов — model: null;
 *  - агент стадии с model_io: модель из ответа (важнее `--model` записи агента), без
 *    поля в ответе — `--model`; changed_files: null; одно событие на агента, а не на
 *    вопрос;
 *  - стадия без тикета — ticket: null;
 *  - агент без правок — changed_files: 0, хотя строка истории работы тикета записана
 *    (снимок «после» — до записей раннера), в проекте без git и в git.
 *
 * Корень — временный проект с тикетом в os.tmpdir(), снимается в afterEach. База kilo —
 * временный SQLite в режиме WAL вне корня проекта (иначе файлы базы попали бы в
 * changed_files); фейковый kilo, как настоящий, создаёт сессию с переданным `--title`.
 * Имена моделей и агентов — нейтральные (директива PLAN-003 2026-09-26).
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-runner.test.mjs
 */

import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { StageExecutor } from '../runner.mjs';
import { parseAgentHistory } from '../lib/agent-history.mjs';
import { setKiloDbPathCache } from '../lib/kilo-models.mjs';
import { CRASH_TTL_DEFAULT_MS } from '../lib/agent-runs.mjs';

const MOCK_JUDGE = fileURLToPath(new URL('./fixtures/mock-judge-raw.js', import.meta.url));
const RUN_ID = 'pipeline-run-test-1';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let sqlite = null;
try {
  process.removeAllListeners('warning');
  sqlite = await import('node:sqlite');
} catch {}
const skipNoSqlite = sqlite ? false : 'node:sqlite недоступен (Node < 22.5)';

let gitAvailable = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
  gitAvailable = true;
} catch {}

const TEMPS = [];
afterEach(() => {
  setKiloDbPathCache();
  for (const dir of TEMPS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Правило health с TTL, отличным и от 1 часа по умолчанию, и от 5m классов ошибок модели.
const RULES_YAML = `version: "1.0"
common:
  - id: "net-reset-test"
    class: "transient"
    ttl: "10m"
    pattern: "ECONNRESET"
    exit_codes: "any"
`;

/** Временный каталог: `project/` — корень проекта с тикетом, `outside/` — всё, что вне него. */
function makeProject({ ticket = true, rules = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runs-runner-'));
  TEMPS.push(base);
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  let ticketPath = null;
  if (ticket) {
    const dir = path.join(root, '.workflow', 'tickets', 'in-progress');
    fs.mkdirSync(dir, { recursive: true });
    ticketPath = path.join(dir, 'IMPL-1.md');
    fs.writeFileSync(ticketPath, '---\nid: IMPL-1\ntype: impl\n---\n\n# Тикет\n\n## Описание\n\nПроверка журнала.\n');
  }
  if (rules) {
    const dir = path.join(root, '.workflow', 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-health-rules.yaml'), RULES_YAML);
  }
  return { base, root, outside, ticketPath };
}

/**
 * Stub-агент (node). `writes` — файлы (от корня проекта), которые он создаёт;
 * `stderr`, `exit` — вывод ошибки и код выхода; без ошибки — блок RESULT.
 * Скрипт лежит вне корня: его файл не должен попадать в подсчёт.
 */
function writeStub(outside, name, { writes = [], stderr = '', exit = 0, result = 'passed' } = {}) {
  const file = path.join(outside, `${name}.mjs`);
  fs.writeFileSync(file, `import fs from 'node:fs';
import path from 'node:path';
for (const rel of ${JSON.stringify(writes)}) {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, 'written by ${name}');
}
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}
${exit === 0 ? `process.stdout.write('---RESULT---\\nstatus: ${result}\\n---RESULT---\\n');` : ''}
process.exit(${exit});
`);
  return file;
}

function makeConfig(agents) {
  return {
    pipeline: {
      name: 'agent-runs-runner', version: '1.0',
      agents,
      // Снимок артефактов — по умолчанию (src, configs): упавший агент без правок в
      // них даёт fallback на следующего агента.
      execution: { artifact_snapshot_enabled: true, timeout_per_stage: 60 },
      stages: {}, entry: 'none', context: {},
    },
  };
}

function captureLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG'),
    stageStart() {}, stageComplete() {}, timeout() {}, cliCall() {},
  };
}

function makeExecutor(root, agents, context = { ticket_id: 'IMPL-1' }) {
  const logger = captureLogger();
  const executor = new StageExecutor(makeConfig(agents), context, {}, {}, null, logger, root, { runId: RUN_ID });
  executor.kiloModelsPollMs = 50;
  return { executor, logger };
}

function readEvents(root) {
  const file = path.join(root, '.workflow', 'metrics', 'agent-runs.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function runEvents(root) {
  return readEvents(root).filter((e) => e.type === 'run');
}

function openRunExists(root) {
  return fs.existsSync(path.join(root, '.workflow', 'state', 'agent-run-open.json'));
}

const EXECUTOR_STAGE = (agents) => ({ agents, instructions: 'Выполни тикет', skill: 'execute-task' });

// ---------------------------------------------------------------------------

describe('событие run: успех, ошибка, fallback', () => {
  test('успех: все поля события, ключ модели не kilo — --model как есть, запись открытого запуска снята', async () => {
    const { root, outside } = makeProject();
    const stub = writeStub(outside, 'agent-a', { writes: ['out/result.txt'] });
    const { executor } = makeExecutor(root, {
      'agent-a': { command: 'node', args: [stub, '--model', 'prov/model-b'], capabilities: ['text'] },
    });

    const started = Date.now();
    const result = await executor.executeWithFallback('execute-task', EXECUTOR_STAGE(['agent-a']));
    assert.equal(result.status, 'passed');

    const events = runEvents(root);
    assert.equal(events.length, 1, JSON.stringify(events));
    const [event] = events;
    const { ts, run_key: runKey, duration_ms: durationMs, ...rest } = event;
    assert.match(ts, ISO_RE);
    assert.ok(Date.parse(ts) >= started - 1000 && Date.parse(ts) <= Date.now() + 1000, `ts в окне запуска: ${ts}`);
    assert.match(runKey, UUID_RE);
    assert.ok(Number.isInteger(durationMs) && durationMs >= 0, `duration_ms: ${durationMs}`);
    assert.deepEqual(rest, {
      type: 'run',
      pipeline_run: RUN_ID,
      stage: 'execute-task',
      skill: 'execute-task',
      ticket: 'IMPL-1',
      ticket_type: 'impl',
      attempt: 1,
      agent: 'agent-a',
      requested: 'prov/model-b',
      models: null,
      model: 'prov/model-b',
      status: 'ok',
      exit_code: 0,
      changed_files: 1,
    });
    assert.ok(!('crash_ttl_ms' in event), 'у успеха нет crash_ttl_ms');
    assert.ok(!('stop_requested' in event), 'stop_requested только у остановки пайплайна');
    assert.ok(!('interrupted' in event), 'interrupted только у события следующего старта');
    assert.equal(openRunExists(root), false, 'запись открытого запуска удалена после события');
  });

  test('ошибка процесса без правила health: класс error, код выхода, crash_ttl_ms — 1 час', async () => {
    const { root, outside } = makeProject();
    const stub = writeStub(outside, 'agent-a', { stderr: 'boom: something broke\n', exit: 1 });
    const { executor } = makeExecutor(root, {
      'agent-a': { command: 'node', args: [stub, '--model', 'prov/model-a'], capabilities: ['text'] },
    });

    await assert.rejects(
      () => executor.executeWithFallback('execute-task', EXECUTOR_STAGE(['agent-a'])),
      (err) => err.exitCode === 1,
    );

    const events = runEvents(root);
    assert.equal(events.length, 1, JSON.stringify(events));
    const [event] = events;
    assert.equal(event.agent, 'agent-a');
    assert.equal(event.model, 'prov/model-a');
    assert.equal(event.status, 'error');
    assert.equal(event.exit_code, 1);
    assert.equal(event.changed_files, 0);
    assert.equal(event.crash_ttl_ms, CRASH_TTL_DEFAULT_MS);
    assert.equal(CRASH_TTL_DEFAULT_MS, 60 * 60 * 1000);
    assert.ok(!('stop_requested' in event));
    assert.equal(openRunExists(root), false);
  });

  test('fallback A (упал по правилу health) → B (успех): две строки run; crash_ttl_ms A — TTL правила', async () => {
    const { root, outside, ticketPath } = makeProject();
    const failing = writeStub(outside, 'agent-a', { stderr: 'read ECONNRESET\n', exit: 1 });
    const ok = writeStub(outside, 'agent-b');
    const { executor, logger } = makeExecutor(root, {
      'agent-a': { command: 'node', args: [failing, '--model', 'prov/model-a'], capabilities: ['text'] },
      // Без модели в args — ключ модели — id агента.
      'agent-b': { command: 'node', args: [ok], capabilities: ['text'] },
    });

    const result = await executor.executeWithFallback('execute-task', EXECUTOR_STAGE(['agent-a', 'agent-b']));
    assert.equal(result.status, 'passed', logger.lines.join('\n'));

    const events = runEvents(root);
    assert.equal(events.length, 2, JSON.stringify(events));
    const [a, b] = events;
    assert.equal(a.agent, 'agent-a');
    assert.equal(a.model, 'prov/model-a');
    assert.equal(a.requested, 'prov/model-a');
    assert.equal(a.status, 'error');
    assert.equal(a.exit_code, 1);
    assert.equal(a.changed_files, 0);
    assert.equal(a.crash_ttl_ms, 10 * 60 * 1000, 'TTL сработавшего правила net-reset-test (10m)');

    assert.equal(b.agent, 'agent-b');
    assert.equal(b.model, 'agent-b');
    assert.equal(b.requested, null);
    assert.equal(b.status, 'ok');
    assert.equal(b.exit_code, 0);
    assert.equal(b.changed_files, 0);
    assert.ok(!('crash_ttl_ms' in b));

    assert.notEqual(a.run_key, b.run_key, 'у каждого запуска свой run_key');
    for (const e of events) {
      assert.equal(e.pipeline_run, RUN_ID);
      assert.equal(e.ticket, 'IMPL-1');
      assert.equal(e.ticket_type, 'impl');
      assert.equal(e.attempt, 1);
      assert.equal(e.skill, 'execute-task');
    }
    assert.ok(Date.parse(a.ts) <= Date.parse(b.ts), 'события в порядке запусков');

    const history = parseAgentHistory(fs.readFileSync(ticketPath, 'utf8'));
    assert.deepEqual(history.map((h) => [h.agent, h.status]), [['agent-a', 'error'], ['agent-b', 'ok']]);
    assert.equal(openRunExists(root), false);
  });
});

describe('changed_files и тикет', () => {
  for (const mode of ['walk', 'git']) {
    test(`агент без правок — changed_files: 0, строка истории работы тикета записана (${mode === 'git' ? 'проект в git' : 'проект без git'})`,
      { skip: mode === 'git' && !gitAvailable && 'git недоступен' },
      async () => {
        const { root, outside, ticketPath } = makeProject();
        if (mode === 'git') {
          execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', windowsHide: true });
          fs.writeFileSync(path.join(root, 'README.md'), '# проект\n');
        }
        const before = fs.readFileSync(ticketPath, 'utf8');
        const stub = writeStub(outside, 'agent-idle');
        const { executor } = makeExecutor(root, {
          'agent-idle': { command: 'node', args: [stub, '--model', 'prov/model-a'], capabilities: ['text'] },
        });

        const result = await executor.executeWithFallback('execute-task', EXECUTOR_STAGE(['agent-idle']));
        assert.equal(result.status, 'passed');

        const after = fs.readFileSync(ticketPath, 'utf8');
        assert.notEqual(after, before, 'раннер дописал тикет');
        const history = parseAgentHistory(after);
        assert.equal(history.length, 1, after);
        assert.equal(history[0].agent, 'agent-idle');
        assert.equal(history[0].status, 'ok');

        const events = runEvents(root);
        assert.equal(events.length, 1);
        assert.equal(events[0].changed_files, 0,
          'снимок «после» — до строки истории работы и записей .workflow/metrics/');
        assert.equal(events[0].status, 'ok');
      });
  }

  test('агент правит тикет — changed_files считает тикет', async () => {
    const { root, outside } = makeProject();
    const stub = writeStub(outside, 'agent-t', { writes: ['.workflow/tickets/in-progress/IMPL-1.md'] });
    const { executor } = makeExecutor(root, {
      'agent-t': { command: 'node', args: [stub], capabilities: ['text'] },
    });
    await executor.executeWithFallback('execute-task', EXECUTOR_STAGE(['agent-t']));
    const [event] = runEvents(root);
    assert.equal(event.changed_files, 1);
  });

  test('стадия без тикета — ticket: null, ticket_type: null, событие есть, истории нет', async () => {
    const { root, outside } = makeProject({ ticket: false });
    const stub = writeStub(outside, 'agent-r');
    const { executor } = makeExecutor(root, {
      'agent-r': { command: 'node', args: [stub, '-m', 'prov/model-r'], capabilities: ['text'] },
    }, {});

    const result = await executor.executeWithFallback('create-report', { agents: ['agent-r'], instructions: 'Отчёт', skill: 'create-report' });
    assert.equal(result.status, 'passed');

    const events = runEvents(root);
    assert.equal(events.length, 1, JSON.stringify(events));
    const [event] = events;
    assert.equal(event.ticket, null);
    assert.equal(event.ticket_type, null);
    assert.equal(event.stage, 'create-report');
    assert.equal(event.skill, 'create-report');
    assert.equal(event.agent, 'agent-r');
    assert.equal(event.model, 'prov/model-r', '-m у агента не kilo — тоже как есть');
    assert.equal(event.status, 'ok');
    assert.equal(event.changed_files, 0);
    assert.ok(!fs.existsSync(path.join(root, '.workflow', 'tickets')), 'тикетов нет — и истории нет');
  });
});

// ---------------------------------------------------------------------------

describe('kilo-агент: модель последнего шага', { skip: skipNoSqlite }, () => {
  function makeKiloDb(outside) {
    const dbPath = path.join(outside, 'kilo.db');
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT, model TEXT);
             CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);`);
    db.close();
    return dbPath;
  }

  // Фейковый kilo: сессия с переданным --title и моделью сессии FAKE_KILO_SESSION_MODEL
  // (JSON или пусто); шаги FAKE_KILO_STEPS — JSON-массив { session, model|null, parent? }
  // в порядке времени; ответ — блок RESULT.
  function writeFakeKilo(dir) {
    const script = path.join(dir, 'kilo-stub.mjs');
    fs.writeFileSync(script, `
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');
const args = process.argv.slice(2);
const title = args[args.indexOf('--title') + 1];
const db = new DatabaseSync(process.env.FAKE_KILO_DB);
db.exec('PRAGMA busy_timeout = 5000;');
const sessionModel = process.env.FAKE_KILO_SESSION_MODEL || null;
const steps = JSON.parse(process.env.FAKE_KILO_STEPS);
const rootId = 'ses_root_' + process.pid;
db.prepare('INSERT INTO session (id, title, parent_id, model) VALUES (?, ?, ?, ?)').run(rootId, title, null, sessionModel);
const sessions = new Set([rootId]);
let n = 0;
const base = Date.now();
for (const s of steps) {
  const sid = s.parent ? s.session : rootId;
  if (!sessions.has(sid)) {
    sessions.add(sid);
    db.prepare('INSERT INTO session (id, title, parent_id, model) VALUES (?, ?, ?, ?)').run(sid, 'subagent', rootId, null);
  }
  const data = s.model ? { type: 'step-finish', model: { providerID: 'prov', modelID: s.model } } : { type: 'step-finish' };
  n++;
  db.prepare('INSERT INTO part (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(sid + '-' + n, sid, base + n, JSON.stringify(data));
}
db.close();
process.stdout.write('---RESULT---\\nstatus: default\\n---RESULT---\\n');
`);
    if (process.platform === 'win32') {
      const cmd = path.join(dir, 'kilo.cmd');
      fs.writeFileSync(cmd, `@node "%~dp0kilo-stub.mjs" %*\r\n`);
      return cmd;
    }
    const sh = path.join(dir, 'kilo');
    fs.writeFileSync(sh, `#!/bin/sh\nexec node "$(dirname "$0")/kilo-stub.mjs" "$@"\n`);
    fs.chmodSync(sh, 0o755);
    return sh;
  }

  async function runFakeKilo({ requested, sessionModel, steps }) {
    const { root, outside } = makeProject();
    const dbPath = makeKiloDb(outside);
    setKiloDbPathCache(dbPath);
    const bin = path.join(outside, 'bin');
    fs.mkdirSync(bin);
    const fakeKilo = writeFakeKilo(bin);
    const saved = {
      FAKE_KILO_DB: process.env.FAKE_KILO_DB,
      FAKE_KILO_STEPS: process.env.FAKE_KILO_STEPS,
      FAKE_KILO_SESSION_MODEL: process.env.FAKE_KILO_SESSION_MODEL,
    };
    process.env.FAKE_KILO_DB = dbPath;
    process.env.FAKE_KILO_STEPS = JSON.stringify(steps);
    process.env.FAKE_KILO_SESSION_MODEL = sessionModel ? JSON.stringify({ id: sessionModel, providerID: 'prov' }) : '';
    try {
      const { executor, logger } = makeExecutor(root, {
        'agent-k': { command: fakeKilo, args: ['-m', requested, '--agent', 'code', 'run', '--auto'], capabilities: ['text'] },
      });
      const result = await executor.executeWithFallback('execute-task', EXECUTOR_STAGE(['agent-k']));
      return { root, result, logger };
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }

  test('роутер: model — модель последнего шага корневой сессии, models — все ответившие', async () => {
    const { root, result, logger } = await runFakeKilo({
      requested: 'kilo/router-x/free',
      sessionModel: 'router-x/free',
      steps: [
        { model: 'model-a' },
        { model: 'model-b' },
        { session: 'ses_sub', parent: true, model: 'model-d' },
        { model: 'model-a' },
        { model: 'model-c' },
      ],
    });
    assert.equal(result.status, 'default', logger.lines.join('\n'));

    const events = runEvents(root);
    assert.equal(events.length, 1, JSON.stringify(events));
    const [event] = events;
    assert.equal(event.agent, 'agent-k');
    assert.equal(event.requested, 'kilo/router-x/free');
    assert.equal(event.model, 'model-c', 'последний шаг корневой сессии, не роутер и не самая частая модель');
    assert.deepEqual(event.models, [
      { model: 'model-a', steps: 2 },
      { model: 'model-b', steps: 1 },
      { model: 'model-c', steps: 1 },
      { model: 'model-d', steps: 1 },
    ]);
    assert.equal(event.status, 'ok');
    assert.equal(event.exit_code, 0);
    assert.equal(event.changed_files, 0, 'база kilo вне корня проекта, агент файлов не менял');
    assert.equal(event.ticket, 'IMPL-1');
    assert.equal(openRunExists(root), false);
  });

  test('сессия без шагов — model: null, ключ из args не подставляется', async () => {
    const { root, logger } = await runFakeKilo({
      requested: 'kilo/router-x/free',
      sessionModel: 'router-x/free',
      steps: [],
    });
    const events = runEvents(root);
    assert.equal(events.length, 1, JSON.stringify(events));
    const [event] = events;
    assert.equal(event.agent, 'agent-k');
    assert.equal(event.requested, 'kilo/router-x/free');
    assert.equal(event.model, null, logger.lines.join('\n'));
    assert.ok(event.models === null || (Array.isArray(event.models) && event.models.length === 0),
      `models без шагов: ${JSON.stringify(event.models)}`);
    assert.equal(event.status, 'ok');
  });
});

// ---------------------------------------------------------------------------

describe('агент стадии с model_io', () => {
  // prepare — два вопроса по пять уровней (агент с командой запускается на каждый);
  // apply — passed.
  const PREPARE = `import fs from 'node:fs';
fs.mkdirSync('.workflow/tmp', { recursive: true });
const levels = ['l1', 'l2', 'l3', 'l4', 'l5'];
fs.writeFileSync('.workflow/tmp/request.json', JSON.stringify({
  data: 'данные',
  questions: [{ id: 'q-1', text: 'Первый?', levels }, { id: 'q-2', text: 'Второй?', levels }],
}));
console.log('---RESULT---\\nstatus: ready\\nrequest_file: .workflow/tmp/request.json\\n---RESULT---');
`;
  const APPLY = `console.log('---RESULT---\\nstatus: passed\\n---RESULT---');`;

  // mock-judge-raw.js печатает первый аргумент как ответ; `--model` — запрос конфига.
  const judge = (answer, model = 'prov/model-cfg') =>
    ({ command: 'node', args: [MOCK_JUDGE, answer, '--model', model], capabilities: ['text'] });

  async function runModelIo(answer, extraAgents = {}) {
    const { root, ticketPath } = makeProject();
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'prepare.mjs'), PREPARE);
    fs.writeFileSync(path.join(root, 'scripts', 'apply.mjs'), APPLY);
    const { executor, logger } = makeExecutor(root, { 'judge-a': judge(answer), ...extraAgents });
    const stage = {
      agents: ['judge-a', ...Object.keys(extraAgents)],
      model_io: { prepare: 'scripts/prepare.mjs', apply: 'scripts/apply.mjs' },
    };
    const result = await executor.executeWithFallback('review-result', stage);
    return { root, ticketPath, result, logger };
  }

  test('model — из ответа модели, changed_files: null, одно событие на два вопроса', async () => {
    const { root, ticketPath, result, logger } = await runModelIo('score: 4\nmodel: prov/model-j');
    assert.equal(result.status, 'passed', logger.lines.join('\n'));
    assert.equal(result.modelIo?.model, 'prov/model-j');

    const events = runEvents(root);
    assert.equal(events.length, 1, `одно событие на агента, а не на вопрос: ${JSON.stringify(events)}`);
    const [event] = events;
    assert.equal(event.agent, 'judge-a');
    assert.equal(event.stage, 'review-result');
    assert.equal(event.skill, null);
    assert.equal(event.requested, 'prov/model-cfg');
    assert.equal(event.model, 'prov/model-j', 'модель из ответа важнее --model записи агента');
    assert.equal(event.changed_files, null, 'файлы стадии пишут prepare и apply');
    assert.equal(event.models, null);
    assert.equal(event.status, 'ok');
    assert.equal(event.exit_code, 0);
    assert.equal(event.ticket, 'IMPL-1');
    assert.equal(event.pipeline_run, RUN_ID);
    assert.ok(!('crash_ttl_ms' in event));
    assert.equal(parseAgentHistory(fs.readFileSync(ticketPath, 'utf8')).length, 1, 'история работы записана');
    assert.equal(openRunExists(root), false);
  });

  test('ответ без поля model — ключ по записи агента (--model как есть)', async () => {
    const { root, result } = await runModelIo('score: 4');
    assert.equal(result.status, 'passed');
    const [event] = runEvents(root);
    assert.equal(event.model, 'prov/model-cfg');
    assert.equal(event.changed_files, null);
  });

  test('ошибка модели класса server → следующий агент: crash_ttl_ms — TTL класса (5m), ключ по записи агента', async () => {
    const { root, result, logger } = await runModelIo('error_class: server\nerror: upstream failed', {
      'judge-b': judge('score: 5\nmodel: prov/model-j2', 'prov/model-cfg-b'),
    });
    assert.equal(result.status, 'passed', logger.lines.join('\n'));

    const events = runEvents(root);
    assert.equal(events.length, 2, JSON.stringify(events));
    const [a, b] = events;
    assert.equal(a.agent, 'judge-a');
    assert.equal(a.model, 'prov/model-cfg', 'ответа с моделью нет — --model записи агента');
    assert.equal(a.status, 'error');
    assert.equal(a.exit_code, -1);
    assert.equal(a.changed_files, null);
    assert.equal(a.crash_ttl_ms, 5 * 60 * 1000, 'TTL класса server ошибки модели');
    assert.equal(b.agent, 'judge-b');
    assert.equal(b.model, 'prov/model-j2');
    assert.equal(b.status, 'ok');
    assert.equal(b.changed_files, null);
    assert.ok(!('crash_ttl_ms' in b));
    assert.notEqual(a.run_key, b.run_key);
  });
});
