/**
 * Остановка пайплайна во время работы агента: исход запуска в журнале
 * `.workflow/metrics/agent-runs.jsonl` и доставка SIGINT / SIGTERM `workflow run` до
 * снятия агента (src/runner.mjs; PLAN-003, задачи 36–37).
 *
 * Зачем. Агент, снятый остановкой пайплайна, — не сбой модели: его запуск не идёт ни в
 * неудачи, ни во временный запрет (градация `stopped`). Но класс classifyAgentResult
 * этого не видит: на Windows `taskkill /T /F` закрывает агента с кодом 1 (класс
 * `error`), на POSIX агент, получивший SIGINT группы (Ctrl+C), закрывается с сигналом
 * SIGINT — тоже не `aborted`. Признак остановки — `stopRequested` исполнителя стадии, и
 * по нему раннер пишет `aborted` с `stop_requested: true`. А до задачи 37 SIGINT /
 * SIGTERM в `workflow run` ловил обработчик runPipeline и выходил `process.exit(130)`
 * раньше обработчика раннера: ветка остановки не исполнялась, исход не писался, агент
 * оставался работать без раннера.
 *
 * Что охраняется:
 *  - CLI-агент и агент стадии с `model_io`, снятые `executor.killCurrentChild()` во
 *    время работы: событие `run` со статусом `aborted`, `stop_requested: true`, без
 *    `crash_ttl_ms`; строка истории работы тикета `aborted`; следующий агент стадии не
 *    запускался; пометки в `agent-health.json` нет; записи открытого запуска нет;
 *  - агент, вышедший сам с кодом 143 без запроса остановки, — сбой: `aborted` без
 *    `stop_requested` и с числовым `crash_ttl_ms` (решение 2026-09-27, вопрос 7);
 *  - раннер в дочернем процессе на всех ОС: обвязка вызывает `process.emit('SIGINT')`
 *    / `('SIGTERM')` — те же слушатели, что у настоящего сигнала (`child.kill('SIGINT')`
 *    на Windows снимает процесс, не вызывая обработчик). В логе строки мягкой остановки,
 *    агент снят, следующий не запускался, событие `aborted` + `stop_requested` +
 *    числовой `duration_ms` записал сам раннер (без `interrupted`), записи открытого
 *    запуска и маркера `.pipeline.lock` нет, код выхода 130;
 *  - второй сигнал во время мягкой остановки — выход 130 без ожидания агента, после
 *    выхода процесса агента нет; на POSIX агент из одного процесса игнорирует SIGTERM
 *    первого сигнала, и снимает его SIGKILL второго;
 *  - только POSIX: настоящие сигналы `bin/workflow.mjs run`, запущенному `detached`, —
 *    SIGTERM одному раннеру (как stopPipeline), SIGINT группе (как Ctrl+C) и SIGTERM
 *    группе (как расширение VS Code): `aborted` + `stop_requested`, без `interrupted`,
 *    агент снят, выход 130.
 *
 * Stub-агенты — скрипты node во временном проекте; pid пишут в файл, чтобы тест
 * проверил, что процесса нет (`process.kill(pid, 0)` → ESRCH). Корень — временный
 * каталог ОС, снимается в afterEach после настоящего выхода дочернего раннера и
 * stub-агентов (Windows не удаляет каталог, который — cwd живого процесса).
 * Имена агентов и моделей — нейтральные (директива PLAN-003 2026-09-26).
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/runner-stop-signal.test.mjs
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StageExecutor } from '../runner.mjs';
import { readRunEvents, openRunPath, isCrashStatus } from '../lib/agent-runs.mjs';
import { parseAgentHistory } from '../lib/agent-history.mjs';
import { isHealthy } from '../lib/agent-health-registry.mjs';

const IS_WIN = process.platform === 'win32';
const RUNNER_URL = new URL('../runner.mjs', import.meta.url).href;
const BIN = fileURLToPath(new URL('../../bin/workflow.mjs', import.meta.url));

// Потолок жизни stub-агента: живёт, пока его не снимут, но сиротой не дольше этого.
const STUB_LIFETIME_MS = 60000;

const ROOTS = [];
const CHILDREN = [];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Итог промиса или null по истечении срока; таймер снимается, процесс теста его не ждёт. */
async function withTimeout(promise, ms) {
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function pollUntil(check, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await wait(intervalMs);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function waitGone(pid, timeoutMs = 5000) {
  return pollUntil(() => !alive(pid), timeoutMs);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readPid(root, name) {
  return Number(readFileSync(join(root, 'run', `${name}.pid`), 'utf8'));
}

/** Все pid stub-агентов проекта — для teardown. */
function stubPids(root) {
  const dir = join(root, 'run');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.pid'))
    .map((name) => Number(readFileSync(join(dir, name), 'utf8')))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function stopChild(tracked) {
  const { child } = tracked;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (IS_WIN) execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe', windowsHide: true });
    else if (tracked.detached) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {}
  await withTimeout(tracked.exited, 10000);
}

afterEach(async () => {
  for (const tracked of CHILDREN.splice(0)) await stopChild(tracked);
  for (const root of ROOTS.splice(0)) {
    for (const pid of stubPids(root)) {
      if (!alive(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await waitGone(pid);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  ROOTS.push(root);
  mkdirSync(join(root, '.workflow', 'config'), { recursive: true });
  mkdirSync(join(root, '.workflow', 'logs'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'run'), { recursive: true });
  return root;
}

/**
 * Агент, который работает, пока его не снимут. pid — в `run/<name>.pid` (атомарно:
 * читатель не увидит пустой файл). `onTerm`:
 *   - `default` — SIGTERM снимает процесс;
 *   - `exit1`   — по SIGTERM выход с кодом 1, как у агента, снятого `taskkill /T /F` на
 *                 Windows: без признака остановки classifyAgentResult дал бы `error`;
 *   - `ignore`  — SIGTERM игнорируется: снять можно только SIGKILL.
 * На Windows обработчик не вызывается: `taskkill /F` снимает процесс сразу.
 */
function writeWorkStub(root, name, { onTerm = 'default' } = {}) {
  const file = join(root, 'scripts', `${name}.mjs`);
  const pidFile = join(root, 'run', `${name}.pid`);
  const handler = {
    default: '',
    exit1: "process.on('SIGTERM', () => process.exit(1));",
    ignore: "process.on('SIGTERM', () => {});",
  }[onTerm];
  writeFileSync(file, `import fs from 'node:fs';
${handler}
const pidFile = ${JSON.stringify(pidFile)};
fs.writeFileSync(pidFile + '.tmp', String(process.pid));
fs.renameSync(pidFile + '.tmp', pidFile);
setTimeout(() => process.exit(0), ${STUB_LIFETIME_MS});
`);
  return file;
}

/** Агент, который сам выходит с кодом 143 (как обёртка, снятая сигналом, — не остановка пайплайна). */
function writeExit143Stub(root, name) {
  const file = join(root, 'scripts', `${name}.mjs`);
  const pidFile = join(root, 'run', `${name}.pid`);
  writeFileSync(file, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.exit(143);
`);
  return file;
}

/** Следующий агент стадии: метка вызова `run/<name>.called` и RESULT passed. */
function writeMarkerStub(root, name) {
  const file = join(root, 'scripts', `${name}.mjs`);
  writeFileSync(file, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(join(root, 'run', `${name}.called`))}, 'called');
console.log('---RESULT---\\nstatus: passed\\n---RESULT---');
`);
  return file;
}

function calledMarker(root, name) {
  return join(root, 'run', `${name}.called`);
}

function createTicket(root, ticketId) {
  const dir = join(root, '.workflow', 'tickets', 'in-progress');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ticketId}.md`);
  writeFileSync(file, `---
id: ${ticketId}
title: "Stop signal probe"
type: impl
created_at: "2026-09-27T00:00:00Z"
updated_at: "2026-09-27T00:00:00Z"
---

## Описание

Тикет для проверки остановки пайплайна.

## Definition of Done

- [ ] Остановка записана
`, 'utf8');
  return file;
}

function captureLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  const noop = () => {};
  return {
    lines,
    info: push('INFO'),
    warn: push('WARN'),
    error: push('ERROR'),
    debug: push('DEBUG'),
    stageStart: noop,
    stageComplete: noop,
    timeout: noop,
    cliCall: noop,
    gotoTransition: noop,
  };
}

function runEvents(root) {
  return readRunEvents(root).filter((event) => event.type === 'run');
}

/** Пометки агента в `.workflow/state/agent-health.json` нет. */
function assertNotMarked(root, agentId) {
  const file = join(root, '.workflow', 'state', 'agent-health.json');
  if (existsSync(file)) {
    const health = readJson(file);
    assert.equal(health.agents?.[agentId], undefined, `пометка в agent-health.json: ${JSON.stringify(health)}`);
  }
  assert.equal(isHealthy(root, agentId), true);
}

/** Событие `run` остановленного запуска, записанное самим раннером. */
function assertStoppedEvent(event, { agent, runKey }) {
  assert.equal(event.agent, agent);
  if (runKey) assert.equal(event.run_key, runKey, 'run_key события — run_key записи открытого запуска');
  assert.equal(event.status, 'aborted', JSON.stringify(event));
  assert.equal(event.stop_requested, true, JSON.stringify(event));
  assert.equal(typeof event.duration_ms, 'number', JSON.stringify(event));
  assert.equal('interrupted' in event, false, 'событие записал раннер, а не следующий старт');
  assert.equal('crash_ttl_ms' in event, false, 'остановка пайплайна — не сбой');
  assert.equal(isCrashStatus(event), false);
}

// ============================================================================
// Задача 36: StageExecutor в процессе теста, остановка executor.killCurrentChild()
// ============================================================================

function cliConfig(agents) {
  return {
    pipeline: {
      name: 'stop-signal-test',
      version: '1.0',
      agents,
      // Снимки включены, а stub-агенты каталог scripts не трогают: diff пустой, и без
      // признака остановки сбой агента передал бы стадию следующему агенту.
      execution: { artifact_snapshot_enabled: true, snapshot_paths: ['scripts'], timeout_per_stage: 60 },
      stages: {},
      entry: 'none',
      context: {},
    },
  };
}

// prepare обмена model_io: вход с одним вопросом на пять уровней (так требует агент с командой).
const PREPARE_SCRIPT = `import fs from 'node:fs';
fs.mkdirSync('.workflow/tmp', { recursive: true });
fs.writeFileSync('.workflow/tmp/prepare-env.json', JSON.stringify({ agent: process.env.WORKFLOW_MODEL_AGENT }));
fs.writeFileSync('.workflow/tmp/request.json', JSON.stringify({
  data: 'проверяемые данные',
  questions: [{ id: 'dod-1', text: 'Критерий выполнен?', levels: ['у1', 'у2', 'у3', 'у4', 'у5'] }],
}));
console.log('---RESULT---\\nstatus: ready\\nrequest_file: .workflow/tmp/request.json\\n---RESULT---');
`;

const APPLY_SCRIPT = `import fs from 'node:fs';
fs.writeFileSync('.workflow/tmp/apply-called', 'yes');
console.log('---RESULT---\\nstatus: passed\\n---RESULT---');
`;

describe('задача 36: остановка пайплайна — aborted со stop_requested', () => {
  it('CLI-агент, снятый killCurrentChild: aborted + stop_requested, история aborted, следующий не запускался', async () => {
    const root = makeRoot('wf-stop-cli-');
    const ticketPath = createTicket(root, 'IMPL-1');
    const config = cliConfig({
      'agent-a': { command: 'node', args: [writeWorkStub(root, 'agent-a', { onTerm: 'exit1' })], capabilities: ['text'] },
      'agent-b': { command: 'node', args: [writeMarkerStub(root, 'agent-b')], capabilities: ['text'] },
    });
    const logger = captureLogger();
    const executor = new StageExecutor(config, { ticket_id: 'IMPL-1' }, {}, {}, null, logger, root);
    const stage = { agents: ['agent-a', 'agent-b'], instructions: 'Stop probe', skill: 'test-skill' };

    const running = executor.executeWithFallback('work', stage);
    running.catch(() => {});
    const pidFile = join(root, 'run', 'agent-a.pid');
    assert.ok(await pollUntil(() => existsSync(pidFile), 15000), 'агент запущен');
    const openRun = readJson(openRunPath(root));
    executor.killCurrentChild();

    await assert.rejects(running, 'стадия, снятая остановкой, завершается ошибкой агента');

    const events = runEvents(root);
    assert.equal(events.length, 1, JSON.stringify(events));
    assertStoppedEvent(events[0], { agent: 'agent-a', runKey: openRun.run_key });
    assert.ok(!existsSync(openRunPath(root)), 'записи открытого запуска нет');

    const history = parseAgentHistory(readFileSync(ticketPath, 'utf8'));
    assert.equal(history.length, 1, JSON.stringify(history));
    assert.equal(history[0].agent, 'agent-a');
    assert.equal(history[0].status, 'aborted');

    assert.ok(!existsSync(calledMarker(root, 'agent-b')), 'следующий агент не запускался');
    assertNotMarked(root, 'agent-a');
    assert.ok(logger.lines.some((line) => line.includes('agent agent-a stopped by shutdown — no in-stage fallback')),
      logger.lines.join('\n'));
    assert.ok(await waitGone(readPid(root, 'agent-a')), 'процесса агента нет');
  });

  it('агент стадии с model_io, снятый killCurrentChild: aborted + stop_requested, история aborted, apply и следующий не запускались', async () => {
    const root = makeRoot('wf-stop-model-io-');
    const ticketPath = createTicket(root, 'IMPL-2');
    writeFileSync(join(root, 'scripts', 'prepare.mjs'), PREPARE_SCRIPT);
    writeFileSync(join(root, 'scripts', 'apply.mjs'), APPLY_SCRIPT);
    const config = {
      pipeline: {
        name: 'stop-signal-model-io',
        version: '1.0',
        entry: 'review',
        execution: { timeout_per_stage: 60, artifact_snapshot_enabled: false },
        agents: {
          'judge-a': { command: 'node', args: [writeWorkStub(root, 'judge-a')], capabilities: ['text'] },
          'agent-b': { command: 'node', args: [writeMarkerStub(root, 'agent-b')], capabilities: ['text'] },
        },
        stages: {
          review: {
            agents: ['judge-a', 'agent-b'],
            model_io: { prepare: 'scripts/prepare.mjs', apply: 'scripts/apply.mjs' },
            goto: { passed: { stage: 'end' }, failed: { stage: 'end' }, error: { stage: 'end' } },
          },
        },
      },
    };
    const executor = new StageExecutor(config, { ticket_id: 'IMPL-2' }, {}, {}, null, captureLogger(), root);

    const running = executor.execute('review');
    running.catch(() => {});
    const pidFile = join(root, 'run', 'judge-a.pid');
    assert.ok(await pollUntil(() => existsSync(pidFile), 15000), 'агент с командой запущен');
    const openRun = readJson(openRunPath(root));
    executor.killCurrentChild();

    const result = await running;
    assert.equal(result.status, 'error');
    assert.equal(result.result.error_class, 'aborted');

    const events = runEvents(root);
    assert.equal(events.length, 1, JSON.stringify(events));
    assertStoppedEvent(events[0], { agent: 'judge-a', runKey: openRun.run_key });
    assert.equal(events[0].changed_files, null, 'у стадии с model_io changed_files — null');
    assert.ok(!existsSync(openRunPath(root)), 'записи открытого запуска нет');

    const history = parseAgentHistory(readFileSync(ticketPath, 'utf8'));
    assert.equal(history.length, 1, JSON.stringify(history));
    assert.equal(history[0].agent, 'judge-a');
    assert.equal(history[0].status, 'aborted');

    assert.ok(!existsSync(join(root, '.workflow', 'tmp', 'apply-called')), 'apply не запускался');
    assert.equal(readJson(join(root, '.workflow', 'tmp', 'prepare-env.json')).agent, 'judge-a',
      'prepare следующего агента не запускался');
    assert.ok(!existsSync(calledMarker(root, 'agent-b')), 'следующий агент не запускался');
    assertNotMarked(root, 'judge-a');
    assert.ok(await waitGone(readPid(root, 'judge-a')), 'процесса агента нет');
  });

  it('агент, вышедший сам с кодом 143 без запроса остановки: aborted без stop_requested, с числовым crash_ttl_ms', async () => {
    const root = makeRoot('wf-stop-143-');
    createTicket(root, 'IMPL-3');
    const config = cliConfig({
      'agent-a': { command: 'node', args: [writeExit143Stub(root, 'agent-a')], capabilities: ['text'] },
    });
    config.pipeline.execution.artifact_snapshot_enabled = false;
    const executor = new StageExecutor(config, { ticket_id: 'IMPL-3' }, {}, {}, null, captureLogger(), root);
    const stage = { agents: ['agent-a'], instructions: 'Exit probe', skill: 'test-skill' };

    await assert.rejects(executor.executeWithFallback('work', stage), (err) => err.exitCode === 143);
    assert.equal(executor.stopRequested, false, 'остановка не запрашивалась');

    const events = runEvents(root);
    assert.equal(events.length, 1, JSON.stringify(events));
    const [event] = events;
    assert.equal(event.agent, 'agent-a');
    assert.equal(event.status, 'aborted', 'класс classifyAgentResult для кода 143');
    assert.equal(event.exit_code, 143);
    assert.equal('stop_requested' in event, false, JSON.stringify(event));
    assert.equal('interrupted' in event, false, JSON.stringify(event));
    assert.equal(typeof event.crash_ttl_ms, 'number', JSON.stringify(event));
    assert.ok(event.crash_ttl_ms > 0, JSON.stringify(event));
    assert.equal(isCrashStatus(event), true, 'снятие агента не остановкой пайплайна — сбой');
    assert.ok(!existsSync(openRunPath(root)), 'записи открытого запуска нет');
  });
});

// ============================================================================
// Задача 37: раннер дочерним процессом
// ============================================================================

/**
 * Проект для раннера в дочернем процессе: стадия `work` с агентами agent-a (работает,
 * пока не снимут) и agent-b (метка вызова). Снимки по каталогу scripts, который агенты
 * не трогают: без признака остановки сбой agent-a передал бы стадию agent-b.
 */
function makeRunnerProject(prefix, { onTerm = 'default' } = {}) {
  const root = makeRoot(prefix);
  const config = {
    pipeline: {
      name: 'stop-signal-runner',
      version: '1.0',
      entry: 'work',
      context: {},
      execution: {
        timeout_per_stage: 60,
        delay_between_stages: 1,
        artifact_snapshot_enabled: true,
        snapshot_paths: ['scripts'],
      },
      agents: {
        'agent-a': { command: 'node', args: [writeWorkStub(root, 'agent-a', { onTerm })], capabilities: ['text'] },
        'agent-b': { command: 'node', args: [writeMarkerStub(root, 'agent-b')], capabilities: ['text'] },
      },
      stages: {
        work: {
          agents: ['agent-a', 'agent-b'],
          instructions: 'Stop signal probe',
          skill: 'test-skill',
          goto: { passed: 'end', error: 'end' },
        },
      },
    },
  };
  writeFileSync(join(root, '.workflow', 'config', 'pipeline.yaml'), JSON.stringify(config, null, 2));
  return root;
}

/**
 * Обвязка: runPipeline из рабочей копии пакета для временного проекта. Дождавшись
 * записи открытого запуска и pid агента, копирует запись в run/open-run-seen.json и
 * вызывает process.emit(<первый сигнал>) — без второго аргумента, как в плане (задача 38;
 * Node вызывает слушателей настоящего сигнала с его именем аргументом — проверено
 * запуском, Linux, Node 22). Второй сигнал (если задан) — на POSIX через
 * 300 мс (агент, игнорирующий SIGTERM, в это время ещё жив — это отмечается в
 * run/second-signal.json), на Windows сразу: там агента уже снял taskkill первого
 * сигнала, а мягкая остановка за 300 мс успела бы закончиться сама.
 */
function writeHarness(root) {
  const file = join(root, 'harness.mjs');
  writeFileSync(file, `import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from ${JSON.stringify(RUNNER_URL)};

const [root, first, second] = process.argv.slice(2);
const openRun = path.join(root, '.workflow', 'state', 'agent-run-open.json');
const pidFile = path.join(root, 'run', 'agent-a.pid');
const note = (name, data) => fs.writeFileSync(path.join(root, 'run', name), JSON.stringify(data));

const timer = setInterval(() => {
  if (!fs.existsSync(openRun) || !fs.existsSync(pidFile)) return;
  let record;
  try { record = JSON.parse(fs.readFileSync(openRun, 'utf8')); } catch { return; }
  clearInterval(timer);
  note('open-run-seen.json', record);
  process.emit(first);
  if (!second) return;
  const escalate = () => {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let agentAlive = true;
    try { process.kill(pid, 0); } catch (err) { agentAlive = err.code === 'EPERM'; }
    note('second-signal.json', { at: Date.now(), agent_alive: agentAlive });
    process.emit(second);
  };
  if (process.platform === 'win32') escalate();
  else setTimeout(escalate, 300);
}, 25);

const outcome = await runPipeline(['--project', root]);
clearInterval(timer);
note('outcome.json', { exitCode: outcome.exitCode ?? null, code: outcome.code ?? null });
process.exit(outcome.exitCode ?? 0);
`);
  return file;
}

function spawnTracked(args, { cwd, detached = false }) {
  const child = spawn(process.execPath, args, { cwd, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() }));
  });
  const tracked = { child, exited, detached, output: () => output };
  CHILDREN.push(tracked);
  return tracked;
}

function waitExit(tracked, timeoutMs = 30000) {
  return withTimeout(tracked.exited, timeoutMs);
}

function pipelineLog(root) {
  const dir = join(root, '.workflow', 'logs');
  const logs = readdirSync(dir).filter((name) => name.endsWith('.log'));
  assert.equal(logs.length, 1, `один лог пайплайна: ${JSON.stringify(logs)}`);
  return readFileSync(join(dir, logs[0]), 'utf8');
}

function markerPath(root) {
  return join(root, '.workflow', 'logs', '.pipeline.lock');
}

/** Мягкая остановка раннера сигналом: всё, что требует критерий задачи 37. */
async function assertGracefulStop(root, { signal, exit, seen, output }) {
  assert.ok(exit, `раннер не вышел за срок:\n${output}`);
  assert.equal(exit.code, 130, `код выхода:\n${output}`);

  const log = pipelineLog(root);
  assert.ok(log.includes(`Received ${signal}. Shutting down gracefully...`), log);
  assert.ok(log.includes('agent agent-a stopped by shutdown — no in-stage fallback'), log);

  const events = runEvents(root);
  assert.equal(events.length, 1, `одно событие run: ${JSON.stringify(events)}`);
  assertStoppedEvent(events[0], { agent: 'agent-a', runKey: seen.run_key });

  assert.ok(!existsSync(openRunPath(root)), 'записи открытого запуска нет');
  assert.ok(!existsSync(markerPath(root)), 'маркер .pipeline.lock снят');
  assert.ok(!existsSync(calledMarker(root, 'agent-b')), 'следующий агент не запускался');
  assert.ok(await waitGone(readPid(root, 'agent-a')), 'процесса агента нет');
}

async function runHarness(root, signals) {
  const harness = writeHarness(root);
  const run = spawnTracked([harness, root, ...signals], { cwd: root });
  const exit = await waitExit(run);
  return { run, exit };
}

describe('задача 37: сигнал остановки доходит до killCurrentChild (обвязка, process.emit)', () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`${signal}: мягкая остановка — aborted + stop_requested, агент снят, маркер снят, выход 130`, async () => {
      const root = makeRunnerProject(`wf-stop-emit-${signal.toLowerCase()}-`);
      const { run, exit } = await runHarness(root, [signal]);

      const seen = readJson(join(root, 'run', 'open-run-seen.json'));
      await assertGracefulStop(root, { signal, exit, seen, output: run.output() });
      assert.ok(!existsSync(join(root, 'run', 'outcome.json')), 'из runPipeline выходит process.exit(130), а не возврат');
    });
  }

  it('второй сигнал во время мягкой остановки: выход 130 без ожидания агента, процесса агента нет', async () => {
    // На POSIX агент игнорирует SIGTERM от killCurrentChild первого сигнала — без
    // SIGKILL второго он пережил бы раннер.
    const root = makeRunnerProject('wf-stop-emit-twice-', { onTerm: 'ignore' });
    const { run, exit } = await runHarness(root, ['SIGINT', 'SIGTERM']);

    assert.ok(exit, `раннер не вышел за срок:\n${run.output()}`);
    assert.equal(exit.code, 130, run.output());
    const second = readJson(join(root, 'run', 'second-signal.json'));
    if (!IS_WIN) {
      assert.equal(second.agent_alive, true, 'агент пережил SIGTERM первого сигнала');
    }
    assert.ok(exit.at - second.at < 10000, `выход через ${exit.at - second.at} мс после второго сигнала — раннер ждал агента`);

    const agentPid = readPid(root, 'agent-a');
    assert.ok(await waitGone(agentPid), 'после выхода раннера процесса агента нет');
    assert.ok(!existsSync(markerPath(root)), 'маркер .pipeline.lock снят');
    assert.ok(pipelineLog(root).includes('Received SIGINT. Shutting down gracefully...'));
    assert.ok(!existsSync(calledMarker(root, 'agent-b')), 'следующий агент не запускался');
    assert.ok(!runEvents(root).some((event) => event.agent === 'agent-b'), 'события следующего агента нет');
  });
});

// ============================================================================
// Задача 37, только POSIX: настоящие сигналы `workflow run`, запущенному detached
// ============================================================================

const POSIX_ONLY = IS_WIN && 'Windows: сигнал с обработчиком снаружи не доставить — случаи через process.emit выше';

const REAL_SIGNALS = [
  { name: 'SIGTERM только раннеру (как stopPipeline)', signal: 'SIGTERM', group: false },
  { name: 'SIGINT группе процессов раннера (как Ctrl+C)', signal: 'SIGINT', group: true },
  { name: 'SIGTERM группе процессов раннера (как расширение VS Code)', signal: 'SIGTERM', group: true },
];

describe('задача 37: настоящие сигналы workflow run (POSIX)', () => {
  for (const { name, signal, group } of REAL_SIGNALS) {
    it(`${name}: aborted + stop_requested без interrupted, агент снят, выход 130`, { skip: POSIX_ONLY }, async () => {
      const root = makeRunnerProject(`wf-stop-real-${signal.toLowerCase()}-${group ? 'group' : 'pid'}-`);
      const run = spawnTracked([BIN, 'run', '--project', root], { cwd: root, detached: true });

      const pidFile = join(root, 'run', 'agent-a.pid');
      const started = await pollUntil(() => existsSync(openRunPath(root)) && existsSync(pidFile), 20000);
      assert.ok(started, `агент не запущен:\n${run.output()}`);
      const seen = readJson(openRunPath(root));

      process.kill(group ? -run.child.pid : run.child.pid, signal);
      const exit = await waitExit(run);

      await assertGracefulStop(root, { signal, exit, seen, output: run.output() });
    });
  }
});
