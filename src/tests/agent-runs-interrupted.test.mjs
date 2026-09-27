/**
 * Запуск агента, прерванный вместе с раннером без обработчика, и его закрытие
 * следующим стартом пайплайна (PLAN-003, задачи 34–35).
 *
 * Внешние остановки `taskkill /T /F` (MCP `stop_pipeline`, расширение VS Code на
 * Windows) и `SIGKILL` группе процессов раннера (MCP `stop_pipeline` на POSIX) снимают
 * раннер, не дав ему записать исход. Поэтому раннер пишет запись открытого запуска
 * `.workflow/state/agent-run-open.json` до старта агента, а следующий `workflow run`,
 * взявший `.pipeline.lock`, дописывает за неё событие `run` со статусом `aborted` и
 * `interrupted: true` (closeInterruptedRun). Без этого остановленный запуск пропал бы
 * из журнала, и окно «ближайшего» контроля артефактов у него не закрылось бы.
 *
 * Что охраняется:
 *  - второй `workflow run` при живом раннере получает `PIPELINE_ALREADY_RUNNING` и
 *    запись открытого запуска не трогает: до взятия lock'а она принадлежит живому
 *    раннеру;
 *  - после снятия раннера снаружи запись на месте, события `run` за неё нет, процесса
 *    агента нет;
 *  - следующий старт завершается сам, дописывает ровно одно событие `run` с `run_key`
 *    снятого запуска — поля записи, `status: aborted`, `interrupted: true`,
 *    `started_at` из записи, `exit_code` / `changed_files` / `duration_ms` / `models` —
 *    null, без `crash_ttl_ms` — и удаляет запись; градация такого запуска — `stopped`
 *    (решение 2026-09-27, вопрос 6: «Не засчитывать»);
 *  - третий старт второго события не пишет;
 *  - запись, чей `run_key` уже есть в журнале (раннер снят между событием и удалением
 *    файла), и нечитаемая запись удаляются без события;
 *  - прямое создание PipelineRunner без runPipeline запись не закрывает: lock берёт
 *    только runPipeline.
 *
 * Раннер — дочерний процесс `bin/workflow.mjs run` во временном проекте, агент —
 * stub на `node` без оболочки, который работает, пока его не снимут. Повторные старты
 * идут с конфигом `entry: end`: агента они не запускают, иначе появилась бы новая
 * запись открытого запуска и раннер сам не завершился бы. Имена агента и модели —
 * нейтральные (директива PLAN-003 2026-09-26).
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-interrupted.test.mjs
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPipeline, PipelineRunner } from '../runner.mjs';
import {
  openRunPath, readRunEvents, runsLogPath, appendRunEvent, writeOpenRun, closeInterruptedRun, gradeRuns,
} from '../lib/agent-runs.mjs';
import { readMarker } from '../lib/marker.mjs';
import { processAlive } from '../lib/process-alive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'workflow.mjs');
const IS_WIN = process.platform === 'win32';

const AGENT = 'agent-a';
const MODEL = 'model-a';
const TICKET = 'TASK-1';
const STAGE = 'execute-task';

// ---------------------------------------------------------------------------
// Уборка: дочерние раннеры, stub-агенты, временные корни — на любом исходе теста
// ---------------------------------------------------------------------------

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try { await fn(); } catch {}
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Срок ожидания для Promise.race: таймер unref, иначе оставшийся после гонки таймер
 * держал бы процесс теста до своего срабатывания.
 */
function deadline(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms).unref());
}

// ---------------------------------------------------------------------------
// Временный проект
// ---------------------------------------------------------------------------

function pipelineYaml(root, entry) {
  const stub = path.join(root, 'stub-agent.mjs');
  // Команда — именно `node`: агента с другой командой раннер на Windows запускает
  // через оболочку (useShell), а тест держит дерево из двух процессов.
  return `pipeline:
  name: interrupted-run-test
  version: "1.0"
  entry: ${entry}
  context:
    ticket_id: ${TICKET}
  execution:
    timeout_per_stage: 120
    delay_between_stages: 0
  agents:
    ${AGENT}:
      command: node
      args:
        - ${JSON.stringify(stub)}
        - "--model"
        - "${MODEL}"
  stages:
    ${STAGE}:
      skill: execute-task
      agents:
        - ${AGENT}
      instructions: "stub agent"
`;
}

