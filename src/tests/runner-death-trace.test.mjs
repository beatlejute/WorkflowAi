/**
 * След смерти раннера в логе прогона и строка жизни во время агента (src/runner.mjs:
 * runPipeline — обработчики uncaughtException, unhandledRejection, exit, SIGINT /
 * SIGTERM / SIGBREAK; StageExecutor._callAgentOnce — HEARTBEAT).
 *
 * 2026-09-30: три прогона (PulseProxy 18-55-50, ListeningGlass 18-53-24 и 08-25-19)
 * оборвались без единой строки о причине — ни ошибки, ни сигнала, ни сводки; stderr раннера
 * из workflow-mcp уходит в 'ignore', запуск агента закрывался `aborted` только следующим
 * стартом, а во время агента раннер молчал до 30 минут, и время смерти по mtime лога
 * занижалось.
 *
 * Что охраняется:
 *  - необработанное исключение и отказ промиса во время агента: последняя строка раннера
 *    `RUNNER CRASH reason=… exit_code=1 stage="…"` со стеком, код выхода 1, агент снят,
 *    запуск закрыт событием `run` `aborted` + `interrupted: true` сразу, записи открытого
 *    запуска нет, lock остаётся (workflow-mcp видит `stale` и алерт crashed);
 *  - process.exit во время агента: строка `RUNNER EXIT exit_code=<код>`, агент снят,
 *    запуск закрыт `interrupted`;
 *  - исключение из цикла раннера (runPipeline, catch): строка `RUNNER ERROR` в логе, а не
 *    только в stderr;
 *  - SIGBREAK — мягкая остановка, как SIGINT / SIGTERM: выход 130, `aborted` +
 *    `stop_requested`, lock снят;
 *  - второй сигнал во время мягкой остановки: строка `RUNNER STOP signal=… forced`,
 *    запуск закрыт `interrupted`;
 *  - HEARTBEAT: строки с pid агента, пока он работает, без двоеточия (разбор лога
 *    workflow-mcp принял бы её за строку блока Context); после выхода агента и после
 *    таймаута запуска строк больше нет.
 *
 * Раннер — обвязка в дочернем процессе, которая вызывает runPipeline и, дождавшись
 * записи открытого запуска и pid агента, делает своё действие (на Windows сигнал с
 * обработчиком снаружи не доставить — process.emit, как в runner-stop-signal.test.mjs).
 * Агенты — node-скрипты во временном каталоге ОС. Имена агентов нейтральные.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/runner-death-trace.test.mjs
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StageExecutor } from '../runner.mjs';
import { readRunEvents, openRunPath } from '../lib/agent-runs.mjs';

const IS_WIN = process.platform === 'win32';
const RUNNER_URL = new URL('../runner.mjs', import.meta.url).href;
const STUB_LIFETIME_MS = 60000;

const ROOTS = [];
const CHILDREN = [];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout(promise, ms) {
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
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

async function waitGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await wait(25);
  }
  return true;
}

function stubPids(root) {
  const dir = join(root, 'run');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.pid'))
    .map((name) => Number(readFileSync(join(dir, name), 'utf8')))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

afterEach(async () => {
  for (const tracked of CHILDREN.splice(0)) {
    const { child } = tracked;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (IS_WIN) execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe', windowsHide: true });
        else child.kill('SIGKILL');
      } catch {}
      await withTimeout(tracked.exited, 10000);
    }
  }
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
  for (const dir of [['.workflow', 'config'], ['.workflow', 'logs'], ['scripts'], ['run']]) {
    mkdirSync(join(root, ...dir), { recursive: true });
  }
  return root;
}

/** Агент, который работает, пока его не снимут; `onTerm: ignore` — SIGTERM не снимает (POSIX). */
function writeWorkStub(root, name, { onTerm = 'default' } = {}) {
  const file = join(root, 'scripts', `${name}.mjs`);
  const pidFile = join(root, 'run', `${name}.pid`);
  writeFileSync(file, `import fs from 'node:fs';
${onTerm === 'ignore' ? "process.on('SIGTERM', () => {});" : ''}
const pidFile = ${JSON.stringify(pidFile)};
fs.writeFileSync(pidFile + '.tmp', String(process.pid));
fs.renameSync(pidFile + '.tmp', pidFile);
setTimeout(() => process.exit(0), ${STUB_LIFETIME_MS});
`);
  return file;
}

