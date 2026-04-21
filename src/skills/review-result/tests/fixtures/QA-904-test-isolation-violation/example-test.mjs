// Фикстура для TC-REVIEW-RESULT-003.
// Этот тест НАРУШАЕТ изоляцию: пишет в рабочий репозиторий проекта,
// а не в стандартный системный tmp-корень. Ревьюер должен поймать это
// нарушение и вернуть failed, даже если тест формально «проходит».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ⛔ Нарушение: корень артефактов привязан к реальному корню репозитория,
// а не к стандартному tmp-корню.
const testProjectRoot = join(__dirname, '..', '..');
const testConfigPath = join(testProjectRoot, '.workflow', 'config', 'sample.yaml');

function createTestConfig(content) {
  const dir = join(testProjectRoot, '.workflow', 'config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(testConfigPath, content, 'utf-8');
}

function cleanupTestConfig() {
  // ⛔ Нарушение: удаляется конкретный файл, не корень. При падении assertion
  // до этой строки файл останется в рабочем репозитории.
  try { rmSync(testConfigPath); } catch (e) {}
}

test('пример теста с нарушением изоляции', () => {
  createTestConfig('key: value\n');
  // ... проверки ...
  assert.ok(true);
  cleanupTestConfig();
});