/**
 * Временный корень с двумя конфигами: `run.yaml` — стадия исполнителя со stub-агентом,
 * `end.yaml` — те же агенты и стадии, но `entry: end` (раннер берёт lock, закрывает
 * запись открытого запуска и выходит, не запуская агента).
 */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runs-interrupted-'));
  cleanups.push(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const configDir = path.join(root, '.workflow', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow', 'logs'), { recursive: true });

  // Stub-агент: пишет свой pid и живёт, пока его не снимут. Страховочный выход через
  // 60 с — чтобы упавший тест не оставил сироту навсегда (весь файл короче).
  const pidFile = path.join(root, 'stub.pid');
  fs.writeFileSync(path.join(root, 'stub-agent.mjs'), `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => process.exit(0), 60000);
setInterval(() => {}, 1000);
`);

  const runConfig = path.join(configDir, 'run.yaml');
  const endConfig = path.join(configDir, 'end.yaml');
  fs.writeFileSync(runConfig, pipelineYaml(root, STAGE));
  fs.writeFileSync(endConfig, pipelineYaml(root, 'end'));

  // Stub, переживший тест, снимается по pid до удаления корня.
  cleanups.push(() => {
    const pid = readStubPid(root);
    if (pid && processAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });

  return { root, runConfig, endConfig, pidFile };
}

function readOpenRunText(root) {
  try {
    return fs.readFileSync(openRunPath(root), 'utf8');
  } catch {
    return null;
  }
}

function readOpenRun(root) {
  const text = readOpenRunText(root);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null; // файл пишется прямо сейчас
  }
}

function readStubPid(root) {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(root, 'stub.pid'), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function runEventsFor(root, runKey) {
  return readRunEvents(root).filter((event) => event.type === 'run' && event.run_key === runKey);
}

function readLogs(root) {
  const dir = path.join(root, '.workflow', 'logs');
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

function countOccurrences(text, needle) {
  let count = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Раннер дочерним процессом
// ---------------------------------------------------------------------------

/**
 * `workflow run` дочерним процессом. На POSIX — `detached`: раннер — лидер своей
 * группы, как у MCP `stop_pipeline`, который снимает группу целиком.
 */
function startRunner(root, configPath) {
  const child = spawn(process.execPath, [BIN, 'run', '--project', root, '--config', configPath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WIN,
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const runner = { child, exited, output: () => output, alive: () => child.exitCode === null && child.signalCode === null };
  // Пока раннер жив, корень — его cwd, и Windows не даёт удалить каталог: ждём
  // настоящего выхода (src/tests/marker-payload.test.mjs).
  cleanups.push(async () => {
    if (runner.alive()) {
      killRunnerTree(runner);
      await Promise.race([exited, deadline(10000)]);
    }
  });
  return runner;
}

/**
 * Снятие раннера снаружи без обработчика: дерево на Windows, группа на POSIX.
 *
 * С `stubPid` на Windows раннер снимается первым, затем дерево агента. `taskkill /T /F`
 * по раннеру снимает процессы дерева в произвольном порядке: агент, снятый раньше
 * раннера, успевал закрыться, и нагруженный раннер записывал его исход до своего
 * снятия (тест упал так один раз из нескольких прогонов набора, 2026-09-27). Снятие
 * настоящего дерева kilo одной командой `taskkill /T /F` проверено живым прогоном
 * задачи 39. На POSIX `SIGKILL` группе доходит до всех процессов сразу, и раннер
 * после него своего кода не исполняет.
 */
function killRunnerTree(runner, stubPid = null) {
  const pid = runner.child.pid;
  if (IS_WIN) {
    if (stubPid) {
      try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'pipe', windowsHide: true }); } catch {}
      try { execFileSync('taskkill', ['/T', '/F', '/PID', String(stubPid)], { stdio: 'pipe', windowsHide: true }); } catch {}
    }
    try { execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'pipe', windowsHide: true }); } catch {}
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
}

async function waitFor(fn, { what, timeoutMs = 20000, intervalMs = 50, runner = null }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (runner && !runner.alive()) {
      throw new Error(`раннер вышел раньше, чем ${what}:\n${runner.output()}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`за ${timeoutMs} мс не дождались: ${what}${runner ? `\n${runner.output()}` : ''}`);
    }
    await sleep(intervalMs);
  }
}

/** Старт, который обязан завершиться сам: код выхода 0 и итог цикла в выводе. */
async function runToCompletion(root, configPath, label) {
  const runner = startRunner(root, configPath);
  const result = await Promise.race([runner.exited, deadline(30000)]);
  assert.ok(result, `${label}: раннер не завершился сам за 30 с:\n${runner.output()}`);
  assert.equal(result.code, 0, `${label}: код выхода ${result.code}, сигнал ${result.signal}:\n${runner.output()}`);
  assert.match(runner.output(), /=== Summary ===/, `${label}: цикл раннера не дошёл до конца:\n${runner.output()}`);
  return runner;
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

test('раннер снят снаружи во время работы агента: следующий старт дописывает одно событие aborted с interrupted, третий — ни одного', { timeout: 90000 }, async () => {
  const { root, runConfig, endConfig } = makeProject();

  const runner = startRunner(root, runConfig);
  const record = await waitFor(() => readOpenRun(root), { what: 'запись открытого запуска', runner });
  const stubPid = await waitFor(() => readStubPid(root), { what: 'pid stub-агента', runner });
  const marker = readMarker(root);

  // Запись открытого запуска — поля «Справочных данных» плана.
  assert.equal(typeof record.run_key, 'string');
  assert.ok(record.run_key.length > 0, 'run_key пустой');
  assert.ok(!Number.isNaN(Date.parse(record.ts)), `ts записи не время: ${record.ts}`);
  assert.equal(record.agent, AGENT);
  assert.equal(record.stage, STAGE);
  assert.equal(record.skill, 'execute-task');
  assert.equal(record.ticket, TICKET);
  assert.equal(record.ticket_type, 'task');
  assert.equal(record.model, MODEL);
  assert.ok(marker, 'маркер живого раннера не прочитан');
  assert.equal(record.pipeline_run, marker.run_id, 'pipeline_run записи — run_id раннера из lock');
  assert.ok(processAlive(stubPid), 'stub-агент должен работать');

  const recordText = readOpenRunText(root);

  // Старт при живом раннере: lock занят — PIPELINE_ALREADY_RUNNING, запись не тронута.
  const busy = await runPipeline(['--project', root, '--config', endConfig]);
  assert.equal(busy.code, 'PIPELINE_ALREADY_RUNNING');
  assert.equal(busy.pid, runner.child.pid);
  assert.ok(runner.alive(), 'первый раннер должен быть жив');
  assert.equal(readOpenRunText(root), recordText, 'второй старт при живом раннере не должен трогать запись');
  assert.equal(runEventsFor(root, record.run_key).length, 0, 'события run за идущий запуск быть не должно');

  // Снятие снаружи без обработчика.
  const killedAt = Date.now();
  killRunnerTree(runner, stubPid);
  const exit = await Promise.race([runner.exited, deadline(10000)]);
  assert.ok(exit, 'раннер не вышел после снятия');

  assert.equal(readOpenRunText(root), recordText, 'после снятия запись открытого запуска должна остаться как была');
  assert.equal(runEventsFor(root, record.run_key).length, 0, 'снятый без обработчика раннер не пишет событие run');
  await waitFor(() => !processAlive(stubPid), { what: `выход stub-агента (pid ${stubPid})`, timeoutMs: 5000 });

  // Второй старт: закрывает запись и завершается сам.
  const second = await runToCompletion(root, endConfig, 'второй старт');
  assert.equal(readOpenRunText(root), null, `после второго старта записи открытого запуска быть не должно:\n${second.output()}`);

  const events = runEventsFor(root, record.run_key);
  assert.equal(events.length, 1, `событий run с run_key снятого запуска: ${events.length}`);
  const [event] = events;
  assert.equal(event.status, 'aborted');
  assert.equal(event.interrupted, true);
  assert.equal(event.started_at, record.ts, 'started_at — время старта из записи');
  assert.ok(Date.parse(event.ts) >= killedAt - 1000, `ts события — время дописывания, а не старта: ${event.ts}`);
  assert.equal(event.exit_code, null);
  assert.equal(event.changed_files, null);
  assert.equal(event.duration_ms, null);
  assert.equal(event.models, null);
  assert.ok(!('crash_ttl_ms' in event), 'у прерванного запуска нет crash_ttl_ms');
  assert.ok(!('stop_requested' in event), 'stop_requested — только у остановки, обработанной раннером');
  for (const [key, value] of Object.entries(record)) {
    if (key === 'ts') continue;
    assert.deepEqual(event[key], value, `поле ${key} события должно совпадать с записью`);
  }

  const logs = readLogs(root);
  assert.match(
    logs,
    new RegExp(`agent run interrupted: agent=${AGENT} ticket=${TICKET} .*run_key=${record.run_key}`),
    'в логе второго старта — строка с агентом, тикетом и run_key'
  );

  // Градация задачи 13: прерванный запуск — остановка, модели не засчитывается.
  const graded = gradeRuns(readRunEvents(root)).filter((run) => run.run_key === record.run_key);
  assert.equal(graded.length, 1);
  assert.equal(graded[0].grade, 'stopped');
  assert.equal(graded[0].crash, false);

  // Третий старт: второго события нет.
  const journalAfterSecond = fs.readFileSync(runsLogPath(root), 'utf8');
  await runToCompletion(root, endConfig, 'третий старт');
  assert.equal(runEventsFor(root, record.run_key).length, 1, 'третий старт не должен дописывать второе событие');
  assert.equal(fs.readFileSync(runsLogPath(root), 'utf8'), journalAfterSecond, 'журнал после третьего старта не меняется');
  assert.equal(countOccurrences(readLogs(root), `run_key=${record.run_key}`), 1, 'строка о закрытии записи — одна');
});

test('запись, чей run_key уже есть в журнале, старт удаляет без второго события', { timeout: 60000 }, async () => {
  const { root, endConfig } = makeProject();
  const runKey = 'run-key-logged';
  // Раннер снят между событием run и удалением файла: событие есть, файл остался.
  appendRunEvent(root, {
    type: 'run', run_key: runKey, pipeline_run: 'pipeline_prev', stage: STAGE, skill: 'execute-task',
    ticket: TICKET, ticket_type: 'task', attempt: 1, agent: AGENT, requested: MODEL, model: MODEL,
    status: 'ok', exit_code: 0, changed_files: 1, duration_ms: 1000,
  });
  writeOpenRun(root, {
    run_key: runKey, ts: new Date().toISOString(), pipeline_run: 'pipeline_prev', stage: STAGE,
    skill: 'execute-task', ticket: TICKET, ticket_type: 'task', attempt: 1, agent: AGENT, requested: MODEL, model: MODEL,
  });
  const journalBefore = fs.readFileSync(runsLogPath(root), 'utf8');

  const runner = await runToCompletion(root, endConfig, 'старт');

  assert.equal(readOpenRunText(root), null, `запись должна быть удалена:\n${runner.output()}`);
  assert.equal(fs.readFileSync(runsLogPath(root), 'utf8'), journalBefore, 'журнал не должен измениться');
  assert.equal(runEventsFor(root, runKey).length, 1);
  assert.match(readLogs(root), new RegExp(`open agent run record ${runKey} already in journal`));
});

test('нечитаемая запись открытого запуска: старт удаляет её без события', { timeout: 60000 }, async () => {
  const { root, endConfig } = makeProject();
  fs.mkdirSync(path.dirname(openRunPath(root)), { recursive: true });
  fs.writeFileSync(openRunPath(root), '{"run_key": "run-key-cut', 'utf8');

  const runner = await runToCompletion(root, endConfig, 'старт');

  assert.equal(readOpenRunText(root), null, `нечитаемая запись должна быть удалена:\n${runner.output()}`);
  assert.deepEqual(readRunEvents(root), [], 'событие за нечитаемую запись не пишется');
  assert.match(readLogs(root), /open agent run record unreadable — removed without event/);
});

test('closeInterruptedRun: запись без run_key и запись с уже записанным событием удаляются без события', () => {
  const { root } = makeProject();

  // JSON без run_key — не запись открытого запуска.
  writeOpenRun(root, { agent: AGENT, stage: STAGE, ticket: TICKET });
  const noKey = closeInterruptedRun(root);
  assert.equal(noKey.action, 'unreadable');
  assert.equal(readOpenRunText(root), null);
  assert.deepEqual(readRunEvents(root), []);

  // Не объект.
  fs.writeFileSync(openRunPath(root), '["run-key-array"]\n', 'utf8');
  assert.equal(closeInterruptedRun(root).action, 'unreadable');
  assert.equal(readOpenRunText(root), null);
  assert.deepEqual(readRunEvents(root), []);

  // Событие с этим run_key уже есть.
  appendRunEvent(root, { type: 'run', run_key: 'run-key-done', agent: AGENT, status: 'ok' });
  writeOpenRun(root, { run_key: 'run-key-done', ts: new Date().toISOString(), agent: AGENT });
  const logged = closeInterruptedRun(root);
  assert.equal(logged.action, 'already_logged');
  assert.equal(logged.run_key, 'run-key-done');
  assert.equal(readOpenRunText(root), null);
  assert.equal(runEventsFor(root, 'run-key-done').length, 1);

  // Файла нет — ничего не делается.
  assert.equal(closeInterruptedRun(root).action, 'none');
  assert.equal(readRunEvents(root).length, 1);
});

test('PipelineRunner без runPipeline запись открытого запуска не закрывает', async () => {
  const { root } = makeProject();
  const recordText = `${JSON.stringify({ run_key: 'run-key-foreign', ts: new Date().toISOString(), agent: AGENT, stage: STAGE, ticket: TICKET }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(openRunPath(root)), { recursive: true });
  fs.writeFileSync(openRunPath(root), recordText, 'utf8');

  // Без lock'а запись может принадлежать живому раннеру.
  const runner = new PipelineRunner({
    pipeline: { name: 'direct', version: '1.0', entry: 'end', context: {}, agents: {}, stages: {} },
  }, { project: root });
  try {
    await runner.run();
  } finally {
    runner.disposeSignalHandlers();
  }

  assert.equal(readOpenRunText(root), recordText, 'прямой раннер не должен трогать запись');
  assert.deepEqual(readRunEvents(root), []);
});
