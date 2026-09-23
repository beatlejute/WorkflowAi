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
