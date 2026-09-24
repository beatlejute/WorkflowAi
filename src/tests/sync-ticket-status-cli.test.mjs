/**
 * Оболочка командной строки синхронизации статусов (src/scripts/sync-ticket-status.js).
 * Логика — в sync-ticket-status-core.js и проверена отдельно
 * (race-sync-ticket-status-atomic-write.test.mjs); здесь — то, что видит человек:
 * режим по умолчанию только показывает расхождения и ничего не пишет, --apply пишет,
 * --project указывает чужой проект, а блок результата честно считает правки.
 *
 * Цена ошибки оболочки: если dry-run вдруг начнёт писать, разовая миграция запустится
 * там, где человек хотел только посмотреть, — статусы и completed_at на всей доске
 * перепишутся без спроса.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/sync-ticket-status-cli.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sync-ticket-status.js');

function withBoard(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-status-cli-'));
  for (const dir of ['ready', 'done']) fs.mkdirSync(path.join(root, '.workflow', 'tickets', dir), { recursive: true });
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(...args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const block = `${res.stdout}`.split('---RESULT---')[1] || '';
  const field = (name) => (block.match(new RegExp(`${name}:\\s*(\\S+)`)) || [])[1];
  return { code: res.status, out: `${res.stdout}`, status: field('status'), fixed: field('status_fixed'), filled: field('completed_at_filled') };
}

const ticket = (id, status) => `---\nid: "${id}"\ntitle: "Задача"\nstatus: ${status}\n---\n\n# Тикет\n`;

test('dry-run: расхождения показаны, файлы не тронуты', () => {
  withBoard((root) => {
    const file = path.join(root, '.workflow', 'tickets', 'ready', 'IMPL-001.md');
    fs.writeFileSync(file, ticket('IMPL-001', 'backlog'), 'utf8');
    const before = fs.readFileSync(file, 'utf8');

    const r = run('--project', root);

    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /dry-run/);
    assert.match(r.out, /IMPL-001: backlog → ready/);
    assert.equal(r.status, 'synced');
    assert.equal(r.fixed, '1');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'dry-run ничего не пишет');
  });
});

test('--apply: статус приведён к папке, completed_at проставлен с предупреждением о приближении', () => {
  withBoard((root) => {
    const ready = path.join(root, '.workflow', 'tickets', 'ready', 'IMPL-002.md');
    const done = path.join(root, '.workflow', 'tickets', 'done', 'IMPL-003.md');
    fs.writeFileSync(ready, ticket('IMPL-002', 'backlog'), 'utf8');
    fs.writeFileSync(done, ticket('IMPL-003', 'done'), 'utf8');

    const r = run('--project', root, '--apply');

    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Режим: запись/);
    assert.match(r.out, /completed_at проставлен по mtime файла \(приближение\): 1/);
    assert.equal(r.fixed, '1');
    assert.equal(r.filled, '1');
    assert.match(fs.readFileSync(ready, 'utf8'), /status: ready/);
    assert.match(fs.readFileSync(done, 'utf8'), /completed_at:/);
  });
});

test('чистая доска: status clean и сообщение «расхождений нет»', () => {
  withBoard((root) => {
    fs.writeFileSync(path.join(root, '.workflow', 'tickets', 'ready', 'IMPL-004.md'), ticket('IMPL-004', 'ready'), 'utf8');

    const r = run('--project', root, '--apply');

    assert.equal(r.status, 'clean');
    assert.equal(r.fixed, '0');
    assert.match(r.out, /Расхождений нет/);
  });
});
