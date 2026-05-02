import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { runPipeline } from '../runner.mjs';

const MARKER_PATH = (projectRoot) => join(projectRoot, '.workflow', 'logs', '.pipeline.lock');

function pollForFile(filePath, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(filePath)) {
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        reject(new Error(`Marker file not found within ${timeoutMs}ms: ${filePath}`));
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

test('singleton: second pipeline launch returns PIPELINE_ALREADY_RUNNING when marker exists with live pid', async () => {
  const projectRoot = resolve(process.cwd(), `.tmp-singleton-test-${Date.now()}`);
  mkdirSync(join(projectRoot, '.workflow', 'logs'), { recursive: true });

  const markerMjsUrl = pathToFileURL(resolve(process.cwd(), 'src/lib/marker.mjs')).href;
  const childScript = `
    const { writeMarker } = await import(${JSON.stringify(markerMjsUrl)});
    writeMarker(${JSON.stringify(projectRoot)}, {
      pid: process.pid,
      started_at: new Date().toISOString(),
      started_by: 'child-test',
      run_id: 'pipeline_test_child',
      pipeline_log: '.workflow/logs/pipeline_test_child.log',
      project_root: ${JSON.stringify(projectRoot)},
      pipeline_version: '1.0.0'
    });
    setInterval(() => {}, 60000);
  `;

  const child = spawn('node', ['-e', childScript], {
    stdio: 'pipe',
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' }
  });

  // Register before try block to avoid missing the event if child exits early
  const childClosePromise = new Promise((res) => child.once('close', res));

  try {
    await pollForFile(MARKER_PATH(projectRoot), { timeoutMs: 5000, intervalMs: 100 });

    const result = await runPipeline({ project: projectRoot });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'PIPELINE_ALREADY_RUNNING');
    assert.strictEqual(typeof result.pid, 'number');
    assert.ok(result.pid > 0, `pid should be positive, got ${result.pid}`);
    assert.strictEqual(typeof result.started_at, 'string');
    assert.ok(result.started_at.length > 0, 'started_at should not be empty');
  } finally {
    try {
      if (process.platform === 'win32') {
        const { execSync } = await import('node:child_process');
        try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe' }); } catch {}
      } else {
        child.kill('SIGTERM');
      }
      await childClosePromise;
    } catch {}
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}, { timeout: 30000 });
