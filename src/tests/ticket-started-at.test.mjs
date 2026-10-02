/**
 * Машинная метка начала работы `started_at` при входе тикета в in-progress/.
 *
 * Инцидент PulseProxy PLAN-020 (2026-09-29/30): created_at всех 36 тикетов
 * вписала модель декомпозиции — полночь «2026-09-30T00:00:00Z» из будущего.
 * Гейт file_unchanged брал эту метку точкой отсчёта и откатывался на updated_at,
 * который переписывается на каждом повторе: правку прошлой попытки гейт считал
 * «неизменённой» — 7 ложных отказов. started_at ставит код, и точкой отсчёта
 * становится она.
 *
 * Проверяются все пути в in-progress/: общий хелпер stampStartedAt, moveTicket
 * из operations (MCP move_ticket), CLI move-ticket.js (стадия move-to-in-progress)
 * и авто-коррекция pick-next-task.js (правило конфига с to_dir: in_progress).
 * Для каждого пути: первый вход ставит метку, повторный вход её не меняет,
 * перенос обратно её не стирает.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stampStartedAt, moveTicket } from '../lib/operations/tickets.mjs';
import { parseFrontmatter } from '../lib/utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOVE_TICKET = path.resolve(__dirname, '../scripts/move-ticket.js');
const PICK_NEXT_TASK = path.resolve(__dirname, '../scripts/pick-next-task.js');

const COLUMNS = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'archive'];
// Метка прошлой попытки: заведомо в прошлом и не совпадает с «сейчас» теста.
const EARLIER_START = '2026-09-29T19:15:00.000Z';

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-started-at-'));
  for (const col of COLUMNS) {
    fs.mkdirSync(path.join(root, '.workflow', 'tickets', col), { recursive: true });
  }
  return root;
}

function writeTicket(root, column, id, extra = '') {
  const content = `---
id: ${id}
title: Тикет ${id}
priority: 2
type: impl
created_at: "2026-09-30T00:00:00Z"
updated_at: "2026-09-30T00:00:00Z"
completed_at: ""
dependencies: []
conditions: []
status: ${column}
${extra}---

## Описание

Тест метки начала работы.
`;
  fs.writeFileSync(path.join(root, '.workflow', 'tickets', column, `${id}.md`), content);
}

function readFm(root, column, id) {
  const file = path.join(root, '.workflow', 'tickets', column, `${id}.md`);
  return parseFrontmatter(fs.readFileSync(file, 'utf8')).frontmatter;
}

function runMoveTicket(root, id, target) {
  const run = spawnSync(process.execPath, [MOVE_TICKET, id, target], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, `move-ticket ${id} → ${target}: ${run.stderr}\n${run.stdout}`);
  return run;
}

// Разные миллисекунды у соседних переходов: без паузы повторная метка могла бы
// совпасть с первой и тест не отличил бы «не менял» от «переписал тем же».
function tick() {
  const until = Date.now() + 5;
  while (Date.now() < until) { /* ждём смену миллисекунды */ }
}

