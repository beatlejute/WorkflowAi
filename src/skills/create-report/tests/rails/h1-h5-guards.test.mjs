// H1 и H2: отчётчик пишет ровно один артефакт — файл отчёта. Тикеты, планы и логи для
// него источник данных: правка тикета «под отчёт» подменяет то, что отчёт и описывает.
// H3: перемещение тикетов и git — чужие стадии. H4: скрипт выдачи ID и запись отчёта
// разрешены только на этапе работы, когда данные собраны и атрибуция сделана.
// H5: выходной слой требует report_id — без него аналитик и следующий отчёт не знают,
// какой файл считать текущим, и запрещает угаданную атрибуцию root cause: тикет не
// говорит, какой стейдж принял решение, а угаданное обвинение уводит правку не в тот
// компонент (кейс TC-CREATE-REPORT-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withProject, atNode, ctx, claude, decide, ticket, plan, report, loadSkillRuntime, loadState, SKILL } from './_project.mjs';
import { check } from '../../../../rails/output-check.mjs';

const NEXT_ID = 'node .workflow/src/scripts/get-next-id.js --prefix REPORT --dir .workflow/reports';

const OK = [
  'RAILS: P6S2',
  'verdict = default',
  'Файлы: .workflow/reports/REPORT-002.md',
  '---RESULT---',
  'status: default',
  'report_id: REPORT-002',
  '---RESULT---',
].join('\n');

function answer(root, text, node = 'P6S2') {
  const { config } = loadSkillRuntime(root, SKILL);
  return check(text, config, loadState(root, atNode(root, node)));
}

test('H1: файл отчёта — запись разрешена на этапе работы', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S13');
    assert.equal(decide({ action: claude('Write', { file_path: report(root, 'REPORT-002.md') }), ctx: ctx(root, s) }).decision, 'allow');
  });
});

test('H2: тикеты, планы и логи — отказ на любом узле', () => {
  withProject(({ root }) => {
    for (const node of ['P10S1', 'P10S13', 'P6S1']) {
      const s = atNode(root, node);
      for (const p of [ticket(root, 'done', 'IMPL-001.md'), plan(root), join(root, '.workflow', 'logs', 'pipeline.log')]) {
        assert.equal(decide({ action: claude('Write', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', `${node}: ${p}`);
      }
    }
  });
});

test('H2: собственный rails.yaml, тесты гардов и ядро рельс — отказ (принцип 17)', () => {
  withProject(({ root, link }) => {
    const s = atNode(root, 'P10S13');
    for (const p of [
      join(link, 'rails.yaml'),
      join(link, 'tests', 'rails', 'h1-h5-guards.test.mjs'),
      join(root, '.workflow', 'src', 'rails', 'core.mjs'),
    ]) {
      assert.equal(decide({ action: claude('Edit', { file_path: p }), ctx: ctx(root, s) }).decision, 'deny', p);
    }
  });
});

test('H3: перемещение тикетов и git — отказ', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S6');
    for (const command of ['node .workflow/src/scripts/move-ticket.js IMPL-001 done', 'git commit -m "report"']) {
      assert.equal(decide({ action: claude('Bash', { command }), ctx: ctx(root, s) }).decision, 'deny', command);
    }
    assert.equal(decide({ action: claude('mcp__workflow__move_ticket', { ticket_id: 'IMPL-001' }), ctx: ctx(root, s) }).decision, 'deny');
  });
});

test('H4: скрипт выдачи ID и запись отчёта — только на этапе 10', () => {
  withProject(({ root }) => {
    const work = atNode(root, 'P10S12');
    assert.equal(decide({ action: claude('Bash', { command: NEXT_ID }), ctx: ctx(root, work) }).decision, 'allow');
    for (const node of ['P0S3', 'P6S1']) {
      const s = atNode(root, node);
      assert.equal(decide({ action: claude('Bash', { command: NEXT_ID }), ctx: ctx(root, s) }).decision, 'deny', `ID на ${node}`);
      assert.equal(decide({ action: claude('Write', { file_path: report(root, 'REPORT-002.md') }), ctx: ctx(root, s) }).decision, 'deny', `запись на ${node}`);
    }
  });
});

test('H1: чтение тикетов, планов и логов разрешено — отчёт собирается из них', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S1');
    for (const p of [ticket(root, 'done', 'IMPL-001.md'), plan(root), join(root, '.workflow', 'logs', 'pipeline.log')]) {
      assert.equal(decide({ action: claude('Read', { file_path: p }), ctx: ctx(root, s) }).decision, 'allow', p);
    }
  });
});

test('H5: отчёт с report_id в терминале — принят, без него — отказ', () => {
  withProject(({ root }) => {
    assert.deepEqual(answer(root, OK), { ok: true, missing: [] });
    const without = OK.split('\n').filter((l) => !l.startsWith('report_id:')).join('\n');
    assert.equal(answer(root, without).ok, false);
  });
});

test('H5: угаданная атрибуция root cause — отказ', () => {
  withProject(({ root }) => {
    const r = answer(root, `${OK}\nвозможно, root cause в стадии проверки релевантности`);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('forbidden:')), JSON.stringify(r.missing));
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
