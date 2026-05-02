import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stopPipeline } from '../lib/stop-command.mjs';
import { writeMarker, readMarker } from '../lib/marker.mjs';
import { processAlive } from '../lib/process-alive.mjs';

/**
 * Creates a fixture process that simply waits (infinite loop)
 * It respects SIGTERM by default in Node.js
 */
function createFixtureScript() {
  return `
// Fixture process — just waits in a loop
// Keep process alive
setInterval(() => {
  // do nothing
}, 1000);

// Handle graceful shutdown
process.on('SIGTERM', () => {
  process.exit(0);
});
`;
}

/**
 * Poll for a condition with timeout
 */
async function pollUntil(condition, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

test('graceful stop: fixture process terminates after SIGTERM, marker removed', async () => {
  const projectRoot = resolve(tmpdir(), `stop-cmd-test-graceful-${Date.now()}`);
  const fixtureScriptPath = join(projectRoot, 'fixture.mjs');

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, '.workflow', 'logs'), { recursive: true });

  try {
    // 1. Create and write fixture script
    writeFileSync(fixtureScriptPath, createFixtureScript());

    // 2. Spawn fixture process
    const fixture = spawn('node', [fixtureScriptPath], {
      stdio: 'pipe',
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'test' }
    });

    // 3. Get fixture PID from spawn result
    const fixturePid = fixture.pid;
    assert.ok(Number.isInteger(fixturePid) && fixturePid > 0, 'fixture PID should be valid');

    // 5. Verify fixture is alive
    assert.ok(processAlive(fixturePid), 'fixture process should be alive');

    // 6. Write marker with fixture PID
    writeMarker(projectRoot, {
      pid: fixturePid,
      started_at: new Date().toISOString(),
      started_by: 'test',
      run_id: `pipeline_test_${Date.now()}`,
      pipeline_log: '.workflow/logs/pipeline_test.log',
      project_root: projectRoot,
      pipeline_version: '1.3.0'
    });

    // 7. Verify marker exists
    let marker = readMarker(projectRoot);
    assert.ok(marker, 'marker should exist after write');
    assert.strictEqual(marker.pid, fixturePid, 'marker PID should match fixture PID');

    // 8. Call stopPipeline with graceful shutdown (10 sec grace period)
    const result = await stopPipeline(projectRoot, { graceSec: 10 });

    // 9. Check result
    assert.strictEqual(result.ok, true, 'stopPipeline should return ok: true');
    assert.strictEqual(result.pid, fixturePid, 'result should contain fixture PID');
    assert.strictEqual(result.escalated, false, 'graceful shutdown should not escalate (SIGTERM sufficient)');
    assert.ok(typeof result.duration_ms === 'number', 'result should contain duration_ms');
    assert.ok(result.duration_ms < 5000, 'fixture should die quickly (under 5 sec)');

    // 10. Verify fixture process is dead
    const processTerminated = await pollUntil(
      () => !processAlive(fixturePid),
      3000
    );
    assert.ok(processTerminated, 'fixture process should be terminated after stopPipeline');

    // 11. Verify marker is removed
    marker = readMarker(projectRoot);
    assert.strictEqual(marker, null, 'marker should be removed after stopPipeline');

  } finally {
    // Cleanup
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}, { timeout: 30000 });

test('stale stop: no-live process, marker removed, returns was_stale', async () => {
  const projectRoot = resolve(tmpdir(), `stop-cmd-test-stale-${Date.now()}`);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, '.workflow', 'logs'), { recursive: true });

  try {
    // Write marker with dead PID (invalid PID)
    writeMarker(projectRoot, {
      pid: 999999999,
      started_at: new Date().toISOString(),
      started_by: 'test',
      run_id: `pipeline_test_${Date.now()}`,
      pipeline_log: '.workflow/logs/pipeline_test.log',
      project_root: projectRoot,
      pipeline_version: '1.3.0'
    });

    // Verify marker exists
    let marker = readMarker(projectRoot);
    assert.ok(marker, 'marker should exist');

    // Call stopPipeline
    const result = await stopPipeline(projectRoot, { graceSec: 10 });

    // Check result
    assert.strictEqual(result.ok, true, 'stopPipeline should return ok: true');
    assert.strictEqual(result.was_stale, true, 'should indicate marker was stale');

    // Verify marker is removed
    marker = readMarker(projectRoot);
    assert.strictEqual(marker, null, 'stale marker should be removed');

  } finally {
    // Cleanup
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
});

test('not running: no marker, returns NOT_RUNNING', async () => {
  const projectRoot = resolve(tmpdir(), `stop-cmd-test-not-running-${Date.now()}`);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, '.workflow', 'logs'), { recursive: true });

  try {
    // Verify no marker
    const marker = readMarker(projectRoot);
    assert.strictEqual(marker, null, 'marker should not exist');

    // Call stopPipeline
    const result = await stopPipeline(projectRoot, { graceSec: 10 });

    // Check result
    assert.strictEqual(result.ok, false, 'stopPipeline should return ok: false');
    assert.strictEqual(result.code, 'NOT_RUNNING', 'should return NOT_RUNNING code');

  } finally {
    // Cleanup
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
});
