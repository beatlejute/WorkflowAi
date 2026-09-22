// H3: действие только на своём этапе — правка скила (П4, П10, П70), бэклог (П6),
// get-next-test-id и прогон runner (П5, потолок 3). E-узел этапа прозрачен.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { withCoachProject, atNode, ctx, claude, decide } from './_project.mjs';

const RUNNER = 'node .workflow/src/scripts/run-skill-tests.js --skill coach --relevant TC-COACH-005';
const NEXT_ID = 'node .workflow/src/scripts/get-next-test-id.js --skill coach';

test('H3: Edit файла скила на этапе evidence (П1) — отказ, на правке (П4S2) — молчание', () => {
  withCoachProject(({ root, link }) => {
    const file = join(link, 'knowledge', 'rails-concept.md');
    const deny = decide({ action: claude('Edit', { file_path: file }), ctx: ctx(root, atNode(root, 'P1S1')) });
    assert.equal(deny.decision, 'deny');
    assert.match(deny.reason, /этап/);
    const allow = decide({ action: claude('Edit', { file_path: file }), ctx: ctx(root, atNode(root, 'P4S2')) });
    assert.equal(allow.decision, 'allow');
  });
});

test('H3: E-узел этапа прозрачен — Edit скила в P4E1 отказ, пока агент не прошёл в S-узел', () => {
  withCoachProject(({ root, link }) => {
    const r = decide({ action: claude('Edit', { file_path: join(link, 'README.md') }), ctx: ctx(root, atNode(root, 'P4E1')) });
    assert.equal(r.decision, 'deny');
  });
});

test('H3: запись файлов скила разрешена в ветках CREATE (П10S5) и CONVERT (П70S5)', () => {
  withCoachProject(({ root, link }) => {
    for (const node of ['P10S5', 'P70S5']) {
      const r = decide({ action: claude('Write', { file_path: join(link, 'workflows', 'probe.md') }), ctx: ctx(root, atNode(root, node)) });
      assert.equal(r.decision, 'allow', node);
    }
  });
});

test('H3: правка coach-backlog.yaml только на этапе П6', () => {
  withCoachProject(({ root }) => {
    const file = join(root, '.workflow', 'coach-backlog.yaml');
    assert.equal(decide({ action: claude('Edit', { file_path: file }), ctx: ctx(root, atNode(root, 'P6S1')) }).decision, 'allow');
    assert.equal(decide({ action: claude('Edit', { file_path: file }), ctx: ctx(root, atNode(root, 'P4S2')) }).decision, 'deny');
  });
});

test('H3: get-next-test-id только на этапе П5', () => {
  withCoachProject(({ root }) => {
    assert.equal(decide({ action: claude('Bash', { command: NEXT_ID }), ctx: ctx(root, atNode(root, 'P5S1')) }).decision, 'allow');
    assert.equal(decide({ action: claude('Bash', { command: NEXT_ID }), ctx: ctx(root, atNode(root, 'P3S1')) }).decision, 'deny');
  });
});

test('H3/H4: прогон runner на П5S5 — три раза молчание, четвёртый — отказ по потолку; на П4 — отказ', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P5S5');
    for (let i = 1; i <= 3; i += 1) {
      const r = decide({ action: claude('Bash', { command: RUNNER }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'allow', `прогон ${i}`);
    }
    const fourth = decide({ action: claude('Bash', { command: RUNNER }), ctx: ctx(root, s) });
    assert.equal(fourth.decision, 'deny');
    assert.match(fourth.reason, /потол|max_per_session|3/);

    const wrongStage = decide({ action: claude('Bash', { command: RUNNER }), ctx: ctx(root, atNode(root, 'P4S2')) });
    assert.equal(wrongStage.decision, 'deny');
  });
});

test('H3: отказ называет разрешённое — переходы из текущего узла и действия этапа', () => {
  withCoachProject(({ root, link }) => {
    const r = decide({ action: claude('Edit', { file_path: join(link, 'README.md') }), ctx: ctx(root, atNode(root, 'P1S1')) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /Отклонено/);
    assert.match(r.reason, /Почему/);
    assert.match(r.reason, /Доступно/);
    assert.match(r.reason, /P1S2/);
  });
});

// Инцидент 2026-09-22 (проход коуча по графу, P40S2): `sed -n 620,660p src/scripts/run-skill-tests.js`
// отклонён как «run_tests вне этапа 5» — матч ловил любое упоминание имени скрипта, чтение кода
// раннера на этапе разбора было невозможно. Прогон — это запуск через node, а не текст команды.
test('H3: чтение кода runner (sed, grep, cat) — не прогон: молчание вне П5 и потолок не расходуется', () => {
  withCoachProject(({ root }) => {
    const reads = [
      'sed -n 620,660p src/scripts/run-skill-tests.js',
      'grep -n node .workflow/src/scripts/run-skill-tests.js',
      'cat .workflow/src/scripts/run-skill-tests.js | head -20',
    ];
    for (const command of reads) {
      const r = decide({ action: claude('Bash', { command }), ctx: ctx(root, atNode(root, 'P40S2')) });
      assert.equal(r.decision, 'allow', command);
    }
    const s = atNode(root, 'P5S5');
    for (const command of reads) decide({ action: claude('Bash', { command }), ctx: ctx(root, s) });
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(decide({ action: claude('Bash', { command: RUNNER }), ctx: ctx(root, s) }).decision, 'allow', `прогон ${i} после чтений`);
    }
  });
});

test('H3: запуск runner после `cd … &&` — прогон, вне П5 отказ', () => {
  withCoachProject(({ root }) => {
    const r = decide({ action: claude('Bash', { command: `cd "${root}" && ${RUNNER}` }), ctx: ctx(root, atNode(root, 'P4S2')) });
    assert.equal(r.decision, 'deny');
  });
});
