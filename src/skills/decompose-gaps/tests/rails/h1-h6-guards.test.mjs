// H1 и H2: скил кладёт тикеты-доработки в backlog и больше ничего не пишет. План и
// отчёт — вход: правка плана «под gap» подменяет то, из чего gap и выведен (инцидент
// 2026-04-18: тикет ушёл за границу утверждённого плана).
// H3: перемещение тикетов и git — чужие стадии.
// H4: запись тикета только на этапе работы, после проверки scope и стоп-гейтов.
// H6: блок результата обязателен со списком созданных тикетов; пустой parent_plan
// запрещён — такой тикет невидим для пайплайна, его не берут в работу и не архивируют
// (инциденты 2026-04-19 и 2026-04-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withProject, atNode, ctx, claude, decide, ticket, plan, report, loadSkillRuntime, loadState, SKILL } from './_project.mjs';
import { check } from '../../../../rails/output-check.mjs';

const OK = [
  'RAILS: P6S2',
  'verdict = default',
  'Файлы: .workflow/tickets/backlog/FIX-010.md',
  '---RESULT---',
  'status: default',
  'created_tickets: FIX-010, FIX-011',
  '---RESULT---',
].join('\n');

function answer(root, text, node = 'P6S2') {
  const { config } = loadSkillRuntime(root, SKILL);
  return check(text, config, loadState(root, atNode(root, node)));
}

test('H1: тикет-доработка в backlog — запись разрешена на этапе работы', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S9');
    assert.equal(decide({ action: claude('Write', { file_path: ticket(root, 'backlog', 'FIX-010.md') }), ctx: ctx(root, s) }).decision, 'allow');
  });
});

test('H2: план, отчёт, чужие колонки доски и конфиг — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S9');
    for (const p of [
      plan(root),
      report(root),
      ticket(root, 'ready', 'IMPL-002.md'),
      ticket(root, 'done', 'IMPL-003.md'),
      join(root, '.workflow', 'config', 'config.yaml'),
    ]) {
      assert.equal(decide({ action: claude('Write', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});

test('H2: собственный rails.yaml, тесты гардов и ядро рельс — отказ (принцип 17)', () => {
  withProject(({ root, link }) => {
    const s = atNode(root, 'P10S9');
    for (const p of [
      join(link, 'rails.yaml'),
      join(link, 'tests', 'rails', 'h1-h6-guards.test.mjs'),
      join(root, '.workflow', 'src', 'rails', 'core.mjs'),
    ]) {
      assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});

test('H3: перемещение тикетов, запуск пайплайна и git — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S9');
    for (const command of ['node .workflow/src/scripts/move-ticket.js FIX-010 ready', 'git add .workflow/tickets/backlog/FIX-010.md']) {
      assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'deny', command);
    }
    for (const tool of ['mcp__workflow__move_ticket', 'mcp__workflow__start_pipeline']) {
      assert.equal(decide({ action: claude(tool, { ticket_id: 'FIX-010' }), ctx: ctx(root, s) }).decision, 'deny', tool);
    }
  });
});

test('H4: запись тикета до этапа работы — отказ', () => {
  withProject(({ root }) => {
    for (const node of ['P0S3', 'P6S1']) {
      const s = atNode(root, node);
      assert.equal(decide({ action: claude('Write', { file_path: ticket(root, 'backlog', 'FIX-010.md') }), ctx: ctx(root, s) }).decision, 'deny', node);
    }
  });
});

test('H1: чтение плана, отчёта и тикетов разрешено — gap проверяется по ним', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S3');
    for (const p of [plan(root), report(root), ticket(root, 'done', 'IMPL-003.md')]) {
      assert.equal(decide({ action: claude('Read', { file_path: p }), ctx: ctx(root, s) }).decision, 'allow', p);
    }
  });
});

test('H6: результат со списком созданных тикетов — принят, без списка — отказ', () => {
  withProject(({ root }) => {
    assert.deepEqual(answer(root, OK), { ok: true, missing: [] });
    const without = OK.split('\n').filter((l) => !l.startsWith('created_tickets:')).join('\n');
    assert.equal(answer(root, without).ok, false);
  });
});

test('H6: пустой parent_plan в выводе — отказ', () => {
  withProject(({ root }) => {
    const r = answer(root, `${OK}\nparent_plan: ""`);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('forbidden:')), JSON.stringify(r.missing));
  });
});

test('H6: финальный ответ не в терминале — отказ по положению', () => {
  withProject(({ root }) => {
    const r = answer(root, OK, 'P10S9');
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('position:')), JSON.stringify(r.missing));
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
