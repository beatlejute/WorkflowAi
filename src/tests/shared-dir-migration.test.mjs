// Перенос shared knowledge проекта из .workflow/src/skills/shared/ в .workflow/shared/
// (migrateProjectSharedDir, вызывают workflow update и init). Инцидент PulseProxy
// DOCS-014 (2026-09-30): shared внутри каталога скилов попал под запрет записи
// исполнителю. Изоляция: каждый тест в своём каталоге ОС tmp, удаляется в afterEach.
import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { migrateProjectSharedDir, createJunction } from '../junction-manager.mjs';

describe('migrateProjectSharedDir', () => {
  let root;
  let workflowRoot;
  let oldDir;
  let newDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shared-migration-'));
    workflowRoot = join(root, '.workflow');
    oldDir = join(workflowRoot, 'src', 'skills', 'shared');
    newDir = join(workflowRoot, 'shared');
    mkdirSync(join(workflowRoot, 'src', 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('moves the old folder when the new place is empty', () => {
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, 'README.md'), '# index');
    writeFileSync(join(oldDir, 'module.md'), 'module');

    const r = migrateProjectSharedDir(workflowRoot);

    assert.equal(r.status, 'moved');
    assert.deepEqual(r.moved.sort(), ['README.md', 'module.md']);
    assert.equal(readFileSync(join(newDir, 'README.md'), 'utf8'), '# index');
    assert.equal(existsSync(oldDir), false);
  });

  test('creates an empty new folder when there is no old one, and a second run is a no-op', () => {
    assert.equal(migrateProjectSharedDir(workflowRoot).status, 'none');
    assert.deepEqual(readdirSync(newDir), []);
    rmSync(newDir, { recursive: true });

    mkdirSync(oldDir);
    writeFileSync(join(oldDir, 'README.md'), '# index');
    migrateProjectSharedDir(workflowRoot);
    const second = migrateProjectSharedDir(workflowRoot);
    assert.equal(second.status, 'none');
    assert.deepEqual(readdirSync(newDir), ['README.md']);
  });

  test('merges into an existing new folder and removes the emptied old one', () => {
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(join(oldDir, 'old-module.md'), 'old');
    writeFileSync(join(newDir, 'README.md'), '# new index');

    const r = migrateProjectSharedDir(workflowRoot);

    assert.equal(r.status, 'merged');
    assert.deepEqual(r.moved, ['old-module.md']);
    assert.deepEqual(readdirSync(newDir).sort(), ['README.md', 'old-module.md']);
    assert.equal(existsSync(oldDir), false);
  });

  test('never overwrites a file of the new place: the old copy stays where it was', () => {
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(join(oldDir, 'README.md'), '# old index');
    writeFileSync(join(oldDir, 'extra.md'), 'extra');
    writeFileSync(join(newDir, 'README.md'), '# new index');

    const r = migrateProjectSharedDir(workflowRoot);

    assert.equal(r.status, 'partial');
    assert.deepEqual(r.kept, ['README.md']);
    assert.deepEqual(r.moved, ['extra.md']);
    assert.equal(readFileSync(join(newDir, 'README.md'), 'utf8'), '# new index');
    assert.equal(readFileSync(join(oldDir, 'README.md'), 'utf8'), '# old index');
  });

  test('leaves a linked old folder alone', () => {
    const target = join(root, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, 'README.md'), '# linked');
    createJunction(target, oldDir);

    const r = migrateProjectSharedDir(workflowRoot);

    assert.equal(r.status, 'skipped');
    assert.equal(lstatSync(oldDir).isSymbolicLink(), true);
    assert.equal(existsSync(newDir), false);
    assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '# linked');
  });
});
