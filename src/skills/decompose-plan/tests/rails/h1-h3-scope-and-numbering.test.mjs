// H1 и H2: декомпозитор пишет тикеты в backlog и ссылки в план, остальные колонки
// доски двигает пайплайн, конфиг типов и capabilities — источник правды, а не продукт.
// H3: нумерация приходит в id_ranges со входа стадии. Инциденты PulseProxy PLAN-014
// (2026-04-20) и workflowAi CHG-029: номер, взятый не из выделенного диапазона, даёт
// коллизию ID, а depends_on и parent_plan уже ссылаются на записанный идентификатор —
// ломается ссылочная целостность всей доски.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withProject, atNode, ctx, claude, decide, ticket, plan } from './_project.mjs';

test('H1: тикет в backlog и ссылки в плане — запись разрешена на этапе работы', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S15');
    const r = decide({ action: claude('Write', { file_path: ticket(root, 'backlog', 'IMPL-003.md') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'allow', JSON.stringify(r));
    assert.equal(decide({ action: claude('Edit', { file_path: plan(root) }), ctx: ctx(root, s) }).decision, 'allow');
  });
});

test('H2: чужие колонки доски и конфигурация — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S15');
    for (const p of [
      ticket(root, 'ready', 'IMPL-002.md'),
      ticket(root, 'in-progress', 'IMPL-004.md'),
      ticket(root, 'done', 'IMPL-005.md'),
      join(root, '.workflow', 'config', 'config.yaml'),
    ]) {
      assert.equal(decide({ action: claude('Write', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});

test('H2: собственный rails.yaml, тесты гардов и ядро рельс — отказ (принцип 17)', () => {
  withProject(({ root, link }) => {
    const s = atNode(root, 'P10S15');
    for (const p of [
      join(link, 'rails.yaml'),
      join(link, 'tests', 'rails', 'h1-h3-scope-and-numbering.test.mjs'),
      join(root, '.workflow', 'src', 'rails', 'core.mjs'),
    ]) {
      assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});

test('H3: выдача ID скриптом, перемещение тикетов и git — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S13');
    for (const command of [
      'node .workflow/src/scripts/get-next-id.js --prefix IMPL --dir tickets',
      'node .workflow/src/scripts/move-ticket.js IMPL-001 ready',
      'git add .workflow/tickets/backlog/IMPL-003.md',
    ]) {
      assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'deny', command);
    }
    const mcp = decide({ action: claude('mcp__workflow__move_ticket', { ticket_id: 'IMPL-001' }), ctx: ctx(root, s) });
    assert.equal(mcp.decision, 'deny');
  });
});

test('H1: чтение плана, конфига и чужих тикетов разрешено — декомпозиция читает всё', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S1');
    for (const p of [plan(root), join(root, '.workflow', 'config', 'config.yaml'), ticket(root, 'ready', 'IMPL-002.md')]) {
      assert.equal(decide({ action: claude('Read', { file_path: p }), ctx: ctx(root, s) }).decision, 'allow', p);
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

// H3: план активирует только стадия пайплайна (узел P0R9). Самопроверка узла P10G7 — тот же
// скрипт verify-atomicity.js без флага; с --activate он переводит план в active. Инцидент
// PulseProxy PLAN-020 (2026-09-29): самопроверка внутри стадии перевела план в active, и стадия
// пайплайна застала его уже активным (plan_status_reason: already_terminal_status).
const VERIFY = 'node .workflow/src/skills/decompose-plan/scripts/verify-atomicity.js';

test('H3: verify-atomicity.js с --activate — отказ; самопроверка P10G7 без флага и делегат — молчание', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10G7');
    for (const command of [
      `${VERIFY} --activate "plan_file: plans/current/PLAN-001.md"`,
      `${VERIFY} "plan_file: plans/current/PLAN-001.md" --activate`,
      `cd .workflow && node src/skills/decompose-plan/scripts/verify-atomicity --activate plan_file: plans/current/PLAN-001.md`,
    ]) {
      const r = decide({ action: claude('Bash', { command }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'deny', command);
      assert.match(r.reason, /План активирует только стадия пайплайна \(узел P0R9\)/, command);
    }
    const selfCheck = `${VERIFY} plan_file: plans/current/PLAN-001.md`;
    const own = decide({ action: claude('Bash', { command: selfCheck }), ctx: ctx(root, s) });
    assert.equal(own.decision, 'allow', JSON.stringify(own));
    const executor = decide({ action: claude('Bash', { command: `${VERIFY} --activate plan_file: plans/current/PLAN-001.md` }), ctx: ctx(root, s, { role: 'executor' }) });
    assert.equal(executor.decision, 'allow');
  });
});

test('H3: переход в P10G7 с цитатой «… без флага --activate» — команда рельс, гард её не трогает', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S16');
    const command = "node .workflow/src/rails/cli.mjs goto P10G7 --quote 'verify-atomicity.js plan_file: {plan_path} без флага --activate печатает status: passed'";
    const r = decide({ action: claude('Bash', { command }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'allow', JSON.stringify(r));
  });
});
