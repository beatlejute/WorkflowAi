#!/usr/bin/env node

/**
 * Возврат заблокированного тикета после его исправления — поле `unblocks`
 * (src/scripts/check-conditions.js, unblockFixedTickets) — и закрытие заменённого
 * повторной проверкой — поле `supersedes` (closeSupersededTickets).
 *
 * PulseProxy PLAN-017 2026-09-28: повторная проверка QA-162 упала до исправления продукта и
 * встала в blocked/. decompose-gaps тикеты не двигает, поэтому завёл исправление FIX-032 и
 * новую проверку QA-163; обе прошли, а QA-162 остался в blocked/, и complete-plan отвечал
 * not_ready 69/70. Теперь тикет исправления называет заблокированные тикеты полем
 * `unblocks`, а check-conditions возвращает их в backlog/, когда исправление готово.
 *
 * Что охраняется:
 *  - готовый (done/) тикет с unblocks — тикет из blocked/ переезжает в backlog/ и в этом же
 *    запуске попадает в ready_tickets; unblocked_by получает id исправления, blocked_reason
 *    снят, updated_at обновлён, в результате unblocked_tickets;
 *  - исправление действует один раз: unblocks_applied на нём — тот же тикет не возвращается;
 *    цель не в blocked/ в момент готовности — отмечена, WARN один раз, позже заблокированную
 *    это исправление не возвращает;
 *  - два исправления одной цели: пока одно открыто — «ждёт исправлений», без отметок; оба
 *    готовы — возврат один раз, unblocked_by — оба, unblocks_applied — у обоих; открытое
 *    исправление в любой колонке вне done/ и archive/ (ready, in-progress, review, blocked)
 *    держит цель; незакрытый тикет с unblocks цель не возвращает;
 *  - исправление не готово — ничего не происходит; archive/ работает как done/;
 *  - unblocks не списком строк — WARN один раз, код 0, тикет на месте; файл с тем же id в
 *    backlog/ — без переноса и без отметки;
 *  - supersedes: готовая (done/, archive/) повторная проверка закрывает тикет blocked/ → done/
 *    (superseded_by, completed_at, без blocked_reason, supersedes_applied); не готова —
 *    ничего; цель не в blocked/ — отмечена, не тронута; не список строк — WARN один раз;
 *    файл с тем же id в done/ — без переноса и без отметки;
 *  - status перенесённого тикета — колонка назначения (backlog, done), не blocked;
 *  - цепочка supersedes (R2 заменяет заблокированную R1, R1 — T) закрывается за один запуск, в том
 *    числе глубиной 3 и без WARN; закрытая заменой проверка несёт rechecked_at заменившей, и
 *    исправление позже настоящей проверки возвращает T по unblocks, а раньше — не мешает
 *    закрыть T по rechecked_at;
 *  - исправление позже проверки уже возвращало T (по его unblocks_applied) — T возвращается в
 *    backlog/ сразу; дубль в backlog/ — WARN без отметок, возврат в следующем запуске; у
 *    закрытой заменой проверки без rechecked_at время не сверить — T возвращается по unblocks;
 *  - «ждёт исправлений» — один раз за запуск; заблокированное исправление держит цель, замена
 *    с supersedes на него возвращает цель за один запуск;
 *  - supersedes и unblocks на одной цели: пока исправление с unblocks открыто — цель ждёт,
 *    R не отмечен; исправление закрыто позже R или без completed_at — R не применяется
 *    (отмечен), цель возвращается в backlog/ по unblocks; все исправления закрыты раньше R —
 *    R закрывает цель;
 *  - unblocked_tickets и superseded_tickets есть в результате и пустыми.
 *
 * Временный корень проекта — в каталоге ОС, удаляется в finally.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/check-conditions-unblocks.test.mjs
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-conditions-unblocks-'));
  const tickets = path.join(root, '.workflow', 'tickets');
  for (const dir of ['backlog', 'ready', 'in-progress', 'review', 'done', 'archive', 'blocked']) {
    fs.mkdirSync(path.join(tickets, dir), { recursive: true });
  }
  try {
    return fn({ root, tickets });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function put(tickets, column, id, extra = {}) {
  const fm = {
    id,
    title: `Тикет ${id}`,
    type: 'test',
    created_at: OLD_TIME,
    updated_at: OLD_TIME,
    ...extra,
  };
  const file = path.join(tickets, column, `${id}.md`);
  fs.writeFileSync(file, `---\n${YAML.dump(fm)}---\n\n## Описание\n\nТело ${id}.\n`, 'utf8');
  return file;
}

function read(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  return { fm: YAML.load(match[1]), body: match[2] };
}

function run(root) {
  const r = spawnSync(process.execPath, [CHECK_CONDITIONS], { cwd: root, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function field(stdout, key) {
  const match = stdout.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

test('готовое исправление возвращает тикет из blocked/: backlog/, затем ready_tickets в этом же запуске', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'QA-100', { type: 'test' });
    put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: ['QA-162'] });
    put(tickets, 'blocked', 'QA-162', {
      status: 'blocked',
      dependencies: ['QA-100'],
      blocked_reason: 'проверка не прошла: бейдж пула не обновился',
    });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    const moved = path.join(tickets, 'backlog', 'QA-162.md');
    assert.ok(fs.existsSync(moved), `тикет должен переехать в backlog/:\n${res.stdout}`);
    assert.ok(!fs.existsSync(path.join(tickets, 'blocked', 'QA-162.md')), 'в blocked/ тикета больше нет');

    const { fm, body } = read(moved);
    assert.deepEqual(fm.unblocked_by, ['FIX-032']);
    assert.equal(fm.status, 'backlog', 'status — колонка назначения');
    assert.equal('blocked_reason' in fm, false, 'blocked_reason снимается');
    assert.notEqual(fm.updated_at, OLD_TIME, 'updated_at обновлён');
    assert.deepEqual(fm.dependencies, ['QA-100'], 'прочие поля сохраняются');
    assert.match(body, /Тело QA-162\./, 'тело тикета сохраняется');

    assert.match(res.stdout, /\[INFO\] QA-162: blocked\/ → backlog\/ \(исправление FIX-032 готово\)/);
    assert.equal(field(res.stdout, 'status'), 'has_ready');
    assert.equal(field(res.stdout, 'ready_tickets'), 'QA-162');
    assert.equal(field(res.stdout, 'unblocked_tickets'), 'QA-162');
  });
});

test('вернувшийся тикет с невыполненными зависимостями ждёт в backlog/', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: ['QA-162'] });
    put(tickets, 'blocked', 'QA-162', { dependencies: ['IMPL-900'] });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(tickets, 'backlog', 'QA-162.md')));
    assert.equal(field(res.stdout, 'ready_tickets'), '');
    assert.equal(field(res.stdout, 'unblocked_tickets'), 'QA-162');
  });
});

test('unblocks_applied с id цели — исправление тот же тикет повторно не возвращает', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: ['QA-162'], unblocks_applied: ['QA-162'] });
    const file = put(tickets, 'blocked', 'QA-162', {
      unblocked_by: ['FIX-032'],
      blocked_reason: 'упал снова после исправления',
    });
    const before = fs.readFileSync(file, 'utf8');

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'тикет остаётся в blocked/ байт в байт');
    assert.ok(!fs.existsSync(path.join(tickets, 'backlog', 'QA-162.md')));
    assert.equal(field(res.stdout, 'unblocked_tickets'), '');
    assert.doesNotMatch(res.stderr, /unblocks QA-162/);
  });
});

test('новое исправление возвращает тикет, уже возвращённый прежним: unblocked_by — все, кто его называет', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: ['QA-162'], unblocks_applied: ['QA-162'] });
    const fix40 = put(tickets, 'done', 'FIX-040', { type: 'fix', unblocks: ['QA-162'] });
    put(tickets, 'blocked', 'QA-162', { unblocked_by: ['FIX-032'] });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    const moved = path.join(tickets, 'backlog', 'QA-162.md');
    assert.ok(fs.existsSync(moved), res.stdout);
    assert.deepEqual(read(moved).fm.unblocked_by, ['FIX-032', 'FIX-040']);
    assert.deepEqual(read(fix40).fm.unblocks_applied, ['QA-162']);
    assert.match(res.stdout, /QA-162: blocked\/ → backlog\/ \(исправления FIX-032, FIX-040 готовы\)/);
  });
});

test('два исправления одной цели: ждёт второго, затем возврат один раз, отмечены оба', () => {
  withProject(({ root, tickets }) => {
    const fix32 = put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: ['QA-162'] });
    const fix33open = put(tickets, 'backlog', 'FIX-033', { type: 'fix', unblocks: ['QA-162'] });
    const blocked = put(tickets, 'blocked', 'QA-162', { blocked_reason: 'два дефекта' });
    const before = fs.readFileSync(blocked, 'utf8');
    const fix32Before = fs.readFileSync(fix32, 'utf8');

    // Первое исправление готово, второе открыто — тикет ждёт, отметок нет
    const res1 = run(root);
    assert.equal(res1.code, 0, res1.stderr);
    assert.equal(fs.readFileSync(blocked, 'utf8'), before, 'тикет в blocked/ не тронут');
    assert.match(res1.stdout, /\[INFO\] QA-162: ждёт исправлений FIX-033/);
    assert.equal(field(res1.stdout, 'unblocked_tickets'), '');
    assert.equal(fs.readFileSync(fix32, 'utf8'), fix32Before, 'ждущее исправление не отмечается');

    // Второе готово — возврат, unblocked_by и отметка у обоих
    fs.rmSync(fix33open);
    const fix33 = put(tickets, 'done', 'FIX-033', { type: 'fix', unblocks: ['QA-162'] });
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    const moved = path.join(tickets, 'backlog', 'QA-162.md');
    assert.ok(fs.existsSync(moved), res2.stdout);
    assert.deepEqual(read(moved).fm.unblocked_by, ['FIX-032', 'FIX-033']);
    assert.deepEqual(read(fix32).fm.unblocks_applied, ['QA-162']);
    assert.deepEqual(read(fix33).fm.unblocks_applied, ['QA-162']);
    assert.equal(field(res2.stdout, 'unblocked_tickets'), 'QA-162');
    assert.doesNotMatch(res2.stderr, /unblocks QA-162/, 'второе исправление не предупреждает');

    // Снова заблокирован после прогона с обоими исправлениями — остаётся в blocked/
    fs.renameSync(moved, path.join(tickets, 'blocked', 'QA-162.md'));
    const res3 = run(root);
    assert.equal(res3.code, 0, res3.stderr);
    assert.ok(fs.existsSync(path.join(tickets, 'blocked', 'QA-162.md')));
    assert.equal(field(res3.stdout, 'unblocked_tickets'), '');
    assert.doesNotMatch(res3.stderr, /unblocks QA-162/);
  });
});

test('исправление готово, пока цель не в blocked/: отмечено, позже заблокированную не возвращает', () => {
  withProject(({ root, tickets }) => {
    const fix = put(tickets, 'archive', 'FIX-1', { type: 'fix', unblocks: ['QA-9'] });
    const review = put(tickets, 'review', 'QA-9');

    const res1 = run(root);
    assert.equal(res1.code, 0, res1.stderr);
    assert.match(res1.stderr, /FIX-1: unblocks QA-9 — тикета нет в blocked\//);
    assert.deepEqual(read(fix).fm.unblocks_applied, ['QA-9']);

    // Позже QA-9 заблокирован по другой причине — старое исправление его не трогает
    fs.rmSync(review);
    const blocked = put(tickets, 'blocked', 'QA-9', { blocked_reason: 'no_capable_agent' });
    const before = fs.readFileSync(blocked, 'utf8');
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    assert.equal(fs.readFileSync(blocked, 'utf8'), before);
    assert.equal(field(res2.stdout, 'unblocked_tickets'), '');
    assert.doesNotMatch(res2.stderr, /unblocks QA-9/, 'WARN — один раз');
  });
});

test('два прогона подряд: второй тикет не трогает и не предупреждает', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: ['QA-162'] });
    put(tickets, 'blocked', 'QA-162', { dependencies: ['IMPL-900'] });

    run(root);
    const moved = path.join(tickets, 'backlog', 'QA-162.md');
    const after1 = fs.readFileSync(moved, 'utf8');
    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.readFileSync(moved, 'utf8'), after1);
    assert.equal(field(res.stdout, 'unblocked_tickets'), '');
    assert.doesNotMatch(res.stderr, /unblocks QA-162/, 'уже возвращённый этим исправлением тикет — без WARN');
  });
});

test('тикет не в blocked/ не трогается — WARN', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: ['QA-162', 'QA-404'] });
    const file = put(tickets, 'review', 'QA-162');
    const before = fs.readFileSync(file, 'utf8');

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'тикет в review/ не тронут');
    assert.ok(!fs.existsSync(path.join(tickets, 'backlog', 'QA-162.md')));
    assert.match(res.stderr, /FIX-032: unblocks QA-162 — тикета нет в blocked\//);
    assert.match(res.stderr, /FIX-032: unblocks QA-404 — тикета нет в blocked\//);
    assert.equal(field(res.stdout, 'unblocked_tickets'), '');
  });
});

test('исправление не готово — тикет остаётся в blocked/', () => {
  withProject(({ root, tickets }) => {
    for (const column of ['backlog', 'ready', 'in-progress', 'review', 'blocked']) {
      put(tickets, column, `FIX-${column}`, { type: 'fix', unblocks: ['QA-162'] });
    }
    const file = put(tickets, 'blocked', 'QA-162', { blocked_reason: 'ждёт исправления' });
    const before = fs.readFileSync(file, 'utf8');

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(tickets, 'backlog', 'QA-162.md')));
    assert.equal(field(res.stdout, 'unblocked_tickets'), '');
  });
});

test('исправление в archive/ возвращает тикет так же', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'archive', 'FIX-032', { type: 'fix', unblocks: ['QA-162'] });
    put(tickets, 'blocked', 'QA-162', { blocked_reason: 'ждёт исправления' });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    const moved = path.join(tickets, 'backlog', 'QA-162.md');
    assert.ok(fs.existsSync(moved), res.stdout);
    assert.deepEqual(read(moved).fm.unblocked_by, ['FIX-032']);
    assert.equal(field(res.stdout, 'unblocked_tickets'), 'QA-162');
    assert.equal(field(res.stdout, 'ready_tickets'), 'QA-162');
  });
});

test('unblocks не списком строк — WARN, код 0, тикет на месте', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: 'QA-162' });
    put(tickets, 'done', 'FIX-033', { type: 'fix', unblocks: [{ id: 'QA-162' }] });
    put(tickets, 'done', 'FIX-034', { type: 'fix', unblocks: [42] });
    const file = put(tickets, 'blocked', 'QA-162');
    const before = fs.readFileSync(file, 'utf8');

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    for (const id of ['FIX-032', 'FIX-033', 'FIX-034']) {
      assert.match(res.stderr, new RegExp(`\\[WARN\\] ${id}: поле unblocks не список id тикетов`));
    }
    assert.equal(field(res.stdout, 'status'), 'empty');
    assert.equal(field(res.stdout, 'unblocked_tickets'), '');

    // Предупреждение — один раз: исправление отмечено пустым unblocks_applied
    for (const id of ['FIX-032', 'FIX-033', 'FIX-034']) {
      assert.deepEqual(read(path.join(tickets, 'done', `${id}.md`)).fm.unblocks_applied, []);
    }
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    assert.doesNotMatch(res2.stderr, /поле unblocks не список/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('файл с тем же id уже в backlog/ — тикет из blocked/ не переносится', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: ['QA-162'] });
    const blocked = put(tickets, 'blocked', 'QA-162', { title: 'из blocked' });
    const backlog = put(tickets, 'backlog', 'QA-162', { title: 'из backlog' });
    const beforeBlocked = fs.readFileSync(blocked, 'utf8');
    const beforeBacklog = fs.readFileSync(backlog, 'utf8');

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.readFileSync(blocked, 'utf8'), beforeBlocked);
    assert.equal(fs.readFileSync(backlog, 'utf8'), beforeBacklog);
    assert.match(res.stderr, /QA-162: в backlog\/ уже есть файл с этим id/);
    assert.equal(field(res.stdout, 'unblocked_tickets'), '');
    assert.equal('unblocks_applied' in read(path.join(tickets, 'done', 'FIX-032.md')).fm, false,
      'перенос не удался — исправление не отмечено');
  });
});

test('без unblocks и supersedes на доске — поля unblocked_tickets и superseded_tickets есть и пустые', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'backlog', 'IMPL-1', { type: 'impl' });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^unblocked_tickets:[ \t]*$/m);
    assert.match(res.stdout, /^superseded_tickets:[ \t]*$/m);
    assert.equal(field(res.stdout, 'ready_tickets'), 'IMPL-1');
  });
});

test('supersedes: готовая повторная проверка закрывает заблокированный тикет в done/', () => {
  withProject(({ root, tickets }) => {
    const recheck = put(tickets, 'done', 'QA-163', { dependencies: ['FIX-032'], supersedes: ['QA-162'] });
    put(tickets, 'done', 'FIX-032', { type: 'fix' });
    put(tickets, 'blocked', 'QA-162', { status: 'blocked', blocked_reason: 'дефект продукта' });
    put(tickets, 'backlog', 'DOCS-1', { type: 'docs', dependencies: ['QA-162'] });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    const closed = path.join(tickets, 'done', 'QA-162.md');
    assert.ok(fs.existsSync(closed), res.stdout);
    assert.ok(!fs.existsSync(path.join(tickets, 'blocked', 'QA-162.md')));
    const { fm, body } = read(closed);
    assert.equal(fm.superseded_by, 'QA-163');
    assert.equal(fm.status, 'done', 'status — колонка назначения');
    assert.equal('blocked_reason' in fm, false);
    assert.notEqual(fm.updated_at, OLD_TIME);
    assert.ok(!Number.isNaN(Date.parse(fm.completed_at)), `completed_at: ${fm.completed_at}`);
    assert.match(body, /Тело QA-162\./);
    assert.deepEqual(read(recheck).fm.supersedes_applied, ['QA-162']);

    assert.match(res.stdout, /\[INFO\] QA-162: blocked\/ → done\/ \(заменён QA-163\)/);
    assert.equal(field(res.stdout, 'superseded_tickets'), 'QA-162');
    assert.equal(field(res.stdout, 'unblocked_tickets'), '');
    assert.equal(field(res.stdout, 'ready_tickets'), 'DOCS-1', 'зависящий от закрытого тикет готов в этом же запуске');
  });
});

test('supersedes: повторная проверка в archive/ закрывает так же', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'archive', 'QA-163', { supersedes: ['QA-162'] });
    put(tickets, 'blocked', 'QA-162');

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(read(path.join(tickets, 'done', 'QA-162.md')).fm.superseded_by, 'QA-163');
    assert.equal(field(res.stdout, 'superseded_tickets'), 'QA-162');
  });
});

test('supersedes: повторная проверка не готова — ничего не происходит', () => {
  withProject(({ root, tickets }) => {
    for (const column of ['backlog', 'ready', 'in-progress', 'review', 'blocked']) {
      put(tickets, column, `QA-${column}`, { supersedes: ['QA-162'] });
    }
    const file = put(tickets, 'blocked', 'QA-162', { blocked_reason: 'дефект продукта' });
    const before = fs.readFileSync(file, 'utf8');

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(tickets, 'done', 'QA-162.md')));
    assert.equal(field(res.stdout, 'superseded_tickets'), '');
  });
});

test('supersedes: цель не в blocked/ — отмечено, не тронута, позже заблокированную не закрывает', () => {
  withProject(({ root, tickets }) => {
    const recheck = put(tickets, 'done', 'QA-163', { supersedes: ['QA-162'] });
    const review = put(tickets, 'review', 'QA-162');
    const reviewBefore = fs.readFileSync(review, 'utf8');

    const res1 = run(root);
    assert.equal(res1.code, 0, res1.stderr);
    assert.equal(fs.readFileSync(review, 'utf8'), reviewBefore);
    assert.match(res1.stderr, /QA-163: supersedes QA-162 — тикета нет в blocked\//);
    assert.deepEqual(read(recheck).fm.supersedes_applied, ['QA-162']);
    assert.equal(field(res1.stdout, 'superseded_tickets'), '');

    fs.rmSync(review);
    const blocked = put(tickets, 'blocked', 'QA-162', { blocked_reason: 'другая причина' });
    const before = fs.readFileSync(blocked, 'utf8');
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    assert.equal(fs.readFileSync(blocked, 'utf8'), before);
    assert.equal(field(res2.stdout, 'superseded_tickets'), '');
    assert.doesNotMatch(res2.stderr, /supersedes QA-162/, 'WARN — один раз');
  });
});

test('supersedes не списком строк — WARN один раз, тикет на месте', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'QA-163', { supersedes: 'QA-162' });
    put(tickets, 'done', 'QA-164', { supersedes: [7] });
    const file = put(tickets, 'blocked', 'QA-162');
    const before = fs.readFileSync(file, 'utf8');

    const res1 = run(root);
    assert.equal(res1.code, 0, res1.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    for (const id of ['QA-163', 'QA-164']) {
      assert.match(res1.stderr, new RegExp(`\\[WARN\\] ${id}: поле supersedes не список id тикетов`));
      assert.deepEqual(read(path.join(tickets, 'done', `${id}.md`)).fm.supersedes_applied, []);
    }
    assert.equal(field(res1.stdout, 'superseded_tickets'), '');

    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    assert.doesNotMatch(res2.stderr, /поле supersedes не список/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('supersedes: файл с тем же id уже в done/ — WARN, без переноса и без отметки', () => {
  withProject(({ root, tickets }) => {
    const recheck = put(tickets, 'done', 'QA-163', { supersedes: ['QA-162'] });
    const blocked = put(tickets, 'blocked', 'QA-162', { title: 'из blocked' });
    const done = put(tickets, 'done', 'QA-162', { title: 'из done' });
    const beforeBlocked = fs.readFileSync(blocked, 'utf8');
    const beforeDone = fs.readFileSync(done, 'utf8');

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.readFileSync(blocked, 'utf8'), beforeBlocked);
    assert.equal(fs.readFileSync(done, 'utf8'), beforeDone);
    assert.match(res.stderr, /QA-162: в done\/ уже есть файл с этим id/);
    assert.equal('supersedes_applied' in read(recheck).fm, false);
    assert.equal(field(res.stdout, 'superseded_tickets'), '');
  });
});

test('открытое исправление в любой колонке вне done/ и archive/ держит цель в blocked/', () => {
  for (const column of ['ready', 'in-progress', 'review', 'blocked']) {
    withProject(({ root, tickets }) => {
      const fixA = put(tickets, 'done', 'FIX-A', { type: 'fix', unblocks: ['QA-162'] });
      put(tickets, column, 'FIX-B', { type: 'fix', unblocks: ['QA-162'] });
      const blocked = put(tickets, 'blocked', 'QA-162', { blocked_reason: 'два дефекта' });
      const before = fs.readFileSync(blocked, 'utf8');
      const fixABefore = fs.readFileSync(fixA, 'utf8');

      const res = run(root);

      assert.equal(res.code, 0, `${column}: ${res.stderr}`);
      assert.equal(fs.readFileSync(blocked, 'utf8'), before, `${column}: тикет в blocked/ не тронут`);
      assert.ok(!fs.existsSync(path.join(tickets, 'backlog', 'QA-162.md')), `${column}: в backlog/ не переехал`);
      assert.match(res.stdout, /\[INFO\] QA-162: ждёт исправлений FIX-B/, column);
      assert.equal(field(res.stdout, 'unblocked_tickets'), '', column);
      assert.equal(fs.readFileSync(fixA, 'utf8'), fixABefore, `${column}: готовое исправление не отмечено`);
    });
  }
});

test('незакрытый тикет с unblocks цель не возвращает и не отмечается', () => {
  withProject(({ root, tickets }) => {
    const fixOpen = put(tickets, 'backlog', 'FIX-B', { type: 'fix', unblocks: ['QA-9'] });
    const review = put(tickets, 'review', 'QA-9');
    const fixBefore = fs.readFileSync(fixOpen, 'utf8');

    const res1 = run(root);
    assert.equal(res1.code, 0, res1.stderr);
    assert.equal(fs.readFileSync(fixOpen, 'utf8'), fixBefore, 'открытое исправление не отмечается');
    assert.doesNotMatch(res1.stderr, /FIX-B: unblocks QA-9/, 'открытое исправление не предупреждает');

    // Исправление готово, цель к этому моменту в blocked/ — возврат
    fs.rmSync(fixOpen);
    fs.renameSync(review, path.join(tickets, 'blocked', 'QA-9.md'));
    put(tickets, 'done', 'FIX-B', { type: 'fix', unblocks: ['QA-9'] });
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    assert.ok(fs.existsSync(path.join(tickets, 'backlog', 'QA-9.md')), res2.stdout);
    assert.equal(field(res2.stdout, 'unblocked_tickets'), 'QA-9');
  });
});

test('supersedes и unblocks на одной цели: проверка до исправления цель не закрывает, цель возвращается по unblocks', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-031', { type: 'fix', completed_at: '2026-09-28T09:00:00.000Z' });
    const recheck = put(tickets, 'done', 'QA-164', {
      dependencies: ['FIX-031'], supersedes: ['QA-162'], completed_at: '2026-09-28T11:00:00.000Z',
    });
    const fixOpen = put(tickets, 'backlog', 'FIX-033', { type: 'fix', unblocks: ['QA-162'] });
    const blocked = put(tickets, 'blocked', 'QA-162', { blocked_reason: 'два дефекта' });
    const before = fs.readFileSync(blocked, 'utf8');
    const recheckBefore = fs.readFileSync(recheck, 'utf8');

    // Исправление второго дефекта открыто — цель ждёт, повторная проверка не отмечена
    const res1 = run(root);
    assert.equal(res1.code, 0, res1.stderr);
    assert.equal(fs.readFileSync(blocked, 'utf8'), before, 'тикет в blocked/ не тронут');
    assert.ok(!fs.existsSync(path.join(tickets, 'done', 'QA-162.md')), 'в done/ не закрыт');
    assert.match(res1.stdout, /\[INFO\] QA-162: ждёт исправлений FIX-033 — supersedes не применяется/);
    assert.equal(field(res1.stdout, 'superseded_tickets'), '');
    assert.equal(fs.readFileSync(recheck, 'utf8'), recheckBefore, 'повторная проверка не отмечена');

    // Исправление закрыто позже проверки — проверка не применяется, цель в backlog/
    fs.rmSync(fixOpen);
    const fix33 = put(tickets, 'done', 'FIX-033', {
      type: 'fix', unblocks: ['QA-162'], completed_at: '2026-09-28T12:00:00.000Z',
    });
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    assert.ok(!fs.existsSync(path.join(tickets, 'done', 'QA-162.md')), `в done/ не закрыт:\n${res2.stdout}`);
    const moved = path.join(tickets, 'backlog', 'QA-162.md');
    assert.ok(fs.existsSync(moved), res2.stdout);
    assert.deepEqual(read(moved).fm.unblocked_by, ['FIX-033']);
    assert.equal('superseded_by' in read(moved).fm, false);
    assert.deepEqual(read(recheck).fm.supersedes_applied, ['QA-162']);
    assert.deepEqual(read(fix33).fm.unblocks_applied, ['QA-162']);
    assert.match(res2.stdout, /\[INFO\] QA-164: supersedes QA-162 не применяется — исправление FIX-033 закрыто позже проверки/);
    assert.equal(field(res2.stdout, 'superseded_tickets'), '');
    assert.equal(field(res2.stdout, 'unblocked_tickets'), 'QA-162');

    // Цель снова в blocked/ после прогона — старая проверка её не закрывает
    fs.renameSync(moved, path.join(tickets, 'blocked', 'QA-162.md'));
    const res3 = run(root);
    assert.equal(res3.code, 0, res3.stderr);
    assert.ok(fs.existsSync(path.join(tickets, 'blocked', 'QA-162.md')));
    assert.equal(field(res3.stdout, 'superseded_tickets'), '');
    assert.equal(field(res3.stdout, 'unblocked_tickets'), '');
  });
});

test('supersedes и unblocks на одной цели: все исправления закрыты раньше проверки — проверка закрывает цель', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-033', {
      type: 'fix', unblocks: ['QA-162'], completed_at: '2026-09-28T09:00:00.000Z',
    });
    const recheck = put(tickets, 'done', 'QA-164', {
      dependencies: ['FIX-033'], supersedes: ['QA-162'], completed_at: '2026-09-28T11:00:00.000Z',
    });
    put(tickets, 'blocked', 'QA-162');

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    const closed = path.join(tickets, 'done', 'QA-162.md');
    assert.ok(fs.existsSync(closed), res.stdout);
    assert.equal(read(closed).fm.superseded_by, 'QA-164');
    assert.deepEqual(read(recheck).fm.supersedes_applied, ['QA-162']);
    assert.equal(field(res.stdout, 'superseded_tickets'), 'QA-162');
    assert.equal(field(res.stdout, 'unblocked_tickets'), '');
  });
});

test('supersedes и unblocks на одной цели: время не сверить — проверка не применяется', () => {
  for (const [label, fixTime, recheckTime] of [
    ['у исправления нет completed_at', undefined, '2026-09-28T11:00:00.000Z'],
    ['у проверки нет completed_at', '2026-09-28T09:00:00.000Z', undefined],
  ]) {
    withProject(({ root, tickets }) => {
      put(tickets, 'done', 'FIX-033', {
        type: 'fix', unblocks: ['QA-162'], ...(fixTime ? { completed_at: fixTime } : {}),
      });
      const recheck = put(tickets, 'done', 'QA-164', {
        supersedes: ['QA-162'], ...(recheckTime ? { completed_at: recheckTime } : {}),
      });
      put(tickets, 'blocked', 'QA-162');

      const res = run(root);

      assert.equal(res.code, 0, `${label}: ${res.stderr}`);
      assert.ok(!fs.existsSync(path.join(tickets, 'done', 'QA-162.md')), label);
      assert.ok(fs.existsSync(path.join(tickets, 'backlog', 'QA-162.md')), `${label}: цель вернулась по unblocks`);
      assert.deepEqual(read(recheck).fm.supersedes_applied, ['QA-162'], label);
      assert.equal(field(res.stdout, 'superseded_tickets'), '', label);
    });
  }
});

test('цепочка supersedes закрывается за один запуск: R2 закрывает R1, R1 — исходный тикет', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'blocked', 'QA-10', { status: 'blocked', blocked_reason: 'дефект D1' });
    put(tickets, 'blocked', 'QA-11', { status: 'blocked', supersedes: ['QA-10'], blocked_reason: 'дефект D2' });
    put(tickets, 'done', 'QA-12', { status: 'done', supersedes: ['QA-11'], completed_at: '2026-09-28T12:00:00.000Z' });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    const qa11 = path.join(tickets, 'done', 'QA-11.md');
    const qa10 = path.join(tickets, 'done', 'QA-10.md');
    assert.ok(fs.existsSync(qa11), res.stdout);
    assert.ok(fs.existsSync(qa10), `исходный тикет закрыт в этом же запуске:\n${res.stdout}`);
    assert.equal(fs.readdirSync(path.join(tickets, 'blocked')).length, 0, 'в blocked/ пусто');
    assert.equal(read(qa11).fm.superseded_by, 'QA-12');
    assert.equal(read(qa10).fm.superseded_by, 'QA-11');
    assert.equal(read(qa10).fm.status, 'done');
    assert.deepEqual(read(qa11).fm.supersedes_applied, ['QA-10']);
    assert.equal(field(res.stdout, 'superseded_tickets'), 'QA-11, QA-10');

    // Второй запуск ничего не меняет
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    assert.equal(field(res2.stdout, 'superseded_tickets'), '');
  });
});
test('цепочка supersedes глубиной 3 закрывается за один запуск без предупреждений', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'blocked', 'QA-10', { status: 'blocked' });
    put(tickets, 'blocked', 'QA-11', { status: 'blocked', supersedes: ['QA-10'] });
    put(tickets, 'blocked', 'QA-12', { status: 'blocked', supersedes: ['QA-11'] });
    put(tickets, 'done', 'QA-13', { status: 'done', supersedes: ['QA-12'], completed_at: '2026-09-28T12:00:00.000Z' });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.readdirSync(path.join(tickets, 'blocked')).length, 0, `в blocked/ пусто:\n${res.stdout}`);
    assert.equal(field(res.stdout, 'superseded_tickets'), 'QA-12, QA-11, QA-10');
    assert.doesNotMatch(res.stderr, /\[WARN\]/, 'закрытие цепочки не предупреждает');
    for (const id of ['QA-12', 'QA-11', 'QA-10']) {
      assert.equal(read(path.join(tickets, 'done', `${id}.md`)).fm.rechecked_at, '2026-09-28T12:00:00.000Z',
        `${id}: время проверки — время QA-13, не время закрытия`);
    }
  });
});

test('цепочка supersedes: исправление закрыто позже настоящей проверки — исходный тикет возвращается по unblocks', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'done', 'FIX-031', { type: 'fix', completed_at: '2026-09-28T09:00:00.000Z' });
    put(tickets, 'blocked', 'QA-10', { status: 'blocked' });
    put(tickets, 'blocked', 'QA-11', { status: 'blocked', supersedes: ['QA-10'] });
    put(tickets, 'done', 'FIX-033', { type: 'fix', unblocks: ['QA-10'], completed_at: '2026-09-28T13:00:00.000Z' });
    put(tickets, 'done', 'QA-12', { supersedes: ['QA-11'], completed_at: '2026-09-28T12:00:00.000Z' });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(tickets, 'done', 'QA-11.md')), res.stdout);
    assert.ok(!fs.existsSync(path.join(tickets, 'done', 'QA-10.md')), `QA-10 не закрыт проверкой до FIX-033:\n${res.stdout}`);
    const back = path.join(tickets, 'backlog', 'QA-10.md');
    assert.ok(fs.existsSync(back), res.stdout);
    assert.deepEqual(read(back).fm.unblocked_by, ['FIX-033']);
    assert.equal(field(res.stdout, 'superseded_tickets'), 'QA-11');
    assert.equal(field(res.stdout, 'unblocked_tickets'), 'QA-10');
  });
});

test('supersedes: исправление позже проверки уже возвращало тикет — тикет возвращается в backlog/ сразу', () => {
  for (const [label, fixTime] of [
    ['у исправления пустой completed_at', ''],
    ['исправление закрыто позже проверки', '2026-09-28T16:00:00.000Z'],
  ]) {
    withProject(({ root, tickets }) => {
      put(tickets, 'done', 'FIX-032', {
        type: 'fix', unblocks: ['QA-162'], unblocks_applied: ['QA-162'], completed_at: fixTime,
      });
      const recheck = put(tickets, 'done', 'QA-170', { supersedes: ['QA-162'], completed_at: '2026-09-28T15:00:00.000Z' });
      put(tickets, 'blocked', 'QA-162', { status: 'blocked', unblocked_by: ['FIX-032'] });

      const res = run(root);

      assert.equal(res.code, 0, `${label}: ${res.stderr}`);
      const back = path.join(tickets, 'backlog', 'QA-162.md');
      assert.ok(fs.existsSync(back), `${label}: тикет вернулся в backlog/:\n${res.stdout}`);
      assert.equal(read(back).fm.status, 'backlog', label);
      assert.deepEqual(read(back).fm.unblocked_by, ['FIX-032'], label);
      assert.deepEqual(read(recheck).fm.supersedes_applied, ['QA-162'], label);
      assert.equal(field(res.stdout, 'unblocked_tickets'), 'QA-162', label);
      assert.equal(field(res.stdout, 'superseded_tickets'), '', label);

      // Второй запуск ничего не меняет
      const res2 = run(root);
      assert.equal(field(res2.stdout, 'unblocked_tickets'), '', label);
    });
  }
});

test('«ждёт исправлений» для supersedes печатается один раз, даже когда проходов несколько', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'blocked', 'QA-20', { status: 'blocked' });
    put(tickets, 'done', 'QA-21', { supersedes: ['QA-20'], completed_at: '2026-09-28T12:00:00.000Z' });
    put(tickets, 'blocked', 'QA-30', { status: 'blocked' });
    put(tickets, 'backlog', 'FIX-9', { type: 'fix', unblocks: ['QA-30'] });
    put(tickets, 'done', 'QA-31', { supersedes: ['QA-30'], completed_at: '2026-09-28T12:00:00.000Z' });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(field(res.stdout, 'superseded_tickets'), 'QA-20');
    const waits = res.stdout.match(/QA-30: ждёт исправлений FIX-9 — supersedes не применяется/g) || [];
    assert.equal(waits.length, 1, res.stdout);
  });
});

test('заблокированное исправление держит цель; замена с supersedes на него возвращает цель за один запуск', () => {
  withProject(({ root, tickets }) => {
    put(tickets, 'blocked', 'FIX-A', { type: 'fix', status: 'blocked', unblocks: ['QA-1'] });
    put(tickets, 'blocked', 'QA-1', { status: 'blocked' });
    const fixA2 = put(tickets, 'done', 'FIX-A2', { type: 'fix', completed_at: '2026-09-28T12:00:00.000Z', unblocks: ['QA-1'] });

    // Без supersedes заблокированное исправление держит цель
    const res1 = run(root);
    assert.equal(res1.code, 0, res1.stderr);
    assert.ok(fs.existsSync(path.join(tickets, 'blocked', 'QA-1.md')), res1.stdout);
    assert.match(res1.stdout, /\[INFO\] QA-1: ждёт исправлений FIX-A/);

    // Замена несёт supersedes на заблокированное исправление — оба решаются за один запуск
    fs.rmSync(fixA2);
    put(tickets, 'done', 'FIX-A2', {
      type: 'fix', completed_at: '2026-09-28T12:00:00.000Z', unblocks: ['QA-1'], supersedes: ['FIX-A'],
    });
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    assert.equal(read(path.join(tickets, 'done', 'FIX-A.md')).fm.superseded_by, 'FIX-A2');
    const back = path.join(tickets, 'backlog', 'QA-1.md');
    assert.ok(fs.existsSync(back), res2.stdout);
    assert.deepEqual(read(back).fm.unblocked_by, ['FIX-A', 'FIX-A2']);
    assert.equal(field(res2.stdout, 'superseded_tickets'), 'FIX-A');
    assert.equal(field(res2.stdout, 'unblocked_tickets'), 'QA-1');
  });
});
test('цепочка supersedes: у последней проверки нет времени — исходный тикет возвращается по unblocks, а не закрывается', () => {
  for (const [label, extra] of [['пустой completed_at', { completed_at: '' }], ['без completed_at', {}]]) {
    withProject(({ root, tickets }) => {
      put(tickets, 'blocked', 'QA-10', { status: 'blocked' });
      put(tickets, 'blocked', 'QA-11', { status: 'blocked', supersedes: ['QA-10'] });
      put(tickets, 'done', 'FIX-33', { type: 'fix', unblocks: ['QA-10'], completed_at: '2026-09-28T13:00:00.000Z' });
      put(tickets, 'done', 'QA-12', { supersedes: ['QA-11'], ...extra });

      const res = run(root);

      assert.equal(res.code, 0, `${label}: ${res.stderr}`);
      assert.ok(fs.existsSync(path.join(tickets, 'done', 'QA-11.md')), label);
      assert.ok(!fs.existsSync(path.join(tickets, 'done', 'QA-10.md')), `${label}: QA-10 не закрыт по времени закрытия QA-11:\n${res.stdout}`);
      const back = path.join(tickets, 'backlog', 'QA-10.md');
      assert.ok(fs.existsSync(back), `${label}:\n${res.stdout}`);
      assert.deepEqual(read(back).fm.unblocked_by, ['FIX-33'], label);
      assert.equal(field(res.stdout, 'superseded_tickets'), 'QA-11', label);
      assert.equal(field(res.stdout, 'unblocked_tickets'), 'QA-10', label);
    });
  }
});

test('supersedes: возврат в backlog/ по уже применённому исправлению решается по его unblocks_applied, а не по unblocked_by цели', () => {
  withProject(({ root, tickets }) => {
    // Исправление отмечено, пока цель была не в blocked/, — unblocked_by у цели нет
    put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: ['QA-162'], unblocks_applied: ['QA-162'], completed_at: '' });
    const recheck = put(tickets, 'done', 'QA-170', { supersedes: ['QA-162'], completed_at: '2026-09-28T15:00:00.000Z' });
    put(tickets, 'blocked', 'QA-162', { status: 'blocked' });

    const res = run(root);

    assert.equal(res.code, 0, res.stderr);
    const back = path.join(tickets, 'backlog', 'QA-162.md');
    assert.ok(fs.existsSync(back), res.stdout);
    assert.deepEqual(read(back).fm.unblocked_by, ['FIX-032']);
    assert.deepEqual(read(recheck).fm.supersedes_applied, ['QA-162']);
    assert.equal(field(res.stdout, 'unblocked_tickets'), 'QA-162');
  });
});

test('supersedes: прямой возврат при файле с тем же id в backlog/ — WARN, без отметки, возврат в следующем запуске', () => {
  withProject(({ root, tickets }) => {
    const fix = put(tickets, 'done', 'FIX-032', { type: 'fix', unblocks: ['QA-162'], unblocks_applied: ['QA-162'], completed_at: '' });
    const recheck = put(tickets, 'done', 'QA-170', { supersedes: ['QA-162'], completed_at: '2026-09-28T15:00:00.000Z' });
    const blocked = put(tickets, 'blocked', 'QA-162', { status: 'blocked', title: 'из blocked' });
    const dup = put(tickets, 'backlog', 'QA-162', { title: 'дубль в backlog' });
    const recheckBefore = fs.readFileSync(recheck, 'utf8');
    const fixBefore = fs.readFileSync(fix, 'utf8');
    const blockedBefore = fs.readFileSync(blocked, 'utf8');

    const res1 = run(root);
    assert.equal(res1.code, 0, res1.stderr);
    assert.match(res1.stderr, /\[WARN\] QA-162: в backlog\/ уже есть файл с этим id/);
    assert.equal(fs.readFileSync(blocked, 'utf8'), blockedBefore, 'тикет в blocked/ не тронут');
    assert.equal(fs.readFileSync(recheck, 'utf8'), recheckBefore, 'проверка не отмечена');
    assert.equal(fs.readFileSync(fix, 'utf8'), fixBefore, 'исправление не тронуто');
    assert.equal(field(res1.stdout, 'unblocked_tickets'), '');

    fs.rmSync(dup);
    const res2 = run(root);
    assert.equal(res2.code, 0, res2.stderr);
    assert.ok(fs.existsSync(path.join(tickets, 'backlog', 'QA-162.md')), res2.stdout);
    assert.equal(field(res2.stdout, 'unblocked_tickets'), 'QA-162');
  });
});
test('цепочка supersedes: исправление закрыто раньше настоящей проверки — исходный тикет закрывается по rechecked_at', () => {
  for (const [label, applied] of [['исправление ещё не применено', {}], ['исправление уже возвращало тикет', { unblocks_applied: ['QA-10'] }]]) {
    withProject(({ root, tickets }) => {
      put(tickets, 'blocked', 'QA-10', { status: 'blocked' });
      put(tickets, 'blocked', 'QA-11', { status: 'blocked', supersedes: ['QA-10'] });
      put(tickets, 'done', 'FIX-33', { type: 'fix', unblocks: ['QA-10'], completed_at: '2026-09-28T09:00:00.000Z', ...applied });
      put(tickets, 'done', 'QA-12', { supersedes: ['QA-11'], completed_at: '2026-09-28T12:00:00.000Z' });

      const res = run(root);

      assert.equal(res.code, 0, `${label}: ${res.stderr}`);
      const closed = path.join(tickets, 'done', 'QA-10.md');
      assert.ok(fs.existsSync(closed), `${label}:\n${res.stdout}`);
      assert.ok(!fs.existsSync(path.join(tickets, 'backlog', 'QA-10.md')), label);
      assert.equal(read(closed).fm.superseded_by, 'QA-11', label);
      assert.equal(read(closed).fm.rechecked_at, '2026-09-28T12:00:00.000Z', label);
      assert.equal(field(res.stdout, 'superseded_tickets'), 'QA-11, QA-10', label);
      assert.equal(field(res.stdout, 'unblocked_tickets'), '', label);
    });
  }
});
