import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { readMarker } from '../lib/marker.mjs';
import { packageVersion } from '../lib/package-version.mjs';
import { PipelineRunner } from '../runner.mjs';

const BIN = resolve(process.cwd(), 'bin/workflow.mjs');

function makeProject(extraExecution = '') {
  const root = mkdtempSync(join(tmpdir(), 'wf-marker-payload-'));
  mkdirSync(join(root, '.workflow', 'logs'), { recursive: true });
  mkdirSync(join(root, '.workflow', 'config'), { recursive: true });

  // Entry-стадия manual-gate паркует раннер в опросе, поэтому процесс живёт и
  // маркер можно прочитать на живом пайплайне.
  writeFileSync(join(root, '.workflow', 'config', 'pipeline.yaml'), `pipeline:
  name: marker-payload-test
  version: "1.0"
  entry: gate
  context: {}
  agents: {}
${extraExecution}  stages:
    gate:
      type: manual-gate
      timeout_seconds: 300
      poll_interval_ms: 1000
      goto:
        approved: gate
        rejected: gate
`);
  return root;
}

function cleanup(root) {
  if (existsSync(root)) {
    // Повторы — на случай, если Windows ещё не отпустил дескриптор лога
    // после выхода процесса: `rmSync` сам повторяет при EBUSY/EPERM.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Запускает раннер и возвращает маркер живого пайплайна.
 * Маркер должен быть полным с первой же записи — дозаписи больше нет.
 */
async function runAndReadMarker(root, env = {}) {
  const child = spawn(process.execPath, [
    BIN, 'run',
    '--project', root,
    '--config', join(root, '.workflow', 'config', 'pipeline.yaml')
  ], { cwd: root, stdio: 'ignore', env: { ...process.env, ...env } });

  try {
    for (let i = 0; i < 100; i++) {
      const marker = readMarker(root);
      if (marker && marker.run_id) { return marker; }
      if (child.exitCode !== null) { break; }
      await wait(100);
    }
    return readMarker(root);
  } finally {
    // Ждём настоящего выхода, а не 200 мс. Пока раннер жив, каталог проекта —
    // его `cwd`, и Windows не даёт удалить его: на раннере GitHub два теста
    // падали с `EBUSY: resource busy or locked, rmdir …wf-marker-payload-…`.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
      child.kill();
      await Promise.race([exited, wait(10000)]);
    }
  }
}

test('runPipeline writes the whole payload in one go', async () => {
  const root = makeProject();
  try {
    const marker = await runAndReadMarker(root);

    assert.ok(marker, 'маркер не создан');
    // Ни одного плейсхолдера: раннер знает путь к логу до захвата lock'а.
    assert.ok(marker.run_id, 'run_id должен быть заполнен сразу');
    assert.ok(marker.pipeline_log, 'pipeline_log должен быть заполнен сразу');
    assert.equal(marker.started_by, 'cli');
    assert.equal(marker.pipeline_version, packageVersion());
    assert.equal(resolve(marker.project_root), resolve(root));
    assert.equal(marker.started_at, marker.timestamp);
    assert.ok(Number.isInteger(marker.pid) && marker.pid > 0);
  } finally {
    cleanup(root);
  }
});

test('run_id matches the log file name', async () => {
  const root = makeProject();
  try {
    const marker = await runAndReadMarker(root);

    assert.ok(marker.run_id);
    assert.equal(basename(marker.pipeline_log), `${marker.run_id}.log`);
    // Путь относительный и с прямыми слэшами — его читают из другой ОС-среды.
    assert.ok(!marker.pipeline_log.includes('\u005c'), marker.pipeline_log);
    assert.ok(existsSync(join(root, marker.pipeline_log)), 'файл лога не найден по pipeline_log');
  } finally {
    cleanup(root);
  }
});

test('WORKFLOW_STARTED_BY reaches the marker', async () => {
  const root = makeProject();
  try {
    const marker = await runAndReadMarker(root, { WORKFLOW_STARTED_BY: 'mcp' });
    assert.equal(marker.started_by, 'mcp');
  } finally {
    cleanup(root);
  }
});

test('an unknown WORKFLOW_STARTED_BY falls back to cli', async () => {
  const root = makeProject();
  try {
    // Контракт поля закрытый: cli | mcp | extension. Мусор не протаскиваем.
    const marker = await runAndReadMarker(root, { WORKFLOW_STARTED_BY: 'weird value; rm -rf /' });
    assert.equal(marker.started_by, 'cli');
  } finally {
    cleanup(root);
  }
});

test('WORKFLOW_STARTED_BY_ID reaches the marker', async () => {
  const root = makeProject();
  try {
    const marker = await runAndReadMarker(root, {
      WORKFLOW_STARTED_BY: 'mcp',
      WORKFLOW_STARTED_BY_ID: 'workflow-mcp@ebc8c4603792'
    });
    assert.equal(marker.started_by, 'mcp');
    assert.equal(marker.started_by_id, 'workflow-mcp@ebc8c4603792');
  } finally {
    cleanup(root);
  }
});

test('no WORKFLOW_STARTED_BY_ID means no field at all', async () => {
  const root = makeProject();
  try {
    // Пустое поле и отсутствие поля различались бы при сверке владения, а
    // означают одно: запускающий не представился.
    const marker = await runAndReadMarker(root);
    assert.equal('started_by_id' in marker, false);
  } finally {
    cleanup(root);
  }
});

test('a malformed WORKFLOW_STARTED_BY_ID is dropped', async () => {
  const root = makeProject();
  try {
    const marker = await runAndReadMarker(root, { WORKFLOW_STARTED_BY_ID: 'id with spaces' });
    assert.equal('started_by_id' in marker, false);
  } finally {
    cleanup(root);
  }
});

test('an over-long WORKFLOW_STARTED_BY_ID is dropped', async () => {
  const root = makeProject();
  try {
    const marker = await runAndReadMarker(root, { WORKFLOW_STARTED_BY_ID: 'a'.repeat(129) });
    assert.equal('started_by_id' in marker, false);
  } finally {
    cleanup(root);
  }
});

test('a custom execution.log_file directory is honoured', async () => {
  const root = makeProject('  execution:\n    log_file: custom/logs/pipeline.log\n');
  try {
    const marker = await runAndReadMarker(root);

    assert.ok(marker.pipeline_log.startsWith('custom/logs/'), marker.pipeline_log);
    assert.equal(basename(marker.pipeline_log), `${marker.run_id}.log`);
    assert.ok(existsSync(join(root, marker.pipeline_log)));
  } finally {
    cleanup(root);
  }
});

test('no temp files are left beside the marker', async () => {
  const root = makeProject();
  try {
    await runAndReadMarker(root);
    const leftovers = readdirSync(join(root, '.workflow', 'logs')).filter(n => n.includes('.tmp.'));
    assert.deepEqual(leftovers, []);
  } finally {
    cleanup(root);
  }
});

test('an invalid config is rejected before the lock is taken', async () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, '.workflow', 'config', 'pipeline.yaml'), 'pipeline:\n  name: broken\n');
    // Путь маркера занят каталогом — любая попытка взять lock обязана
    // провалиться и оставить след в выводе. Без этой ловушки тест не отличал бы
    // новый порядок от старого: раньше lock тоже снимался в `finally`, и после
    // выхода процесса его равно не было.
    mkdirSync(join(root, '.workflow', 'logs', '.pipeline.lock'));

    const child = spawn(process.execPath, [
      BIN, 'run',
      '--project', root,
      '--config', join(root, '.workflow', 'config', 'pipeline.yaml')
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    await new Promise(r => child.once('close', r));

    // Конфиг проверен и отвергнут до того, как раннер полез за lock.
    assert.match(output, /Configuration validation failed/);
    assert.doesNotMatch(output, /failed to write marker/);
    assert.equal(readMarker(root), null);
  } finally {
    cleanup(root);
  }
});

