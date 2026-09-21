/**
 * Хук открытия manual-gate при перемещении тикета.
 *
 * Раньше хук жил только в CLI-скрипте `src/scripts/move-ticket.js`, поэтому
 * всё, что двигало тикет через библиотеку — MCP `move_ticket`,
 * `resolve_human_ticket`, кнопка «Move to review» в VS Code-расширении, —
 * оставляло гейт в `pending`. Раннер ждёт решения до `manual-gate-human.timeout`
 * (86400 с) и после этого уводит тикет в blocked, то есть human-задача молча
 * умирала через сутки.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';

import { moveTicket, approveOpenGates } from '../lib/operations/tickets.mjs';

describe('approval-хук в moveTicket', () => {
  let projectRoot;

  const STATUSES = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'archive'];

  beforeEach(() => {
    projectRoot = join(tmpdir(), `wf-approval-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    for (const status of STATUSES) {
      mkdirSync(join(projectRoot, '.workflow', 'tickets', status), { recursive: true });
    }
    mkdirSync(join(projectRoot, '.workflow', 'approvals'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Кладёт тикет в указанную колонку. */
  function writeTicket(id, status) {
    writeFileSync(
      join(projectRoot, '.workflow', 'tickets', status, `${id}.md`),
      `---\nid: ${id}\ntitle: Human task\npriority: 1\ntype: human\n---\n\nBody\n`
    );
  }

  /** Кладёт approval-файл и возвращает его путь. */
  function writeApproval(name, payload) {
    const filePath = join(projectRoot, '.workflow', 'approvals', name);
    writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return filePath;
  }

  function readApproval(name) {
    return JSON.parse(readFileSync(join(projectRoot, '.workflow', 'approvals', name), 'utf8'));
  }

  test('TC1: перемещение тикета переводит его pending-гейт в approved', async () => {
    writeTicket('HUMAN-1', 'in-progress');
    writeApproval('HUMAN-1_manual-gate-human_1.json', {
      ticket_id: 'HUMAN-1',
      stage_id: 'manual-gate-human',
      status: 'pending'
    });

    const result = await moveTicket(projectRoot, 'HUMAN-1', 'review');

    assert.equal(result.to, 'review');
    assert.deepEqual(result.approvals, ['HUMAN-1_manual-gate-human_1.json']);

    const decided = readApproval('HUMAN-1_manual-gate-human_1.json');
    assert.equal(decided.status, 'approved', 'гейт должен открыться');
    assert.equal(decided.decided_by, 'move-ticket');
    assert.match(decided.comment, /review/);
    assert.ok(decided.updated_at, 'должна проставиться метка времени');
  });

  test('TC2: гейт чужого тикета не трогается', async () => {
    writeTicket('HUMAN-1', 'in-progress');
    writeApproval('HUMAN-2_manual-gate-human_1.json', {
      ticket_id: 'HUMAN-2',
      status: 'pending'
    });

    const result = await moveTicket(projectRoot, 'HUMAN-1', 'review');

    assert.deepEqual(result.approvals, [], 'ничего не должно быть открыто');
    assert.equal(readApproval('HUMAN-2_manual-gate-human_1.json').status, 'pending');
  });

  test('TC3: уже принятое решение не переписывается', async () => {
    writeTicket('HUMAN-1', 'in-progress');
    writeApproval('HUMAN-1_manual-gate-human_1.json', {
      ticket_id: 'HUMAN-1',
      status: 'rejected',
      decided_by: 'human',
      comment: 'не надо'
    });

    await moveTicket(projectRoot, 'HUMAN-1', 'review');

    const untouched = readApproval('HUMAN-1_manual-gate-human_1.json');
    assert.equal(untouched.status, 'rejected', 'отказ человека важнее автоматики');
    assert.equal(untouched.comment, 'не надо');
  });

  test('TC4: открываются все попытки одного гейта', async () => {
    writeTicket('HUMAN-1', 'in-progress');
    writeApproval('HUMAN-1_manual-gate-human_1.json', { status: 'pending' });
    writeApproval('HUMAN-1_manual-gate-human_2.json', { status: 'pending' });

    const result = await moveTicket(projectRoot, 'HUMAN-1', 'review');

    assert.equal(result.approvals.length, 2);
    assert.equal(readApproval('HUMAN-1_manual-gate-human_1.json').status, 'approved');
    assert.equal(readApproval('HUMAN-1_manual-gate-human_2.json').status, 'approved');
  });

  test('TC5: файлы не-гейтов игнорируются', async () => {
    writeTicket('HUMAN-1', 'in-progress');
    // Не подходит под шаблон `<id>_manual-gate-*_<attempt>.json`.
    writeApproval('HUMAN-1_review-result_1.json', { status: 'pending' });

    const result = await moveTicket(projectRoot, 'HUMAN-1', 'review');

    assert.deepEqual(result.approvals, []);
    assert.equal(readApproval('HUMAN-1_review-result_1.json').status, 'pending');
  });

  test('TC6: битый JSON не ломает перемещение', async () => {
    writeTicket('HUMAN-1', 'in-progress');
    writeFileSync(
      join(projectRoot, '.workflow', 'approvals', 'HUMAN-1_manual-gate-human_1.json'),
      '{ это не json'
    );

    const result = await moveTicket(projectRoot, 'HUMAN-1', 'review');

    assert.equal(result.to, 'review', 'тикет всё равно должен переехать');
    assert.deepEqual(result.approvals, []);
  });

  test('TC7: отсутствие каталога approvals не ломает перемещение', async () => {
    rmSync(join(projectRoot, '.workflow', 'approvals'), { recursive: true, force: true });
    writeTicket('IMPL-1', 'in-progress');

    const result = await moveTicket(projectRoot, 'IMPL-1', 'review');

    assert.equal(result.to, 'review');
    assert.deepEqual(result.approvals, []);
  });

  test('TC8: ID с regex-символами не задевает соседний тикет', async () => {
    // Без экранирования точка в `HUMAN.1` становится «любой символ» и шаблон
    // начинает совпадать ещё и с гейтом HUMAN-1 — чужой тикет открывается сам.
    writeApproval('HUMAN.1_manual-gate-human_1.json', { status: 'pending' });
    writeApproval('HUMAN-1_manual-gate-human_1.json', { status: 'pending' });

    const approved = await approveOpenGates(projectRoot, 'HUMAN.1', 'review');

    assert.deepEqual(approved, ['HUMAN.1_manual-gate-human_1.json']);
    assert.equal(
      readApproval('HUMAN-1_manual-gate-human_1.json').status,
      'pending',
      'гейт соседнего тикета обязан остаться нетронутым'
    );
  });
});
