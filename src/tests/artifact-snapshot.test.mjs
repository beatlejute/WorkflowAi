import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, diff, isEmpty } from '../lib/artifact-snapshot.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Кейс 1: snapshot пустой директории
test('Case 1: snapshot of empty directory', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    const snap1 = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: []
    });
    const snap2 = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: []
    });

    const result = diff(snap1, snap2);
    assert.strictEqual(result.created.length, 0, 'created array should be empty');
    assert.strictEqual(result.changed.length, 0, 'changed array should be empty');
    assert.strictEqual(result.deleted.length, 0, 'deleted array should be empty');
    assert.strictEqual(isEmpty(result), true, 'isEmpty should return true');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// Кейс 2: snapshot с добавленным файлом
test('Case 2: snapshot with added file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    // Снимок пустой директории
    const snap1 = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: []
    });

    // Добавляем файл
    fs.writeFileSync(path.join(tmpDir, 'test-file.txt'), 'test content');

    // Снимок после добавления
    const snap2 = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: []
    });

    const result = diff(snap1, snap2);
    assert.strictEqual(result.created.length, 1, 'created should contain 1 file');
    assert(result.created[0].includes('test-file.txt'), 'created should include test-file.txt');
    assert.strictEqual(result.changed.length, 0, 'changed array should be empty');
    assert.strictEqual(result.deleted.length, 0, 'deleted array should be empty');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// Кейс 3: snapshot с изменённым содержимым (разный sha1 при одинаковом mtime+size)
test('Case 3: snapshot with changed content (different sha1)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    // Создаём файл
    const filePath = path.join(tmpDir, 'test-file.txt');
    const content = 'original content that is long enough to ensure same size when modified';
    fs.writeFileSync(filePath, content);

    // Первый снимок
    const snap1 = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: []
    });

    // Модифицируем содержимое (тот же размер)
    const newContent = 'modified content that is long enough to ensure same size when modified';
    assert.strictEqual(content.length, newContent.length, 'content must be same length');
    fs.writeFileSync(filePath, newContent);

    // Второй снимок
    const snap2 = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: []
    });

    const result = diff(snap1, snap2);
    assert.strictEqual(result.changed.length, 1, 'changed should contain 1 file');
    assert(result.changed[0].includes('test-file.txt'), 'changed should include test-file.txt');
    assert.strictEqual(result.created.length, 0, 'created array should be empty');
    assert.strictEqual(result.deleted.length, 0, 'deleted array should be empty');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// Кейс 4: snapshot с удалённым файлом
test('Case 4: snapshot with deleted file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    // Создаём файл
    const filePath = path.join(tmpDir, 'test-file.txt');
    fs.writeFileSync(filePath, 'test content');

    // Первый снимок
    const snap1 = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: []
    });

    // Удаляем файл
    fs.unlinkSync(filePath);

    // Второй снимок
    const snap2 = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: []
    });

    const result = diff(snap1, snap2);
    assert.strictEqual(result.deleted.length, 1, 'deleted should contain 1 file');
    assert(result.deleted[0].includes('test-file.txt'), 'deleted should include test-file.txt');
    assert.strictEqual(result.created.length, 0, 'created array should be empty');
    assert.strictEqual(result.changed.length, 0, 'changed array should be empty');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// Кейс 5: excludePatterns корректно исключает файлы
test('Case 5: excludePatterns correctly exclude files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    // Создаём структуру директорий
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

    // Добавляем файлы
    fs.writeFileSync(path.join(tmpDir, 'logs', 'file.log'), 'log content');
    fs.writeFileSync(path.join(tmpDir, 'state', 'state.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'code');

    // Снимок с исключениями
    const snap1 = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: ['logs/**', 'state/**']
    });

    // Модифицируем исключённые файлы
    fs.writeFileSync(path.join(tmpDir, 'logs', 'file.log'), 'modified log');
    fs.writeFileSync(path.join(tmpDir, 'state', 'state.json'), '{"x":1}');

    // Второй снимок
    const snap2 = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: ['logs/**', 'state/**']
    });

    const result = diff(snap1, snap2);
    // Изменения в исключённых директориях не должны обнаруживаться
    assert.strictEqual(result.changed.length, 0, 'excluded files should not be in changed');
    assert.strictEqual(result.created.length, 0, 'excluded files should not be in created');
    assert.strictEqual(result.deleted.length, 0, 'excluded files should not be in deleted');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// Кейс 6: Файл > snapshot_max_file_size сравнивается только по mtime+size (sha1 не считается)
