// H4: запись тикета и скрипт дедупликации — только на этапе работы, после стоп-гейтов.
// H6: выходной слой — блок результата обязателен вместе с секцией ids_allocated_from.
// Инцидент PulseProxy PLAN-014 (2026-04-20): тикеты записывались до выписки реестра
// capabilities, ключи оказались изобретёнными — каскад no_capable_agent, 12 безрезультатных
// попыток исполнения, 2 тикета в blocked, план застопорен. Аудит 2026-09-21 (HIGH): шаблон
// блока результата не содержал ids_allocated_from, хотя стоп-гейт объявляет её частью
// контракта стадии — без неё не видно, что нумерация взята из выделенного диапазона.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, atNode, ctx, claude, decide, ticket, loadSkillRuntime, loadState, SKILL } from './_project.mjs';
import { check } from '../../../../rails/output-check.mjs';

const DEDUP = 'node .workflow/src/skills/decompose-plan/scripts/check-duplicates.js --title "X" --scope "Y"';

const OK = [
  'RAILS: P6S2',
  'verdict = default',
  'Файлы: .workflow/tickets/backlog/IMPL-003.md',
  '---RESULT---',
  'status: default',
  'ids_allocated_from:',
  '  IMPL: 3',
  '---RESULT---',
].join('\n');

function answer(root, text, node = 'P6S2') {
  const { config } = loadSkillRuntime(root, SKILL);
  return check(text, config, loadState(root, atNode(root, node)));
}

test('H4: запись тикета и скрипт дедупликации — только на этапе 10', () => {
  withProject(({ root }) => {
    const work = atNode(root, 'P10S15');
    assert.equal(decide({ action: claude('Write', { file_path: ticket(root, 'backlog', 'IMPL-003.md') }), ctx: ctx(root, work) }).decision, 'allow');
    assert.equal(decide({ action: claude('Bash', { command: DEDUP }), ctx: ctx(root, work) }).decision, 'allow');

    for (const node of ['P0S3', 'P6S1']) {
      const s = atNode(root, node);
      assert.equal(decide({ action: claude('Write', { file_path: ticket(root, 'backlog', 'IMPL-003.md') }), ctx: ctx(root, s) }).decision, 'deny', `запись на ${node}`);
      assert.equal(decide({ action: claude('Bash', { command: DEDUP }), ctx: ctx(root, s) }).decision, 'deny', `дедупликация на ${node}`);
    }
  });
});

test('H6: отчёт с блоком результата и ids_allocated_from — принят', () => {
  withProject(({ root }) => {
    assert.deepEqual(answer(root, OK), { ok: true, missing: [] });
  });
});

test('H6: отчёт без ids_allocated_from — отказ, стоп-гейт нумерации считается пропущенным', () => {
  withProject(({ root }) => {
    const without = OK.split('\n').filter((l) => !l.includes('ids_allocated_from') && !l.includes('IMPL: 3')).join('\n');
    const r = answer(root, without);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.includes('ids_allocated_from')), JSON.stringify(r.missing));
  });
});

test('H6: план, переведённый в active, — отказ', () => {
  withProject(({ root }) => {
    const r = answer(root, `${OK}\nstatus: active`);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('forbidden:')), JSON.stringify(r.missing));
  });
});

test('H6: финальный ответ не в терминале — отказ по положению', () => {
  withProject(({ root }) => {
    const r = answer(root, OK, 'P10S15');
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => m.startsWith('position:')), JSON.stringify(r.missing));
  });
});
