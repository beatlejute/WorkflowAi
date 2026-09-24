// H1 и H2: тестировщик пишет результаты в собственный тикет в in-progress/ и артефакты
// evidence в reports/ в корне проекта; создание тикета закрыто гардом — инцидент
// 2026-05-02: исполнитель в роли тестировщика создал парный тикет в backlog, чтобы
// делегировать live-проверки UI человеку, стейкхолдер откатил созданное, проверки не
// выполнены. План, отчёт и чужие колонки доски — не его зона.
// H3: перемещение тикета и выделение ID нового тикета — чужие стадии; перемещение
// оставляет тикет в done/ без ревью (узел P5R2).
// H4: запись в тикет разрешена на этапах работы и на self-check, не раньше.
// H6: блок результата обязателен, упоминание созданного тикета в выводе запрещено
// (тот же инцидент 2026-05-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withProject, atNode, ctx, claude, decide, ticket, plan, report, evidence, loadSkillRuntime, loadState, SKILL } from './_project.mjs';
import { check } from '../../../../rails/output-check.mjs';

const OK = [
  'RAILS: P9S2',
  'verdict = smoke_passed',
  'Файлы: reports/qa001-screenshot-01.png',
  '---RESULT---',
  'status: default',
  '---RESULT---',
].join('\n');

function answer(root, text, node = 'P9S2') {
  const { config } = loadSkillRuntime(root, SKILL);
  return check(text, config, loadState(root, atNode(root, node)));
}

test('H1: результат в свой тикет и evidence в reports/ — запись разрешена на этапе проверки', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S4');
    for (const p of [ticket(root, 'in-progress'), evidence(root)]) {
      assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, s) }).decision, 'allow', p);
    }
  });
});

test('H1: ассерт для не-UI инварианта в тестах проекта разрешён — легитимная работа QA', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S4');
    const p = join(root, 'tests', 'state.test.mjs');
    assert.equal(decide({ action: claude('Write', { file_path: p }), ctx: ctx(root, s) }).decision, 'allow');
  });
});

test('H2: создание тикета в backlog — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S4');
    const p = ticket(root, 'backlog', 'QA-099.md');
    assert.equal(decide({ action: claude('Write', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny');
  });
});

test('H2: план, отчёт, чужие колонки доски и конфиг — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S4');
    for (const p of [
      plan(root),
      report(root),
      ticket(root, 'ready', 'QA-003.md'),
      ticket(root, 'done', 'QA-004.md'),
      join(root, '.workflow', 'config', 'config.yaml'),
    ]) {
      assert.equal(decide({ action: claude('Write', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});

test('H2: собственный rails.yaml, тесты гардов и ядро рельс — отказ (принцип 17)', () => {
  withProject(({ root, link }) => {
    const s = atNode(root, 'P10S4');
    for (const p of [
      join(link, 'rails.yaml'),
      join(link, 'tests', 'rails', 'h1-h6-guards.test.mjs'),
      join(root, '.workflow', 'src', 'rails', 'core.mjs'),
    ]) {
      assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});

test('H3: перемещение тикета, выделение ID нового тикета и запуск пайплайна — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S4');
    for (const command of [
      'node .workflow/src/scripts/move-ticket.js QA-001 review',
      'mv .workflow/tickets/in-progress/QA-001.md .workflow/tickets/done/QA-001.md',
      'node .workflow/src/scripts/get-next-id.js --type qa',
    ]) {
      assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'deny', command);
    }
    for (const tool of ['mcp__workflow__move_ticket', 'mcp__workflow__create_ticket', 'mcp__workflow__start_pipeline']) {
      assert.equal(decide({ action: claude(tool, { ticket_id: 'QA-001' }), ctx: ctx(root, s) }).decision, 'deny', tool);
    }
  });
});

test('H4: запись в тикет до этапа работы — отказ', () => {
  withProject(({ root }) => {
    for (const node of ['P0S3', 'P9S1']) {
      const s = atNode(root, node);
      assert.equal(decide({ action: claude('Edit', { file_path: ticket(root, 'in-progress') }), ctx: ctx(root, s) }).decision, 'deny', node);
    }
  });
});

test('H4: отметки DoD и уборка evidence на self-check — разрешены', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P5S6');
    for (const p of [ticket(root, 'in-progress'), evidence(root)]) {
      assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, s) }).decision, 'allow', p);
    }
  });
});

test('H1: чтение плана, отчёта и чужих тикетов разрешено — проверка идёт по ним', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S2');
    for (const p of [plan(root), report(root), ticket(root, 'done', 'QA-004.md')]) {
      assert.equal(decide({ action: claude('Read', { file_path: p }), ctx: ctx(root, s) }).decision, 'allow', p);
    }
  });
});

test('H6: блок результата со статусом — принят, без него — отказ', () => {
  withProject(({ root }) => {
    assert.deepEqual(answer(root, OK), { ok: true, missing: [] });
    const without = OK.split('\n').filter((l) => !l.startsWith('status:')).join('\n');
    assert.equal(answer(root, without).ok, false);
  });
});

test('H6: упоминание созданного тикета в выводе — отказ', () => {
  withProject(({ root }) => {
    for (const tail of ['Создан тикет на доработку для человека.', 'Оформлен HUMAN-тикет на live-проверку.']) {
      const r = answer(root, `${OK}\n${tail}`);
      assert.equal(r.ok, false, tail);
      assert.ok(r.missing.some((m) => m.startsWith('forbidden:')), JSON.stringify(r.missing));
    }
  });
});

test('H6: финальный ответ не в терминале — отказ по положению', () => {
  withProject(({ root }) => {
    const r = answer(root, OK, 'P10S7');
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