test('Case 6: file larger than snapshot_max_file_size has no sha1', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    const filePath = path.join(tmpDir, 'large-file.bin');
    const fileSize = 600000; // > DEFAULT_SNAPSHOT_MAX_FILE_SIZE (524288)

    // Создаём большой файл
    fs.writeFileSync(filePath, Buffer.alloc(fileSize, 'x'));

    const snap = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: [],
      snapshotMaxFileSize: 524288
    });

    const fileRecord = snap.fs.get(
      Array.from(snap.fs.keys()).find(k => k.includes('large-file'))
    );

    assert(fileRecord, 'file should be in snapshot');
    assert.strictEqual(fileRecord.sha1, null, 'sha1 should be null for large files');
    assert(fileRecord.mtime !== undefined, 'mtime should be present');
    assert(fileRecord.size !== undefined, 'size should be present');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// Кейс 7: Вне git-репозитория git-часть snapshot возвращает пустую строку
test('Case 7: snapshot outside git repo returns empty git output', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'content');

    const snap = await snapshot(tmpDir, {
      includePaths: ['.'],
      excludePatterns: []
    });

    assert.strictEqual(snap.git, '', 'git output should be empty outside git repo');
    assert(snap.fs instanceof Map, 'fs should be a Map');
    assert(snap.fs.size > 0, 'fs map should contain files');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// Кейс 8: Benchmark на реальном src/ репо
test('Case 8: benchmark snapshot on real src directory', async (t) => {
  const projectRoot = path.resolve(__dirname, '../..');
  const iterations = 10;
  const durations = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const snap = await snapshot(projectRoot, {
      includePaths: ['src'],
      excludePatterns: []
    });
    const end = performance.now();

    durations.push(end - start);
  }

  // Вычисляем median и p95
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const median = sortedDurations[Math.floor(sortedDurations.length / 2)];
  const p95Idx = Math.ceil(sortedDurations.length * 0.95) - 1;
  const p95 = sortedDurations[p95Idx];

  const fileCountSnap = await snapshot(projectRoot, {
    includePaths: ['src'],
    excludePatterns: []
  });
  const fileCount = fileCountSnap.fs.size;

  console.log(`[benchmark] snapshot p50=${Math.round(median)}ms p95=${Math.round(p95)}ms files=${fileCount}`);

  assert(median < 800, `median (${Math.round(median)}ms) should be < 800ms`);
  assert(p95 < 1500, `p95 (${Math.round(p95)}ms) should be < 1500ms`);
});

// Кейс 9: isEmpty возвращает true только при всех трёх массивах пустых
test('Case 9: isEmpty returns true only when all arrays are empty', async () => {
  // Все пустые
  assert.strictEqual(
    isEmpty({ created: [], changed: [], deleted: [] }),
    true,
    'isEmpty should return true when all arrays are empty'
  );

  // created не пустой
  assert.strictEqual(
    isEmpty({ created: ['file.txt'], changed: [], deleted: [] }),
    false,
    'isEmpty should return false when created is not empty'
  );

  // changed не пустой
  assert.strictEqual(
    isEmpty({ created: [], changed: ['file.txt'], deleted: [] }),
    false,
    'isEmpty should return false when changed is not empty'
  );

  // deleted не пустой
  assert.strictEqual(
    isEmpty({ created: [], changed: [], deleted: ['file.txt'] }),
    false,
    'isEmpty should return false when deleted is not empty'
  );

  // все три непустые
  assert.strictEqual(
    isEmpty({ created: ['file1.txt'], changed: ['file2.txt'], deleted: ['file3.txt'] }),
    false,
    'isEmpty should return false when any array is not empty'
  );
});

// Кейс 10: snapshot при отсутствующем пути в includePaths
test('Case 10: snapshot with missing path in includePaths', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    // Создаём структуру
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'code');

    // Снимок с существующей и несуществующей директорией
    const snap = await snapshot(tmpDir, {
      includePaths: ['src', 'missing-dir'],
      excludePatterns: []
    });

    // Несуществующая директория должна быть проигнорирована
    assert(snap.fs.size > 0, 'snapshot should contain files from existing path');
    assert(
      Array.from(snap.fs.keys()).some(k => k.includes('app.js')),
      'src directory files should be included'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});
