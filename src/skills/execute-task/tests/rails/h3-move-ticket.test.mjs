// H3: перемещение тикета и смена статуса — работа пайплайна, не исполнителя
// (SKILL.md P0R4: дубль ключа frontmatter оставляет тикет в директории навсегда).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, atNode, ctx, claude, decide } from './_project.mjs';

test('H3: move-ticket.js — отказ в любой форме вызова', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P5S1');
    for (const command of [
      'node .workflow/src/scripts/move-ticket.js TASK-001 review',
      'node src/scripts/move-ticket.js TASK-001 done',
      'cd .workflow && node src/scripts/move-ticket TASK-001 review',
    ]) {
      assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'deny', command);
    }
  });
});

test('H3: перемещение файла тикета shell-командой — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P5S1');
    for (const command of [
      'mv .workflow/tickets/in-progress/TASK-001.md .workflow/tickets/review/TASK-001.md',
      'rename .workflow/tickets/in-progress/TASK-001.md TASK-001.done.md',
    ]) {
      assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'deny', command);
    }
    const ps = decide({
      action: claude('PowerShell', { command: 'Move-Item .workflow/tickets/in-progress/TASK-001.md .workflow/tickets/review/' }),
      ctx: ctx(root, s),
    });
    assert.equal(ps.decision, 'deny');
  });
});

test('H3: MCP-инструмент move_ticket — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P5S1');
    const r = decide({ action: claude('mcp__workflow__move_ticket', { ticket_id: 'TASK-001' }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'deny');
  });
});

test('H3: обычная работа с файлами проекта не задета', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P3S1');
    for (const command of ['mv src/a.ts src/b.ts', 'npm test', 'git status']) {
      assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'allow', command);
    }
  });
});
