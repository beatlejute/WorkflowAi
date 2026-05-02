import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stopPipeline } from '../lib/stop-command.mjs';
import { writeMarker, readMarker } from '../lib/marker.mjs';
import { processAlive } from '../lib/process-alive.mjs';

/**
 * Creates a fixture process that ignores SIGTERM.
 * This process keeps running even when sent SIGTERM signal.
 * Only SIGKILL will kill it.
 */
function createIgnoreSigtermFixture() {
  return `
// Fixture process that ignores SIGTERM
// Only SIGKILL will terminate it

// Ignore SIGTERM by registering empty handler
// This prevents default Node.js behavior (graceful shutdown)
process.on('SIGTERM', () => {
  // Intentionally do nothing — ignore SIGTERM signal
});

// Keep process alive with a simple loop
// Using setInterval with a short interval to ensure process is responsive
const interval = setInterval(() => {
  // Process stays alive
}, 100);

// Prevent process from exiting
process.stdin.resume();
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

// Platform-specific test: escalation to SIGKILL only on POSIX
// On Windows, taskkill /T /F is used instead, so escalation=false is expected
const escalationTest = process.platform === 'win32' ? test.skip : test;

escalationTest('escalation to SIGKILL: fixture ignores SIGTERM, escalated after grace-sec, then killed', async () => {
  const projectRoot = resolve(tmpdir(), `stop-cmd-test-escalate-${Date.now()}`);
  const fixtureScriptPath = join(projectRoot, 'fixture.mjs');

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, '.workflow', 'logs'), { recursive: true });

  try {
    // 1. Create fixture script that ignores SIGTERM
    writeFileSync(fixtureScriptPath, createIgnoreSigtermFixture());

    // 2. Spawn fixture process
    const fixture = spawn('node', [fixtureScriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'test' }
    });

    // 3. Get fixture PID immediately
    const fixturePid = fixture.pid;
    assert.ok(Number.isInteger(fixturePid) && fixturePid > 0, 'fixture PID should be valid');

    // 4. Wait a moment for process to stabilize, then verify it's alive
    await new Promise(r => setTimeout(r, 300));
    assert.ok(processAlive(fixturePid), 'fixture process should be alive');

    // 5. Write marker with fixture PID
    writeMarker(projectRoot, {
      pid: fixturePid,
      started_at: new Date().toISOString(),
      started_by: 'test',
      run_id: `pipeline_test_${Date.now()}`,
      pipeline_log: '.workflow/logs/pipeline_test.log',
      project_root: projectRoot,
      pipeline_version: '1.3.0'
    });

    // 6. Verify marker exists
    let marker = readMarker(projectRoot);
    assert.ok(marker, 'marker should exist after write');
    assert.strictEqual(marker.pid, fixturePid, 'marker PID should match fixture PID');

    // 7. Call stopPipeline with short grace period (1 sec) to force escalation
    const result = await stopPipeline(projectRoot, { graceSec: 1 });

    // 8. Check result indicates escalation occurred (POSIX only)
    assert.strictEqual(result.ok, true, 'stopPipeline should return ok: true');
    assert.strictEqual(result.pid, fixturePid, 'result should contain fixture PID');
    assert.strictEqual(result.escalated, true, `escalation flag should be true (SIGKILL was needed), got: ${result.escalated}`);
    assert.ok(typeof result.duration_ms === 'number', 'result should contain duration_ms');
    assert.ok(
      result.duration_ms >= 1000,
      `duration_ms should be >= 1000ms (waited grace-sec). Got: ${result.duration_ms}ms`
    );

    // 9. Verify fixture process is dead
    const processTerminated = await pollUntil(
      () => !processAlive(fixturePid),
      3000
    );
    assert.ok(processTerminated, 'fixture process should be terminated after SIGKILL');

    // 10. Verify marker is removed
    marker = readMarker(projectRoot);
    assert.strictEqual(marker, null, 'marker should be removed after stopPipeline');

  } finally {
    // Cleanup
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
}, { timeout: 30000 });
