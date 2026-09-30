/**
 * check-conditions.js: незакрытая повторная проверка с `supersedes` держит свою цель в
 * blocked/ (PulseProxy QA-180, 2026-09-30). Тикет тестирования держала его собственная
 * запись проверки; исправление дефекта продукта завели с `unblocks`, и пайплайн вернул
 * тикет с той же записью — он снова ушёл в blocked/. Замена с переписанной записью ещё
 * не готова, поэтому ни готовое исправление по `unblocks`, ни другая готовая проверка не
 * возвращают цель в backlog/ — её закроет эта замена.
 *
 * Что охраняется:
 *  - готовое исправление с `unblocks` не возвращает цель, пока замена открыта, и не
 *    отмечается; готовая замена закрывает цель в done/;
 *  - замена держит цель из любой незакрытой колонки, в том числе сама из blocked/;
 *  - готовая проверка, закрытая раньше повторно применённого исправления, не возвращает
 *    цель в backlog/, если её заменит другая незакрытая замена.
 *
 * Проект — во временном каталоге ОС, удаляется в finally каждого случая.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/check-conditions-replacement.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'js-yaml';

const CHECK_CONDITIONS = fileURLToPath(new URL('../scripts/check-conditions.js', import.meta.url));
const OLD_TIME = '2026-09-28T10:00:00.000Z';
function withProject(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-conditions-replacement-'));
  const tickets = path.join(root, '.workflow', 'tickets');
  for (const dir of ['backlog', 'ready', 'in-progress', 'review', 'done', 'archive', 'blocked']) fs.mkdirSync(path.join(tickets, dir), { recursive: true });
  try { return fn({ root, tickets }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function put(tickets, column, id, extra = {}) {
  const fm = { id, title: `Тикет ${id}`, type: 'test', created_at: OLD_TIME, updated_at: OLD_TIME, ...extra };
  const file = path.join(tickets, column, `${id}.md`);
  fs.writeFileSync(file, `---\n${YAML.dump(fm)}---\n\n## Описание\n\nТело ${id}.\n`, 'utf8');
  return file;
}
function read(file) { const m = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/); return { fm: YAML.load(m[1]) }; }
function run(root) { const r = spawnSync(process.execPath, [CHECK_CONDITIONS], { cwd: root, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }; }
function field(stdout, key) { const m = stdout.match(new RegExp(`^${key}:[ \t]*(.*)$`, 'm')); return m ? m[1].trim() : null; }

test('незавершённая замена с supersedes держит цель в blocked/: готовое исправление с unblocks её не возвращает, готовая замена закрывает', () => {
  withProject(({ root, tickets }) => {
    const fix = put(tickets, 'done', 'FIX-033', { type: 'fix', unblocks: ['QA-180'], completed_at: '2026-09-30T10:00:00.000Z' });
    const replacement = put(tickets, 'backlog', 'QA-181', { dependencies: ['FIX-033'], supersedes: ['QA-180'] });
    put(tickets, 'blocked', 'QA-180', { status: 'blocked' });
    const fixBefore = fs.readFileSync(fix, 'utf8');

    const res1 = run(root);
    assert.equal(res1.code, 0, res1.stderr);
    assert.ok(fs.existsSync(path.join(tickets, 'blocked', 'QA-180.md')), `цель ждёт замену:\n${res1.stdout}`);
    assert.match(res1.stdout, /\[INFO\] QA-180: ждёт замены QA-181 — по unblocks не возвращается/);
    assert.equal(field(res1.stdout, 'unblocked_tickets'), '');
    assert.equal(field(res1.stdout, 'ready_tickets'), 'QA-181');
    assert.equal(fs.readFileSync(fix, 'utf8'), fixBefore, 'исправление не отмечено');

    fs.rmSync(replacement);
    put(tickets, 'done', 'QA-181', { dependencies: ['FIX-033'], supersedes: ['QA-180'], completed_at: '2026-09-30T11:00:00.000Z' });
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    const closed = path.join(tickets, 'done', 'QA-180.md');
    assert.ok(fs.existsSync(closed), res2.stdout);
    assert.equal(read(closed).fm.superseded_by, 'QA-181');
    assert.equal(field(res2.stdout, 'superseded_tickets'), 'QA-180');
    assert.equal(field(res2.stdout, 'unblocked_tickets'), '');
    assert.deepEqual(read(fix).fm.unblocks_applied, ['QA-180'], 'исправление отмечено при закрытии заменой');

    const res3 = run(root);
    assert.equal(res3.code, 0, res3.stderr);
    assert.doesNotMatch(res3.stderr, /тикета нет в blocked/, 'после закрытия заменой исправление не шумит');
  });
});

test('замена в любой незакрытой колонке держит цель, в том числе сама в blocked/', () => {
  for (const column of ['backlog', 'ready', 'in-progress', 'review', 'blocked']) {
    withProject(({ root, tickets }) => {
      put(tickets, 'done', 'FIX-033', { type: 'fix', unblocks: ['QA-180'], completed_at: '2026-09-30T10:00:00.000Z' });
      put(tickets, column, 'QA-181', { supersedes: ['QA-180'] });
      put(tickets, 'blocked', 'QA-180', { status: 'blocked' });
      const res = run(root);
      assert.equal(res.code, 0, `${column}: ${res.stderr}`);
      assert.ok(fs.existsSync(path.join(tickets, 'blocked', 'QA-180.md')), `${column}:\n${res.stdout}`);
      assert.equal(field(res.stdout, 'unblocked_tickets'), '', column);
    });
  }
});

test('готовая проверка раньше ещё не применённого исправления не обещает возврат по unblocks, пока цель ждёт замены', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-033', { type: 'fix', unblocks: ['QA-180'], completed_at: '2026-09-30T10:00:00.000Z' });
    put(tickets, 'done', 'QA-181', { supersedes: ['QA-180'], completed_at: '2026-09-30T09:00:00.000Z' });
    put(tickets, 'backlog', 'QA-182', { supersedes: ['QA-180'], dependencies: ['FIX-033'] });
    put(tickets, 'blocked', 'QA-180', { status: 'blocked' });

    const res = run(root);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(tickets, 'blocked', 'QA-180.md')), res.stdout);
    assert.match(res.stdout, /QA-180: supersedes QA-181 не применяется — тикет заменит незакрытая QA-182/);
    assert.doesNotMatch(res.stdout, /QA-180 вернётся по unblocks/);
  });
});

test('готовая проверка раньше повторно применённого исправления не возвращает цель, если её заменит незакрытая замена', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-033', {
      type: 'fix', unblocks: ['QA-180'], unblocks_applied: ['QA-180'], completed_at: '2026-09-30T10:00:00.000Z'
    });
    const early = put(tickets, 'done', 'QA-181', { supersedes: ['QA-180'], completed_at: '2026-09-30T09:00:00.000Z' });
    const open = put(tickets, 'backlog', 'QA-182', { supersedes: ['QA-180'], dependencies: ['FIX-033'] });
    put(tickets, 'blocked', 'QA-180', { status: 'blocked' });

    const res1 = run(root);
    assert.equal(res1.code, 0, res1.stderr);
    assert.ok(fs.existsSync(path.join(tickets, 'blocked', 'QA-180.md')), `цель ждёт замену:\n${res1.stdout}`);
    assert.match(res1.stdout, /QA-180: supersedes QA-181 не применяется — тикет заменит незакрытая QA-182/);
    assert.deepEqual(read(early).fm.supersedes_applied, ['QA-180'], 'ранняя проверка отмечена');
    assert.equal(field(res1.stdout, 'unblocked_tickets'), '');

    fs.rmSync(open);
    put(tickets, 'done', 'QA-182', { supersedes: ['QA-180'], dependencies: ['FIX-033'], completed_at: '2026-09-30T12:00:00.000Z' });
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    const closed = path.join(tickets, 'done', 'QA-180.md');
    assert.ok(fs.existsSync(closed), res2.stdout);
    assert.equal(read(closed).fm.superseded_by, 'QA-182');
  });
});
