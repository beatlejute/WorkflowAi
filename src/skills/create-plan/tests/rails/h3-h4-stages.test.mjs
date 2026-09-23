// H3: чужие стадии — перемещение и создание тикетов, запуск пайплайна, git.
// H4: скрипты сохранения плана работают только на этапе 5. Инциденты workflowAi
// CHG-023 (добавлен шаг автоматической валидации) и CHG-024 (валидация перед
// сохранением, не после): валидатор, запущенный после отчёта стейкхолдеру, не
// защищает — стейкхолдер уже получил план, который не проходит проверку.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, atNode, ctx, claude, decide, plan } from './_project.mjs';

const NEXT_ID = 'node .workflow/src/scripts/get-next-id.js --prefix PLAN --dir plans';
const VALIDATE = 'node .workflow/src/skills/create-plan/scripts/validate-completeness.js .workflow/plans/current/PLAN-002.md';

test('H3: тикеты, пайплайн и git — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P5S5');
    for (const command of [
      'node .workflow/src/scripts/move-ticket.js TASK-001 in-progress',
      'git commit -m "plan"',
      'git add .workflow/plans/current/PLAN-002.md',
    ]) {
      assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'deny', command);
    }
    for (const tool of ['mcp__workflow__create_ticket', 'mcp__workflow__move_ticket', 'mcp__workflow__start_pipeline']) {
      const r = decide({ action: claude(tool, { ticket_id: 'TASK-001' }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'deny', tool);
    }
  });
});

test('H4: скрипт выдачи ID и валидатор — только на этапе 5', () => {
  withProject(({ root }) => {
    const save = atNode(root, 'P5S4');
    assert.equal(decide({ action: claude('Bash', { command: NEXT_ID }), ctx: ctx(root, save) }).decision, 'allow');
    assert.equal(decide({ action: claude('Bash', { command: VALIDATE }), ctx: ctx(root, save) }).decision, 'allow');

    for (const node of ['P0S3', 'P10S2', 'P10S6', 'P6S1']) {
      const s = atNode(root, node);
      assert.equal(decide({ action: claude('Bash', { command: NEXT_ID }), ctx: ctx(root, s) }).decision, 'deny', `ID на ${node}`);
      assert.equal(decide({ action: claude('Bash', { command: VALIDATE }), ctx: ctx(root, s) }).decision, 'deny', `валидатор на ${node}`);
    }
  });
});

test('H4: запись плана — только на этапе 5, до самопроверки план не сохраняется', () => {
  withProject(({ root }) => {
    assert.equal(decide({ action: claude('Write', { file_path: plan(root) }), ctx: ctx(root, atNode(root, 'P5S5')) }).decision, 'allow');
    for (const node of ['P10S2', 'P10S6', 'P10S10', 'P6S1']) {
      const r = decide({ action: claude('Write', { file_path: plan(root) }), ctx: ctx(root, atNode(root, node)) });
      assert.equal(r.decision, 'deny', node);
    }
  });
});

test('H3: делегат (role executor) — молчание на тех же командах', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S2');
    for (const command of [NEXT_ID, VALIDATE, 'git commit -m "plan"']) {
      const r = decide({ action: claude('Bash', { command }), ctx: ctx(root, s, { role: 'executor' }) });
      assert.equal(r.decision, 'allow', command);
    }
  });
});