describe('stampStartedAt', () => {
  const NOW = '2026-10-01T03:00:00.000Z';

  it('ставит метку при входе в in-progress, если её нет', () => {
    const fm = {};
    assert.equal(stampStartedAt(fm, 'in-progress', NOW), true);
    assert.equal(fm.started_at, NOW);
  });

  it('по умолчанию берёт текущее время в ISO 8601 UTC', () => {
    const before = Date.now();
    const fm = {};
    stampStartedAt(fm, 'in-progress');
    const after = Date.now();
    assert.match(fm.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const ms = Date.parse(fm.started_at);
    assert.ok(ms >= before && ms <= after, `${fm.started_at} вне [${before}, ${after}]`);
  });

  it('при переходе в другие колонки метку не ставит и не стирает', () => {
    for (const target of ['backlog', 'ready', 'review', 'blocked', 'done', 'archive']) {
      const empty = {};
      assert.equal(stampStartedAt(empty, target, NOW), false, target);
      assert.equal('started_at' in empty, false, target);
      const stamped = { started_at: EARLIER_START };
      stampStartedAt(stamped, target, NOW);
      assert.equal(stamped.started_at, EARLIER_START, target);
    }
  });

  it('стоящую метку при повторном входе не меняет', () => {
    const fm = { started_at: EARLIER_START };
    assert.equal(stampStartedAt(fm, 'in-progress', NOW), false);
    assert.equal(fm.started_at, EARLIER_START);
  });

  it('метку, разобранную YAML в Date, при повторном входе не меняет', () => {
    const date = new Date(EARLIER_START);
    const fm = { started_at: date };
    assert.equal(stampStartedAt(fm, 'in-progress', NOW), false);
    assert.equal(fm.started_at, date);
  });

  it('пустую и неразбираемую метку заменяет', () => {
    for (const bad of ['', null, 'вчера вечером']) {
      const fm = { started_at: bad };
      assert.equal(stampStartedAt(fm, 'in-progress', NOW), true, String(bad));
      assert.equal(fm.started_at, NOW, String(bad));
    }
  });

  it('метку из будущего (вписанную моделью) заменяет', () => {
    const fm = { started_at: '2026-10-02T00:00:00Z' };
    assert.equal(stampStartedAt(fm, 'in-progress', NOW), true);
    assert.equal(fm.started_at, NOW);
  });
});

describe('operations moveTicket: started_at', () => {
  let root;
  beforeEach(() => { root = makeProject(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('первый переход ready → in-progress ставит started_at = updated_at перехода', async () => {
    writeTicket(root, 'ready', 'IMPL-001');
    const before = Date.now();
    await moveTicket(root, 'IMPL-001', 'in-progress');
    const fm = readFm(root, 'in-progress', 'IMPL-001');
    assert.equal(typeof fm.started_at, 'string');
    assert.equal(fm.started_at, fm.updated_at);
    assert.ok(Date.parse(fm.started_at) >= before);
  });

  it('повторный вход после ревью метку не меняет, перенос обратно её сохраняет', async () => {
    writeTicket(root, 'ready', 'IMPL-002');
    await moveTicket(root, 'IMPL-002', 'in-progress');
    const first = readFm(root, 'in-progress', 'IMPL-002').started_at;
    assert.equal(typeof first, 'string', 'первый вход поставил метку');

    tick();
    await moveTicket(root, 'IMPL-002', 'review');
    assert.equal(readFm(root, 'review', 'IMPL-002').started_at, first, 'in-progress → review');

    tick();
    await moveTicket(root, 'IMPL-002', 'ready');
    assert.equal(readFm(root, 'ready', 'IMPL-002').started_at, first, 'review → ready');

    tick();
    await moveTicket(root, 'IMPL-002', 'in-progress');
    const fm = readFm(root, 'in-progress', 'IMPL-002');
    assert.equal(fm.started_at, first, 'ready → in-progress (повтор)');
    assert.notEqual(fm.updated_at, first, 'updated_at повтора свой — метка не он');

    await moveTicket(root, 'IMPL-002', 'done');
    assert.equal(readFm(root, 'done', 'IMPL-002').started_at, first, 'in-progress → done');
  });

  it('метку прошлой попытки review → in-progress не трогает', async () => {
    writeTicket(root, 'review', 'IMPL-003', `started_at: "${EARLIER_START}"\n`);
    await moveTicket(root, 'IMPL-003', 'in-progress');
    assert.equal(readFm(root, 'in-progress', 'IMPL-003').started_at, EARLIER_START);
  });
});

describe('move-ticket.js: started_at', () => {
  let root;
  beforeEach(() => { root = makeProject(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('первый переход ready → in-progress ставит started_at = updated_at перехода', () => {
    writeTicket(root, 'ready', 'IMPL-011');
    const before = Date.now();
    runMoveTicket(root, 'IMPL-011', 'in-progress');
    const fm = readFm(root, 'in-progress', 'IMPL-011');
    assert.equal(typeof fm.started_at, 'string');
    assert.equal(fm.started_at, fm.updated_at);
    assert.ok(Date.parse(fm.started_at) >= before);
  });

  it('повторный вход по пути повтора пайплайна метку не меняет, перенос обратно её сохраняет', () => {
    writeTicket(root, 'ready', 'IMPL-012');
    runMoveTicket(root, 'IMPL-012', 'in-progress');
    const first = readFm(root, 'in-progress', 'IMPL-012').started_at;
    assert.equal(typeof first, 'string', 'первый вход поставил метку');

    runMoveTicket(root, 'IMPL-012', 'review');
    assert.equal(readFm(root, 'review', 'IMPL-012').started_at, first, 'in-progress → review');

    runMoveTicket(root, 'IMPL-012', 'ready');
    assert.equal(readFm(root, 'ready', 'IMPL-012').started_at, first, 'review → ready');

    runMoveTicket(root, 'IMPL-012', 'in-progress');
    const fm = readFm(root, 'in-progress', 'IMPL-012');
    assert.equal(fm.started_at, first, 'ready → in-progress (повтор)');
    assert.notEqual(fm.updated_at, first, 'updated_at повтора свой — метка не он');

    runMoveTicket(root, 'IMPL-012', 'blocked');
    assert.equal(readFm(root, 'blocked', 'IMPL-012').started_at, first, 'in-progress → blocked');
  });

  it('метку прошлой попытки review → in-progress не трогает', () => {
    writeTicket(root, 'review', 'IMPL-013', `started_at: "${EARLIER_START}"\n`);
    runMoveTicket(root, 'IMPL-013', 'in-progress');
    assert.equal(readFm(root, 'in-progress', 'IMPL-013').started_at, EARLIER_START);
  });
});

describe('pick-next-task.js авто-коррекция: started_at', () => {
  let root;
  beforeEach(() => { root = makeProject(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function writeRules() {
    const dir = path.join(root, '.workflow', 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ticket-movement-rules.yaml'), `version: "1.0"
rules:
  review:
    - condition: null
      to_dir: in_progress
      reason: "no review"
  in_progress:
    - condition: failed
      to_dir: ready
      reason: "review failed"
`);
  }

  function runPick() {
    const run = spawnSync(process.execPath, [PICK_NEXT_TASK], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, `pick-next-task: ${run.stderr}\n${run.stdout}`);
    return run;
  }

  it('правило с to_dir: in_progress ставит метку, если её нет', () => {
    writeRules();
    writeTicket(root, 'review', 'IMPL-021');
    const before = Date.now();
    const run = runPick();
    assert.match(run.stdout, /\[AUTO-CORRECT\] IMPL-021: review → in-progress/);
    const fm = readFm(root, 'in-progress', 'IMPL-021');
    assert.equal(typeof fm.started_at, 'string');
    assert.equal(fm.started_at, fm.updated_at);
    assert.ok(Date.parse(fm.started_at) >= before);
  });

  it('правило с to_dir: in_progress стоящую метку не меняет', () => {
    writeRules();
    writeTicket(root, 'review', 'IMPL-022', `started_at: "${EARLIER_START}"\n`);
    runPick();
    assert.equal(readFm(root, 'in-progress', 'IMPL-022').started_at, EARLIER_START);
  });

  it('перенос из in-progress по правилу метку сохраняет', () => {
    writeRules();
    const failed = `started_at: "${EARLIER_START}"\n`;
    writeTicket(root, 'in-progress', 'IMPL-023', failed);
    fs.appendFileSync(
      path.join(root, '.workflow', 'tickets', 'in-progress', 'IMPL-023.md'),
      '\n## Ревью\n\n| Дата | Статус | Самари | Агент |\n|------|--------|--------|-------|\n| 2026-09-30 | ❌ failed | тест | test |\n',
    );
    const run = runPick();
    assert.match(run.stdout, /\[AUTO-CORRECT\] IMPL-023: in-progress → ready/);
    assert.equal(readFm(root, 'ready', 'IMPL-023').started_at, EARLIER_START);
  });
});
