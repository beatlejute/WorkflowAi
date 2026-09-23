// H3: перемещение тикета, смена статуса и git — не работа ревьюера.
// H4: механическая предпроверка скриптом — этап 2, запись в тикет — этап 6 (Single Pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, atNode, ctx, claude, decide, ticket } from './_project.mjs';

const VERIFY = 'node .workflow/src/skills/review-result/scripts/verify-artifacts.js TASK-001';

test('H3: move-ticket, перемещение файла тикета и git-операции — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P6S1');
    for (const command of [
      'node .workflow/src/scripts/move-ticket.js TASK-001 done',
      'mv .workflow/tickets/review/TASK-001.md .workflow/tickets/done/TASK-001.md',
      'git commit -m "review passed"',
      'git add .workflow/tickets/review/TASK-001.md',
    ]) {
      assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'deny', command);
    }
    const mcp = decide({ action: claude('mcp__workflow__move_ticket', { ticket_id: 'TASK-001' }), ctx: ctx(root, s) });
    assert.equal(mcp.decision, 'deny');
  });
});

test('H4: verify-artifacts.js — только на этапе 2', () => {
  withProject(({ root }) => {
    assert.equal(decide({ action: claude('Bash', { command: VERIFY }), ctx: ctx(root, atNode(root, 'P2S1')) }).decision, 'allow');
    for (const node of ['P1S1', 'P4S2', 'P6S1']) {
      const r = decide({ action: claude('Bash', { command: VERIFY }), ctx: ctx(root, atNode(root, node)) });
      assert.equal(r.decision, 'deny', node);
    }
  });
});

test('H4: запись в тикет на ревью — только на этапе 6', () => {
  withProject(({ root }) => {
    const p = ticket(root, 'review');
    assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, atNode(root, 'P6S1')) }).decision, 'allow');
    for (const node of ['P0S3', 'P2S1', 'P3S1', 'P4S2', 'P5R1']) {
      const r = decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, atNode(root, node)) });
      assert.equal(r.decision, 'deny', node);
    }
  });
});

test('канарейка и роль исполнителя', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P0S1');
    const denied = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, s) });
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason, /RAILS_CANARY/);
    const executor = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, s, { role: 'executor' }) });
    assert.equal(executor.decision, 'allow');
  });
});
