import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolve, join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { writeMarker, readMarker, removeMarker } from '../lib/marker.mjs';
import { processAlive } from '../lib/process-alive.mjs';

test('stale-cleanup: stale marker (dead pid) is auto-removed on new runPipeline attempt', () => {
  const projectRoot = resolve('/tmp', `stale-cleanup-test-${Date.now()}`);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, '.workflow', 'logs'), { recursive: true });

  try {
    // Create a marker with a definitely-dead PID
    const deadPid = 99999999;
    writeMarker(projectRoot, {
      pid: deadPid,
      started_at: new Date().toISOString(),
      started_by: 'test',
      run_id: `pipeline_test_${Date.now()}`,
      pipeline_log: '.workflow/logs/pipeline_test.log',
      project_root: projectRoot,
      pipeline_version: '1.0.0'
    });

    // Verify marker exists
    let marker = readMarker(projectRoot);
    assert.ok(marker, 'marker should exist');
    assert.strictEqual(marker.pid, deadPid);

    // Verify the PID is actually dead
    assert.strictEqual(processAlive(deadPid), false, 'dead PID should not be alive');

    // Simulate what runPipeline does: check for stale marker and remove
    const existing = readMarker(projectRoot);
    if (existing) {
      if (processAlive(existing.pid)) {
        // Process is alive - should not happen here
        assert.fail('PID should be dead');
      } else {
        // Stale marker - log and remove
        console.warn(`[runner] stale marker found (pid ${existing.pid} not alive) — removing`);
        removeMarker(projectRoot);
      }
    }

    // Verify marker was removed
    marker = readMarker(projectRoot);
    assert.strictEqual(marker, null, 'marker should be removed after stale cleanup');
  } finally {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
});

test('stale-cleanup: live marker is NOT removed during stale check', () => {
  const projectRoot = resolve('/tmp', `stale-cleanup-live-test-${Date.now()}`);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, '.workflow', 'logs'), { recursive: true });

  try {
    // Create a marker with current live PID
    writeMarker(projectRoot, {
      pid: process.pid,
      started_at: new Date().toISOString(),
      started_by: 'test',
      run_id: `pipeline_test_${Date.now()}`,
      pipeline_log: '.workspace/logs/pipeline_test.log',
      project_root: projectRoot,
      pipeline_version: '1.0.0'
    });

    // Verify marker exists
    let marker = readMarker(projectRoot);
    assert.ok(marker, 'marker should exist');
    assert.strictEqual(marker.pid, process.pid);

    // Verify the PID is alive
    assert.strictEqual(processAlive(process.pid), true, 'current PID should be alive');

    // Simulate stale check - should NOT remove because process is alive
    const existing = readMarker(projectRoot);
    if (existing) {
      if (processAlive(existing.pid)) {
        // Process is alive - do NOT remove, this should trigger PIPELINE_ALREADY_RUNNING instead
        // (leave marker in place)
      } else {
        // Stale marker - remove
        removeMarker(projectRoot);
      }
    }

    // Verify marker is still there (not removed)
    marker = readMarker(projectRoot);
    assert.ok(marker, 'marker should still exist for live process');
    assert.strictEqual(marker.pid, process.pid);

    // Cleanup manually
    removeMarker(projectRoot);

    // Verify removal
    marker = readMarker(projectRoot);
    assert.strictEqual(marker, null, 'marker should be removable');
  } finally {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
});

test('stale-cleanup: marker removed by one process does not affect others', () => {
  const projectRoot = resolve('/tmp', `stale-cleanup-multi-${Date.now()}`);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, '.workflow', 'logs'), { recursive: true });

  try {
    // Process A writes marker
    writeMarker(projectRoot, {
      pid: 10001,
      started_at: new Date().toISOString(),
      started_by: 'process-a',
      run_id: `pipeline_a_${Date.now()}`,
      pipeline_log: '.workspace/logs/pipeline_a.log',
      project_root: projectRoot,
      pipeline_version: '1.0.0'
    });

    let marker = readMarker(projectRoot);
    assert.strictEqual(marker.pid, 10001);
    assert.strictEqual(marker.started_by, 'process-a');

    // Process A finishes and removes marker
    removeMarker(projectRoot);

    // Verify marker is gone
    marker = readMarker(projectRoot);
    assert.strictEqual(marker, null);

    // Process B can now write its own marker
    writeMarker(projectRoot, {
      pid: 10002,
      started_at: new Date().toISOString(),
      started_by: 'process-b',
      run_id: `pipeline_b_${Date.now()}`,
      pipeline_log: '.workspace/logs/pipeline_b.log',
      project_root: projectRoot,
      pipeline_version: '1.0.0'
    });

    marker = readMarker(projectRoot);
    assert.strictEqual(marker.pid, 10002);
    assert.strictEqual(marker.started_by, 'process-b');
  } finally {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }
});