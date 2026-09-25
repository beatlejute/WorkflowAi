/**
 * Состав npm-пакета.
 *
 * 1.7.3 ушёл в npm со списком `files`, в котором от скилов были только
 * `SKILL.md` и `index.mjs`: без `rails.yaml`, knowledge/, workflows/,
 * algorithms/, templates/ и scripts/ скилов. Установка из npm давала скилы без
 * графа рельсов и без файлов, на которые ссылается их текст. Тест сверяет то,
 * что `npm pack` кладёт в пакет, с деревом скилов на диске.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// __test-* — временные скилы, которые параллельные тесты создают и удаляют в каноне.
const isTransient = (rel) => rel.split('/').some((seg) => seg.startsWith('__test-'));

function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'tests') continue;
      out.push(...walk(path.join(dir, entry.name), relPath));
    } else {
      out.push(relPath);
    }
  }
  return out;
}

describe('npm package contents', () => {
  let packed;

  before(() => {
    const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      shell: process.platform === 'win32',
    });
    assert.equal(res.status, 0, `npm pack failed: ${res.stderr}`);
    packed = new Set(JSON.parse(res.stdout)[0].files.map((f) => f.path).filter((p) => !isTransient(p)));
  });

  test('every skill file except tests is packed', () => {
    const onDisk = walk(path.join(repoRoot, 'src', 'skills'))
      .map((rel) => `src/skills/${rel}`)
      .filter((p) => !isTransient(p));
    const missing = onDisk.filter((p) => !packed.has(p));
    assert.deepEqual(missing, []);
    assert.ok(packed.has('src/skills/create-plan/rails.yaml'));
  });

  test('tests are not packed', () => {
    const leaked = [...packed].filter((p) => p.split('/').includes('tests'));
    assert.deepEqual(leaked, []);
  });

  test('lib and rails core are packed for the global dir copy', () => {
    for (const p of ['src/lib/find-root.mjs', 'src/lib/js-yaml.mjs', 'src/rails/core.mjs', 'src/rails/claude-hook.mjs']) {
      assert.ok(packed.has(p), `${p} missing from package`);
    }
  });
});
