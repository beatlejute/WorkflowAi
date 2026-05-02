import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { processAlive } from '../lib/process-alive.mjs';

test('processAlive(process.pid) → true (текущий процесс всегда жив)', () => {
  const result = processAlive(process.pid);
  assert.strictEqual(result, true, 'current process should be alive');
});

test('processAlive(99999999) → false (заведомо мёртвый PID)', () => {
  const result = processAlive(99999999);
  assert.strictEqual(result, false, 'non-existent PID should return false');
});

test('processAlive(-1) → false (отрицательный PID)', () => {
  const result = processAlive(-1);
  assert.strictEqual(result, false, 'negative PID should return false');
});

test('processAlive(NaN) → false', () => {
  const result = processAlive(NaN);
  assert.strictEqual(result, false, 'NaN should return false');
});

test('processAlive(null) → false', () => {
  const result = processAlive(null);
  assert.strictEqual(result, false, 'null should return false');
});