/** Агент: pid в файл, через `ms` — RESULT passed и выход 0. */
function writeSleepStub(root, name, ms) {
  const file = join(root, 'scripts', `${name}.mjs`);
  const pidFile = join(root, 'run', `${name}.pid`);
  writeFileSync(file, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => { console.log('---RESULT---\\nstatus: passed\\n---RESULT---'); process.exit(0); }, ${ms});
`);
  return file;
}

function makeRunnerProject(prefix, { onTerm = 'default' } = {}) {
  const root = makeRoot(prefix);
  const config = {
    pipeline: {
      name: 'death-trace-runner',
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
      },
      stages: {
        work: {
          agents: ['agent-a'],
          instructions: 'Death trace probe',
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
 * Обвязка: runPipeline для временного проекта; дождавшись записи открытого запуска и
 * pid агента, копирует запись в run/open-run-seen.json и делает `action`:
 *   throw — исключение из таймера; reject — отказ промиса без обработчика;
 *   exit:<код> — process.exit; emit:<сигнал>[,<сигнал>] — process.emit сигналов подряд;
 *   run-throws — (без ожидания агента) PipelineRunner.prototype.run бросает после init.
 */
function writeHarness(root) {
  const file = join(root, 'harness.mjs');
  writeFileSync(file, `import fs from 'node:fs';
import path from 'node:path';
import { runPipeline, PipelineRunner } from ${JSON.stringify(RUNNER_URL)};

const [root, action] = process.argv.slice(2);
const openRun = path.join(root, '.workflow', 'state', 'agent-run-open.json');
const pidFile = path.join(root, 'run', 'agent-a.pid');
const note = (name, data) => fs.writeFileSync(path.join(root, 'run', name), JSON.stringify(data));

if (action === 'run-throws') {
  PipelineRunner.prototype.run = async function () {
    await this.init();
    throw new Error('boom-run');
  };
}

const timer = action === 'run-throws' ? null : setInterval(() => {
  if (!fs.existsSync(openRun) || !fs.existsSync(pidFile)) return;
  let record;
  try { record = JSON.parse(fs.readFileSync(openRun, 'utf8')); } catch { return; }
  clearInterval(timer);
  note('open-run-seen.json', record);
  if (action === 'throw') setTimeout(() => { throw new Error('boom-crash'); }, 0);
  else if (action === 'reject') Promise.reject(new Error('boom-rejection'));
  else if (action.startsWith('exit:')) process.exit(Number(action.slice(5)));
  else if (action.startsWith('emit:')) for (const signal of action.slice(5).split(',')) process.emit(signal);
}, 25);

const outcome = await runPipeline(['--project', root]);
if (timer) clearInterval(timer);
note('outcome.json', { exitCode: outcome.exitCode ?? null });
process.exit(outcome.exitCode ?? 0);
`);
  return file;
}

async function runHarness(root, action) {
  const harness = writeHarness(root);
  const child = spawn(process.execPath, [harness, root, action], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  CHILDREN.push({ child, exited });
  const exit = await withTimeout(exited, 30000);
  assert.ok(exit, `обвязка не вышла за 30 с:\n${output}`);
  return { exit, output, pid: child.pid };
}

function pipelineLog(root) {
  const dir = join(root, '.workflow', 'logs');
  const logs = readdirSync(dir).filter((name) => name.endsWith('.log'));
  assert.equal(logs.length, 1, `один лог пайплайна: ${JSON.stringify(logs)}`);
  return readFileSync(join(dir, logs[0]), 'utf8');
}

/** Строки самого раннера (не агентского вывода) с данным началом сообщения. */
function runnerLines(log, prefix) {
  return log.split(/\r?\n/).filter((line) => new RegExp(`^\\[[^\\]]+\\] \\[\\w+\\] \\[PipelineRunner\\] ${prefix}`).test(line));
}

const markerPath = (root) => join(root, '.workflow', 'logs', '.pipeline.lock');
const runEvents = (root) => readRunEvents(root).filter((event) => event.type === 'run');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const agentPid = (root) => Number(readFileSync(join(root, 'run', 'agent-a.pid'), 'utf8'));

/** Запуск агента закрыт сразу — событием aborted + interrupted с run_key открытой записи. */
function assertInterrupted(root) {
  const seen = readJson(join(root, 'run', 'open-run-seen.json'));
  const events = runEvents(root);
  assert.equal(events.length, 1, JSON.stringify(events));
  const [event] = events;
  assert.equal(event.run_key, seen.run_key);
  assert.equal(event.agent, 'agent-a');
  assert.equal(event.status, 'aborted');
  assert.equal(event.interrupted, true, JSON.stringify(event));
  assert.ok(!existsSync(openRunPath(root)), 'записи открытого запуска нет');
}

describe('след смерти раннера в логе прогона', () => {
  for (const [action, reason, message] of [['throw', 'uncaughtException', 'boom-crash'], ['reject', 'unhandledRejection', 'boom-rejection']]) {
    it(`${reason}: строка RUNNER CRASH со стеком, выход 1, агент снят, запуск закрыт interrupted, lock остаётся`, async () => {
      const root = makeRunnerProject(`wf-death-${action}-`);
      const { exit, output, pid } = await runHarness(root, action);
      assert.equal(exit.code, 1, output);

      const log = pipelineLog(root);
      const crash = runnerLines(log, 'RUNNER CRASH');
      assert.equal(crash.length, 1, log);
      assert.match(crash[0], new RegExp(`\\[ERROR\\] \\[PipelineRunner\\] RUNNER CRASH reason=${reason} exit_code=1 stage="work" — Error: ${message}$`));
      assert.match(log, /RUNNER CRASH[^\n]*\n\s+at /, 'стек — следующими строками');

      assertInterrupted(root);
      assert.ok(await waitGone(agentPid(root)), 'процесса агента нет');
      assert.ok(existsSync(markerPath(root)), 'lock упавшего раннера остаётся — stale в workflow-mcp');
      assert.equal(readJson(markerPath(root)).pid, pid);
    });
  }

  it('process.exit во время агента: строка RUNNER EXIT с кодом, агент снят, запуск закрыт interrupted', async () => {
    const root = makeRunnerProject('wf-death-exit-');
    const { exit, output } = await runHarness(root, 'exit:7');
    assert.equal(exit.code, 7, output);
    const lines = runnerLines(pipelineLog(root), 'RUNNER EXIT');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /RUNNER EXIT exit_code=7 stage="work" — process exited before the pipeline finished$/);
    assertInterrupted(root);
    assert.ok(await waitGone(agentPid(root)), 'процесса агента нет');
  });

  it('исключение из цикла раннера: строка RUNNER ERROR в логе, не только в stderr', async () => {
    const root = makeRunnerProject('wf-death-run-throws-');
    const { exit, output } = await runHarness(root, 'run-throws');
    assert.equal(exit.code, 1, output);
    const log = pipelineLog(root);
    const lines = runnerLines(log, 'RUNNER ERROR');
    assert.equal(lines.length, 1, log);
    assert.match(lines[0], /RUNNER ERROR exit_code=1 stage="work" — Error: boom-run$/);
    assert.equal(runnerLines(log, 'RUNNER EXIT').length, 0, 'упорядоченный выход строки RUNNER EXIT не пишет');
    assert.ok(!existsSync(markerPath(root)), 'lock снят в finally');
  });

  it('SIGBREAK — мягкая остановка, как SIGINT: выход 130, aborted + stop_requested, lock снят', async () => {
    const root = makeRunnerProject('wf-death-sigbreak-');
    const { exit, output } = await runHarness(root, 'emit:SIGBREAK');
    assert.equal(exit.code, 130, output);
    const log = pipelineLog(root);
    assert.ok(log.includes('Received SIGBREAK. Shutting down gracefully...'), log);
    const events = runEvents(root);
    assert.equal(events.length, 1, JSON.stringify(events));
    assert.equal(events[0].status, 'aborted');
    assert.equal(events[0].stop_requested, true);
    assert.equal('interrupted' in events[0], false);
    assert.equal(runnerLines(log, 'RUNNER ').length, 0, 'мягкая остановка — упорядоченный выход');
    assert.ok(!existsSync(markerPath(root)), 'lock снят');
    assert.ok(await waitGone(agentPid(root)), 'процесса агента нет');
  });

  it('второй сигнал во время мягкой остановки: строка RUNNER STOP forced, запуск закрыт interrupted', async () => {
    const root = makeRunnerProject('wf-death-forced-', { onTerm: 'ignore' });
    const { exit, output } = await runHarness(root, 'emit:SIGINT,SIGTERM');
    assert.equal(exit.code, 130, output);
    const lines = runnerLines(pipelineLog(root), 'RUNNER STOP');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /RUNNER STOP signal=SIGTERM forced exit_code=130 stage="work" — second stop signal during graceful shutdown$/);
    assertInterrupted(root);
    assert.ok(await waitGone(agentPid(root)), 'процесса агента нет');
  });
});

// ---------------------------------------------------------------------------
// HEARTBEAT во время агента
// ---------------------------------------------------------------------------

function captureLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  const noop = () => {};
  return {
    lines,
    info: push('INFO'), warn: push('WARN'), error: push('ERROR'), debug: push('DEBUG'),
    stageStart: noop, stageComplete: noop, timeout: noop, cliCall: noop, gotoTransition: noop,
  };
}

function heartbeatConfig(root, agentScript, timeoutS = 30) {
  return {
    pipeline: {
      name: 'heartbeat', version: '1.0', entry: 'work', context: {},
      execution: { timeout_per_stage: timeoutS, artifact_snapshot_enabled: false },
      agents: { 'agent-a': { command: 'node', args: [agentScript], capabilities: ['text'] } },
      stages: {},
    },
  };
}

const heartbeats = (logger) => logger.lines.filter((line) => line.startsWith('INFO HEARTBEAT '));

describe('HEARTBEAT во время агента', () => {
  it('строки с pid агента и временем, пока он работает; после выхода — ни одной', async () => {
    const root = makeRoot('wf-heartbeat-');
    const agent = writeSleepStub(root, 'agent-a', 900);
    const logger = captureLogger();
    const executor = new StageExecutor(heartbeatConfig(root, agent), { ticket_id: 'IMPL-7' }, {}, {}, null, logger, root, { heartbeatMs: 200 });
    const result = await executor.executeWithFallback('work', { agents: ['agent-a'], instructions: 'x', skill: 'test-skill' });
    assert.equal(result.status, 'passed');

    const pid = Number(readFileSync(join(root, 'run', 'agent-a.pid'), 'utf8'));
    const lines = heartbeats(logger);
    assert.ok(lines.length >= 3, `за 0,9 с при периоде 0,2 с строк: ${lines.length}\n${logger.lines.join('\n')}`);
    for (const line of lines) {
      assert.match(line, new RegExp(`^INFO HEARTBEAT agent_pid=${pid} elapsed_s=\\d+ ticket=IMPL-7$`));
      assert.ok(!line.slice('INFO '.length).includes(':'), `двоеточие в строке: ${line}`);
    }
    await wait(600);
    assert.equal(heartbeats(logger).length, lines.length, 'после выхода агента строк нет');
  });

  it('таймаут запуска: после снятия агента строк нет', async () => {
    const root = makeRoot('wf-heartbeat-timeout-');
    const agent = writeWorkStub(root, 'agent-a');
    const logger = captureLogger();
    const executor = new StageExecutor(heartbeatConfig(root, agent, 1), {}, {}, {}, null, logger, root, { heartbeatMs: 150 });
    await assert.rejects(executor.executeWithFallback('work', { agents: ['agent-a'], instructions: 'x', skill: 'test-skill' }));
    const count = heartbeats(logger).length;
    assert.ok(count >= 3, `до таймаута 1 с при периоде 0,15 с строк: ${count}`);
    for (const line of heartbeats(logger)) assert.match(line, /^INFO HEARTBEAT agent_pid=\d+ elapsed_s=\d+$/, 'без тикета — без ticket=');
    await wait(600);
    assert.equal(heartbeats(logger).length, count, 'после таймаута строк нет');
  });
});