test('PipelineRunner derives run_id and log path when not given them', () => {
  const root = makeProject();
  try {
    const config = {
      pipeline: {
        name: 'test',
        version: '1.0',
        entry: 'start',
        context: {},
        agents: {},
        stages: { start: { type: 'script', script: 'noop.js' } }
      }
    };

    const runner = new PipelineRunner(config, { project: root });
    assert.ok(runner.runId.startsWith('pipeline_'));
    assert.equal(basename(runner.logFilePath), `${runner.runId}.log`);
  } finally {
    cleanup(root);
  }
});

test('PipelineRunner uses the identifiers runPipeline already committed to', () => {
  const root = makeProject();
  try {
    const config = {
      pipeline: {
        name: 'test',
        version: '1.0',
        entry: 'start',
        context: {},
        agents: {},
        stages: { start: { type: 'script', script: 'noop.js' } }
      }
    };

    // Иначе имя файла разошлось бы с тем, что уже записано в lock.
    const runner = new PipelineRunner(config, { project: root }, {
      runId: 'pipeline_2026-09-19_05-16-55',
      logFilePath: join(root, '.workflow', 'logs', 'pipeline_2026-09-19_05-16-55.log')
    });

    assert.equal(runner.runId, 'pipeline_2026-09-19_05-16-55');
    assert.equal(basename(runner.logFilePath), 'pipeline_2026-09-19_05-16-55.log');
  } finally {
    cleanup(root);
  }
});

test('buildRunId and resolveLogFilePath agree with each other', () => {
  const runId = PipelineRunner.buildRunId('2026-09-19T05:16:55.954Z');
  assert.equal(runId, 'pipeline_2026-09-19_05-16-55');

  const logPath = PipelineRunner.resolveLogFilePath({}, 'C:/project', runId);
  assert.equal(basename(logPath), `${runId}.log`);
  assert.ok(logPath.includes('.workflow'));
});

test('readMarker tolerates a half-written lock', () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, '.workflow', 'logs', '.pipeline.lock'), '{"pid": 12');
    assert.equal(readMarker(root), null);
    // Файл не тронут — чинить его не наше дело.
    assert.equal(readFileSync(join(root, '.workflow', 'logs', '.pipeline.lock'), 'utf8'), '{"pid": 12');
  } finally {
    cleanup(root);
  }
});
