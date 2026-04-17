#!/usr/bin/env node

/**
 * Интеграционные тесты для get-next-test-id.js
 *
 * Тестируют генерацию следующего ID тест-кейса:
 * - Пустая директория возвращает 001
 * - Нахождение максимума в cases/
 * - Учёт обоих источников (package + project)
 * - Формат вывода ---RESULT--- с полем next_id
 * - Uppercase имя скила
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'src', 'scripts', 'get-next-test-id.js');

function runScript(workdir, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH, ...args], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => { resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { reject(err); });

    setTimeout(() => reject(new Error('Timeout: ' + workdir)), 5000);
  });
}

function parseResult(stdout) {
  const marker = '---RESULT---';
  const startIdx = stdout.indexOf(marker);
  const endIdx = stdout.indexOf(marker, startIdx + marker.length);

  if (startIdx === -1 || endIdx === -1) return null;

  const block = stdout.substring(startIdx + marker.length, endIdx).trim();
  const data = {};
  for (const line of block.split('\n')) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) data[match[1].trim()] = match[2].trim();
  }
  return data;
}

function createTempProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-next-test-id-'));
  // findProjectRoot ищет .workflow/ от cwd вверх
  fs.mkdirSync(path.join(tmpDir, '.workflow'), { recursive: true });
  return tmpDir;
}

function createCasesDir(tmpDir, type, skillName) {
  let dir;
  if (type === 'package') {
    dir = path.join(tmpDir, 'src', 'skills', skillName, 'tests', 'cases');
  } else {
    dir = path.join(tmpDir, '.workflow', 'tests', 'skills', skillName, 'cases');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createCaseFile(dir, skillUpper, num) {
  const name = `TC-${skillUpper}-${String(num).padStart(3, '0')}.yaml`;
  fs.writeFileSync(path.join(dir, name), `id: TC-${skillUpper}-${String(num).padStart(3, '0')}\n`);
}

// ============================================================================
describe('get-next-test-id — Пустая директория возвращает 001', () => {
  let tmpDir = null;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('должен вернуть TC-COACH-001 при отсутствии файлов', async () => {
    // Директории cases/ вообще не существуют
    const result = await runScript(tmpDir, ['--skill', 'coach']);
    const data = parseResult(result.stdout);

    assert.ok(data, 'Должен быть RESULT-блок в выводе');
    assert.strictEqual(data.next_id, 'TC-COACH-001', 'Должен вернуть 001 для пустой директории');
  });

  it('должен вернуть TC-COACH-001 при пустой cases/ директории', async () => {
    // Директории существуют, но файлов нет
    createCasesDir(tmpDir, 'package', 'coach');
    createCasesDir(tmpDir, 'project', 'coach');

    const result = await runScript(tmpDir, ['--skill', 'coach']);
    const data = parseResult(result.stdout);

    assert.ok(data, 'Должен быть RESULT-блок в выводе');
    assert.strictEqual(data.next_id, 'TC-COACH-001', 'Должен вернуть 001 при пустых директориях');
  });
});

// ============================================================================
describe('get-next-test-id — Нахождение максимума в cases/', () => {
  let tmpDir = null;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('должен вернуть TC-COACH-004 при наличии файлов 001–003', async () => {
    const dir = createCasesDir(tmpDir, 'package', 'coach');
    createCaseFile(dir, 'COACH', 1);
    createCaseFile(dir, 'COACH', 2);
    createCaseFile(dir, 'COACH', 3);

    const result = await runScript(tmpDir, ['--skill', 'coach']);
    const data = parseResult(result.stdout);

    assert.ok(data, 'Должен быть RESULT-блок в выводе');
    assert.strictEqual(data.next_id, 'TC-COACH-004', 'Должен вернуть максимум+1');
  });

  it('должен вернуть TC-COACH-011 при максимальном 010', async () => {
    const dir = createCasesDir(tmpDir, 'package', 'coach');
    createCaseFile(dir, 'COACH', 10);

    const result = await runScript(tmpDir, ['--skill', 'coach']);
    const data = parseResult(result.stdout);

    assert.ok(data);
    assert.strictEqual(data.next_id, 'TC-COACH-011');
  });
});

// ============================================================================
describe('get-next-test-id — Учёт обоих источников (package + project)', () => {
  let tmpDir = null;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('должен взять максимум из project-источника если он больше', async () => {
    const pkgDir = createCasesDir(tmpDir, 'package', 'coach');
    const prjDir = createCasesDir(tmpDir, 'project', 'coach');

    createCaseFile(pkgDir, 'COACH', 2);  // package: max=2
    createCaseFile(prjDir, 'COACH', 5);  // project: max=5

    const result = await runScript(tmpDir, ['--skill', 'coach']);
    const data = parseResult(result.stdout);

    assert.ok(data);
    assert.strictEqual(data.next_id, 'TC-COACH-006', 'Должен использовать максимум из всех источников');
  });

  it('должен взять максимум из package-источника если он больше', async () => {
    const pkgDir = createCasesDir(tmpDir, 'package', 'coach');
    const prjDir = createCasesDir(tmpDir, 'project', 'coach');

    createCaseFile(pkgDir, 'COACH', 7);  // package: max=7
    createCaseFile(prjDir, 'COACH', 3);  // project: max=3

    const result = await runScript(tmpDir, ['--skill', 'coach']);
    const data = parseResult(result.stdout);

    assert.ok(data);
    assert.strictEqual(data.next_id, 'TC-COACH-008', 'Должен использовать максимум из package');
  });

  it('должен корректно работать когда только project-источник существует', async () => {
    const prjDir = createCasesDir(tmpDir, 'project', 'coach');
    createCaseFile(prjDir, 'COACH', 4);

    const result = await runScript(tmpDir, ['--skill', 'coach']);
    const data = parseResult(result.stdout);

    assert.ok(data);
    assert.strictEqual(data.next_id, 'TC-COACH-005');
  });
});

// ============================================================================
describe('get-next-test-id — Формат вывода ---RESULT---', () => {
  let tmpDir = null;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('вывод должен содержать валидные маркеры ---RESULT---', async () => {
    const result = await runScript(tmpDir, ['--skill', 'coach']);
    const marker = '---RESULT---';
    const first = result.stdout.indexOf(marker);
    const second = result.stdout.indexOf(marker, first + marker.length);

    assert.ok(first !== -1, 'Должен быть открывающий маркер ---RESULT---');
    assert.ok(second !== -1, 'Должен быть закрывающий маркер ---RESULT---');
  });

  it('блок RESULT должен содержать поле next_id', async () => {
    const result = await runScript(tmpDir, ['--skill', 'coach']);
    const data = parseResult(result.stdout);

    assert.ok(data, 'RESULT-блок должен быть распарсен');
    assert.ok('next_id' in data, 'Должно быть поле next_id');
    assert.ok(data.next_id.length > 0, 'next_id не должен быть пустым');
  });

  it('поле next_id должно соответствовать формату TC-SKILL-NNN', async () => {
    const result = await runScript(tmpDir, ['--skill', 'coach']);
    const data = parseResult(result.stdout);

    assert.ok(data);
    assert.match(data.next_id, /^TC-[A-Z0-9-]+-\d{3}$/, 'next_id должен соответствовать формату TC-SKILL-NNN');
  });
});

// ============================================================================
describe('get-next-test-id — Uppercase имя скила', () => {
  let tmpDir = null;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('--skill decompose-plan → TC-DECOMPOSE-PLAN-001', async () => {
    const result = await runScript(tmpDir, ['--skill', 'decompose-plan']);
    const data = parseResult(result.stdout);

    assert.ok(data);
    assert.strictEqual(data.next_id, 'TC-DECOMPOSE-PLAN-001');
  });

  it('--skill COACH (уже uppercase) → TC-COACH-001', async () => {
    const result = await runScript(tmpDir, ['--skill', 'COACH']);
    const data = parseResult(result.stdout);

    assert.ok(data);
    assert.strictEqual(data.next_id, 'TC-COACH-001');
  });

  it('--skill Coach (mixed case) → TC-COACH-001', async () => {
    const result = await runScript(tmpDir, ['--skill', 'Coach']);
    const data = parseResult(result.stdout);

    assert.ok(data);
    assert.strictEqual(data.next_id, 'TC-COACH-001');
  });
});

console.log('Running get-next-test-id tests...\n');
