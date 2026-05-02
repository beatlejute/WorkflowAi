import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import {
  writeMarker,
  readMarker,
  removeMarker,
  validateMarker
} from '../lib/marker.mjs';

test('write → read: writeMarker() → readMarker() returns same payload (deep equal)', () => {
  const projectRoot = join(tmpdir(), `marker-test-write-read-${Date.now()}`);
  const payload = {
    pid: 12345,
    started_at: '2026-05-01T05:42:32Z',
    started_by: 'cli',
    run_id: 'pipeline_2026-05-01_05-42-32',
    pipeline_log: '.workflow/logs/pipeline_2026-05-01_05-42-32.log',
    project_root: projectRoot,
    pipeline_version: '1.3.0'
  };

  try {
    writeMarker(projectRoot, payload);
    const readPayload = readMarker(projectRoot);
    assert.deepStrictEqual(readPayload, payload, 'read payload should match written payload');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('remove → read null: writeMarker → removeMarker → readMarker returns null', () => {
  const projectRoot = join(tmpdir(), `marker-test-remove-${Date.now()}`);
  const payload = {
    pid: 12346,
    started_at: '2026-05-01T05:42:32Z',
    started_by: 'cli',
    run_id: 'pipeline_2026-05-01_05-42-32',
    pipeline_log: '.workflow/logs/pipeline_2026-05-01_05-42-32.log',
    project_root: projectRoot,
    pipeline_version: '1.3.0'
  };

  try {
    writeMarker(projectRoot, payload);
    removeMarker(projectRoot);
    const readPayload = readMarker(projectRoot);
    assert.strictEqual(readPayload, null, 'readMarker should return null after removeMarker');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('auto-create dir: writeMarker on non-existent directory creates directory and writes file without error', () => {
  const projectRoot = join(tmpdir(), `marker-test-auto-create-${Date.now()}`);
  const payload = {
    pid: 12347,
    started_at: '2026-05-01T05:42:32Z',
    started_by: 'cli',
    run_id: 'pipeline_2026-05-01_05-42-32',
    pipeline_log: '.workflow/logs/pipeline_2026-05-01_05-42-32.log',
    project_root: projectRoot,
    pipeline_version: '1.3.0'
  };

  try {
    // Don't create .workflow/logs directory beforehand
    assert.throws(
      () => readFileSync(join(projectRoot, '.workflow', 'logs', '.pipeline.lock'), 'utf-8'),
      'marker file should not exist before writeMarker'
    );

    // writeMarker should create the directory and write the file
    writeMarker(projectRoot, payload);

    const readPayload = readMarker(projectRoot);
    assert.deepStrictEqual(readPayload, payload, 'marker should be readable after auto-create dir');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('atomic write concurrent: Promise.all([writeMarker(p, payload1), writeMarker(p, payload2)]) completes and file contains valid JSON', async () => {
  const projectRoot = join(tmpdir(), `marker-test-atomic-${Date.now()}`);
  const payload1 = {
    pid: 11111,
    started_at: '2026-05-01T05:42:32Z',
    started_by: 'cli',
    run_id: 'pipeline_1_2026-05-01_05-42-32',
    pipeline_log: '.workflow/logs/pipeline_1.log',
    project_root: projectRoot,
    pipeline_version: '1.3.0'
  };
  const payload2 = {
    pid: 22222,
    started_at: '2026-05-01T05:42:33Z',
    started_by: 'runner',
    run_id: 'pipeline_2_2026-05-01_05-42-33',
    pipeline_log: '.workflow/logs/pipeline_2.log',
    project_root: projectRoot,
    pipeline_version: '1.3.0'
  };

  try {
    // Execute both writes concurrently with allSettled to catch any errors
    const results = await Promise.allSettled([
      new Promise((resolve, reject) => {
        try {
          writeMarker(projectRoot, payload1);
          resolve();
        } catch (err) {
          reject(err);
        }
      }),
      new Promise((resolve, reject) => {
        try {
          writeMarker(projectRoot, payload2);
          resolve();
        } catch (err) {
          reject(err);
        }
      })
    ]);

    // At least one write should succeed (the first one)
    assert.ok(
      results.some(r => r.status === 'fulfilled'),
      'at least one concurrent write should succeed'
    );

    // The file should contain valid JSON (not corrupted)
    const readPayload = readMarker(projectRoot);
    assert.ok(readPayload !== null, 'file should contain valid JSON (not null/corrupted)');
    assert.ok(typeof readPayload === 'object', 'parsed content should be an object');
    assert.ok(readPayload.pid !== undefined, 'parsed content should have pid property');

    // Verify the JSON is valid by checking it matches one of the payloads
    const pids = [payload1.pid, payload2.pid];
    assert.ok(
      pids.includes(readPayload.pid),
      'file should contain one of the written payloads'
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('validateMarker: returns true when pid matches, false otherwise, false after removeMarker', () => {
  const projectRoot = join(tmpdir(), `marker-test-validate-${Date.now()}`);
  const payload = {
    pid: 55555,
    started_at: '2026-05-01T05:42:32Z',
    started_by: 'cli',
    run_id: 'pipeline_2026-05-01_05-42-32',
    pipeline_log: '.workflow/logs/pipeline_2026-05-01_05-42-32.log',
    project_root: projectRoot,
    pipeline_version: '1.3.0'
  };

  try {
    writeMarker(projectRoot, payload);

    // Should return true when pid matches
    assert.strictEqual(
      validateMarker(projectRoot, 55555),
      true,
      'validateMarker should return true when pid matches'
    );

    // Should return false when pid does not match
    assert.strictEqual(
      validateMarker(projectRoot, 99999),
      false,
      'validateMarker should return false when pid does not match'
    );

    // Should return false after removeMarker
    removeMarker(projectRoot);
    assert.strictEqual(
      validateMarker(projectRoot, 55555),
      false,
      'validateMarker should return false after removeMarker'
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
