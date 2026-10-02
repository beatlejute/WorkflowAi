/**
 * Метрики плана для analyze-report (src/skills/analyze-report/scripts/calc-plan-metrics.js)
 * и общие для него и create-report функции разбора записанных дефектов.
 *
 * Разборы 2026-09-29…30 давали First-Pass 100% и «дефектов нет» при 23 строках ❌ «## Ревью»
 * у 12 из 36 тикетов PulseProxy PLAN-020: прежний подсчёт искал слово «повторная» в поле
 * notes frontmatter, которого у тикетов нет (аудит 2026-09-21, находка 8), а тикеты из
 * review/ в план не входили (находка 9). Что охраняется:
 *  - parseReviewRows: строки таблицы «## Ревью» по порядку, колонка статуса по заголовку,
 *    отметка «✅ выполнено человеком» — не попытка, CRLF, прежний формат списком, раздел —
 *    до следующего «## », «### » внутри его не обрывает;
 *  - calcReviewMetrics: попытка — строка passed или failed, первая попытка — первая такая
 *    строка, знаменатель долей — reviewed; Самари строки ❌ обрезается до 160 символов;
 *  - isAbsenceRecord и extractRecordedDefects — у обоих скриптов (calc-plan-metrics.js и
 *    create-report/scripts/calc-metrics.js): запись только об отсутствии дефектов —
 *    не дефект, запись с предметом — дефект; подраздел ищется в секции результата;
 *  - calcRecordedDefects: только выполненные тикеты (done, archive, review), без подраздела —
 *    defects_section_missing, текст длиннее 600 символов обрезается с text_clipped;
 *  - formatResult и fitResult: валидный JSON, массивы строкой на элемент, при выводе больше
 *    бюджета тексты укорачиваются (texts_shortened), ID и числа остаются;
 *  - calcTimeAnomalies и запуск CLI во временном проекте: completed_at раньше created_at —
 *    в time_anomalies, не в среднем; тикет review/ — в total и distribution, не в completion.
 *
 * Функции импортируются без запуска main (main — только при прямом вызове скрипта).
 * Временный проект — в каталоге ОС, удаляется в after.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/calc-plan-metrics.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as planMetrics from '../skills/analyze-report/scripts/calc-plan-metrics.js';
import * as reportMetrics from '../skills/create-report/scripts/calc-metrics.js';

const {
  parseReviewRows,
  calcReviewMetrics,
  extractRecordedDefects,
  calcRecordedDefects,
  formatResult,
  fitResult,
  calcTimeAnomalies,
} = planMetrics;

const SCRIPT = fileURLToPath(new URL('../skills/analyze-report/scripts/calc-plan-metrics.js', import.meta.url));

const reviewTable = (...rows) => [
  '## Ревью',
  '',
  '| Дата | Статус | Самари | Агент |',
  '|------|--------|--------|-------|',
  ...rows.map(([date, status, summary = 'самари']) => `| ${date} | ${status} | ${summary} | opus |`),
  '',
].join('\n');

const statuses = (body) => parseReviewRows(body).map((r) => r.status);

// ---------------------------------------------------------------------------
// parseReviewRows
// ---------------------------------------------------------------------------

describe('parseReviewRows', () => {
  test('таблица «Ревью»: ❌ failed, ⏭️ skipped, ✅ passed по порядку; «✅ выполнено человеком» пропускается', () => {
    const body = reviewTable(
      ['2026-09-29 10:00', '❌ failed', 'нет теста'],
      ['2026-09-29 11:00', '⏭️ skipped'],
      ['2026-09-29 12:00', '✅ выполнено человеком'],
      ['2026-09-29 13:00', '✅ passed', 'ок'],
    );
    assert.deepEqual(parseReviewRows(body), [
      { date: '2026-09-29 10:00', status: 'failed', summary: 'нет теста' },
      { date: '2026-09-29 11:00', status: 'skipped', summary: 'самари' },
      { date: '2026-09-29 13:00', status: 'passed', summary: 'ок' },
    ]);
  });

  test('тело с CRLF разбирается так же', () => {
    const body = reviewTable(['d1', '❌ failed'], ['d2', '✅ passed']).replace(/\n/g, '\r\n');
    assert.deepEqual(statuses(body), ['failed', 'passed']);
  });

  test('колонка статуса не вторая — ищется по заголовку, вердикт в другой колонке не читается', () => {
    const body = [
      '## Ревью',
      '',
      '| Дата | Агент | Самари | Статус |',
      '|---|---|---|---|',
      '| d1 | passed-bot | нет теста | ❌ failed |',
      '| d2 | failed-bot | ок | ✅ passed |',
    ].join('\n');
    assert.deepEqual(parseReviewRows(body), [
      { date: 'd1', status: 'failed', summary: 'нет теста' },
      { date: 'd2', status: 'passed', summary: 'ок' },
    ]);
  });

  test('прежний формат списком', () => {
    const body = '## Ревью\n\n- 2026-01-01: failed — нет теста\n- 2026-01-02: passed\n';
    assert.deepEqual(parseReviewRows(body).map((r) => [r.date, r.status]), [['2026-01-01', 'failed'], ['2026-01-02', 'passed']]);
  });

  test('раздел кончается на следующем «## », «### » внутри его не обрывает', () => {
    const body = [
      '## Ревью',
      '',
      '### Попытка 1',
      '',
      '| Дата | Статус | Самари |',
      '|---|---|---|',
      '| d1 | ❌ failed | s1 |',
      '',
      '### Попытка 2',
      '',
      '| d2 | ✅ passed | s2 |',
      '',
      '## История работы',
      '',
      '| Дата/время | Скил | Агент | Статус |',
      '|---|---|---|---|',
      '| d3 | review-result | x | failed |',
    ].join('\n');
    assert.deepEqual(statuses(body), ['failed', 'passed']);
  });
});

// ---------------------------------------------------------------------------
// calcReviewMetrics
// ---------------------------------------------------------------------------

describe('calcReviewMetrics', () => {
  const reworked = { id: 'IMPL-1', status: 'done', body: reviewTable(['d1', '❌ failed'], ['d2', '❌ failed'], ['d3', '❌ failed'], ['d4', '✅ passed']) };
  const firstPass = { id: 'IMPL-2', status: 'done', body: reviewTable(['d1', '✅ passed']) };
  const skippedOnly = { id: 'IMPL-3', status: 'done', body: reviewTable(['d1', '⏭️ skipped']) };
  const noSection = { id: 'IMPL-4', status: 'done', body: '## Описание\n\nтекст\n' };

  test('три ❌ и затем ✅ — reviewed 1, первая попытка не пройдена, три возврата', () => {
    const m = calcReviewMetrics([reworked]);
    assert.equal(m.reviewed, 1);
    assert.equal(m.passed_first, 0);
    assert.equal(m.first_pass_rate, 0);
    assert.equal(m.rework_count, 1);
    assert.equal(m.rework_rate, 100);
    assert.equal(m.failed_reviews_total, 3);
    assert.equal(m.reworked_tickets[0].id, 'IMPL-1');
    assert.equal(m.reworked_tickets[0].failed, 3);
  });

  test('только ✅ — passed_first; только skipped и без раздела в reviewed не входят', () => {
    const m = calcReviewMetrics([firstPass, skippedOnly, noSection]);
    assert.equal(m.reviewed, 1);
    assert.equal(m.passed_first, 1);
    assert.equal(m.first_pass_rate, 100);
    assert.equal(m.rework_rate, 0);
    assert.deepEqual(m.reworked_tickets, []);
    assert.equal(calcReviewMetrics([reworked, skippedOnly, noSection]).reviewed, 1);
  });

  test('ни одного ревью — first_pass_rate и rework_rate null', () => {
    const m = calcReviewMetrics([skippedOnly, noSection]);
    assert.equal(m.reviewed, 0);
    assert.equal(m.first_pass_rate, null);
    assert.equal(m.rework_rate, null);
  });

  test('Самари строки ❌ длиннее 160 символов обрезается с « …»', () => {
    const long = 'я'.repeat(170);
    const m = calcReviewMetrics([{ id: 'IMPL-5', status: 'done', body: reviewTable(['d1', '❌ failed', long]) }]);
    assert.equal(m.reworked_tickets[0].rows[0].summary, `${'я'.repeat(160)} …`);
  });
});

// ---------------------------------------------------------------------------
// isAbsenceRecord и extractRecordedDefects — оба скрипта
// ---------------------------------------------------------------------------

const SCRIPTS = [['calc-plan-metrics.js', planMetrics], ['calc-metrics.js', reportMetrics]];

describe('isAbsenceRecord и extractRecordedDefects — calc-plan-metrics.js и calc-metrics.js', () => {
  const ABSENT = [
    'нет', '- нет.', 'Нет', 'Дефектов не обнаружено.', '**Дефектов не обнаружено.**', 'Дефекты отсутствуют',
    'Новых дефектов не выявлено', '_Не найдено_', 'Найденных дефектов нет', 'none',
  ];
  const PRESENT = [
    '', 'Дефект: кнопка не работает', 'не найдено поле X', 'Обнаружен дефект', '- подсказка не совпадает',
    // Запись с предметом разбирает узел разбора, а не скрипт (PulseProxy QA-004).
    'Дефектов не обнаружено.\n\n**Задокументированные поведения:**\n- подсказка появляется через 2 с',
  ];

  for (const [name, mod] of SCRIPTS) {
    test(`${name}: isAbsenceRecord — только отсутствие дефектов, запись с предметом — нет`, () => {
      for (const text of ABSENT) assert.equal(mod.isAbsenceRecord(text), true, JSON.stringify(text));
      for (const text of PRESENT) assert.equal(mod.isAbsenceRecord(text), false, JSON.stringify(text));
    });

    test(`${name}: extractRecordedDefects — подраздел секции результата`, () => {
      const inDescription = '## Описание\n\n### Найденные дефекты\n\nкнопка не работает\n\n## Результат выполнения\n\n### Что сделано\n\nсделано\n';
      assert.deepEqual(mod.extractRecordedDefects(inDescription), { hasSection: false, text: null });

      const noResult = '## Описание\n\nтекст\n\n### Найденные дефекты\n\nподсказка не совпадает\n';
      assert.deepEqual(mod.extractRecordedDefects(noResult), { hasSection: true, text: 'подсказка не совпадает' });

      const attempts = [
        '## Результат выполнения (Attempt 2 — 2026-09-30)',
        '', '### Найденные дефекты', '', 'дефект первой секции', '',
        '## Result', '', '### Найденные дефекты', '', 'дефект второй секции', '',
      ].join('\n');
      const both = mod.extractRecordedDefects(attempts);
      assert.equal(both.hasSection, true);
      assert.match(both.text, /дефект первой секции[\s\S]*дефект второй секции/);

      const tail = '## Результат выполнения\n\n### Найденные дефекты (расхождения с ожиданием)\n\nрасхождение в подписи\n';
      assert.deepEqual(mod.extractRecordedDefects(tail), { hasSection: true, text: 'расхождение в подписи' });

      const commentOnly = '## Результат выполнения\n\n### Найденные дефекты\n\n<!-- «нет» или список расхождений -->\n\n### Заметки\n\nx\n';
      assert.deepEqual(mod.extractRecordedDefects(commentOnly), { hasSection: false, text: null });

      const absent = '## Результат выполнения\n\n### Найденные дефекты\n\n**Дефектов не обнаружено.**\n';
      assert.deepEqual(mod.extractRecordedDefects(absent), { hasSection: true, text: null });
    });
  }

  test('текст длиннее 600 символов: calc-metrics.js обрезает уже в extractRecordedDefects, calc-plan-metrics.js — в calcRecordedDefects', () => {
    const body = `## Результат выполнения\n\n### Найденные дефекты\n\n${'д'.repeat(700)}\n`;
    assert.equal(reportMetrics.extractRecordedDefects(body).text, `${'д'.repeat(600)} …`);
    assert.equal(planMetrics.extractRecordedDefects(body).text, 'д'.repeat(700));
  });
});

// ---------------------------------------------------------------------------
// calcRecordedDefects
// ---------------------------------------------------------------------------

describe('calcRecordedDefects', () => {
  const withDefect = (text) => `## Результат выполнения\n\n### Найденные дефекты\n\n${text}\n`;

  test('в recorded_defects — только выполненные тикеты (done, archive, review); без подраздела — defects_section_missing', () => {
    const tickets = [
      { id: 'QA-1', type: 'qa', status: 'done', completed_at: '2026-09-30', body: withDefect('кнопка не работает') },
      { id: 'QA-2', type: 'qa', status: 'archive', completed_at: null, body: withDefect('подпись съехала') },
      { id: 'QA-3', type: 'qa', status: 'review', completed_at: null, body: withDefect('ссылка битая') },
      { id: 'QA-4', type: 'qa', status: 'ready', completed_at: null, body: withDefect('ещё не выполнен') },
      { id: 'QA-5', type: 'qa', status: 'done', completed_at: null, body: '## Результат выполнения\n\n### Что сделано\n\nx\n' },
      { id: 'QA-6', type: 'qa', status: 'done', completed_at: null, body: withDefect('нет') },
    ];
    const { recorded_defects: recorded, defects_section_missing: missing } = calcRecordedDefects(tickets);
    assert.deepEqual(recorded.map((d) => d.id), ['QA-1', 'QA-2', 'QA-3']);
    assert.deepEqual(recorded[0], { id: 'QA-1', type: 'qa', status: 'done', completed_at: '2026-09-30', text: 'кнопка не работает' });
    assert.deepEqual(missing, [{ id: 'QA-5', type: 'qa', status: 'done' }]);
  });

  test('текст длиннее 600 символов — 600 символов и « …», text_clipped; короче — без text_clipped', () => {
    const { recorded_defects: [long, short] } = calcRecordedDefects([
      { id: 'QA-7', type: 'qa', status: 'done', body: withDefect('д'.repeat(601)) },
      { id: 'QA-8', type: 'qa', status: 'done', body: withDefect('д'.repeat(600)) },
    ]);
    assert.equal(long.text, `${'д'.repeat(600)} …`);
    assert.equal(long.text_clipped, true);
    assert.equal(short.text, 'д'.repeat(600));
    assert.equal('text_clipped' in short, false);
  });
});

// ---------------------------------------------------------------------------
// formatResult и fitResult
// ---------------------------------------------------------------------------

describe('formatResult и fitResult', () => {
  const small = {
    plan_id: 'PLAN-001',
    total_tickets: 3,
    distribution: { done: 2, review: 1 },
    time_anomalies: [{ id: 'IMPL-1', created_at: '2026-09-30T00:00:00Z', completed_at: '2026-09-29T00:00:00Z' }],
    reworked_tickets: [{ id: 'IMPL-2', status: 'done', failed: 1, rows: [{ date: 'd1', summary: 'нет теста' }] }],
    recorded_defects: [],
    defects_section_missing: [{ id: 'QA-1', type: 'qa', status: 'done' }, { id: 'QA-2', type: 'qa', status: 'review' }],
  };

  test('валидный JSON, равный объекту; массивы — по строке на элемент, пустой — []', () => {
    const out = formatResult(small);
    assert.deepEqual(JSON.parse(out), small);
    for (const key of ['time_anomalies', 'reworked_tickets', 'defects_section_missing']) {
      for (const row of small[key]) assert.ok(out.includes(`\n    ${JSON.stringify(row)}`), `${key}: ${JSON.stringify(row)}`);
    }
    assert.match(out, /"recorded_defects": \[\]/);
  });

  test('вывод в пределах бюджета — без texts_shortened', () => {
    const out = fitResult(small);
    assert.equal(out, formatResult(small));
    assert.equal(JSON.parse(out).texts_shortened, undefined);
  });

  test('200 вернувшихся тикетов с Самари по 160 символов при бюджете 24000 — тексты укорочены, ID и числа на месте', () => {
    const summary = 'с'.repeat(160);
    const result = {
      plan_id: 'PLAN-002',
      total_tickets: 200,
      reworked_tickets: Array.from({ length: 200 }, (_, i) => ({
        id: `IMPL-${i + 1}`, status: 'done', failed: 2, rows: [{ date: 'd1', summary }, { date: 'd2', summary }],
      })),
      recorded_defects: [{ id: 'QA-9', type: 'qa', status: 'done', completed_at: null, text: 'д'.repeat(600) }],
    };
    assert.ok(formatResult(result).length > planMetrics.OUTPUT_BUDGET_CHARS, 'фикстура больше бюджета');

    const parsed = JSON.parse(fitResult(result, 24000));

    assert.equal(parsed.texts_shortened, true);
    assert.deepEqual(parsed.reworked_tickets.map((t) => [t.id, t.failed, t.rows.length]), result.reworked_tickets.map((t) => [t.id, 2, 2]));
    for (const t of parsed.reworked_tickets) {
      for (const row of t.rows) assert.equal(row.summary, `${'с'.repeat(60)} …`);
    }
    assert.equal(parsed.recorded_defects[0].id, 'QA-9');
    assert.equal(parsed.recorded_defects[0].text, `${'д'.repeat(200)} …`);
    assert.equal(parsed.recorded_defects[0].text_clipped, true);
    assert.equal(parsed.total_tickets, 200);
  });
});

// ---------------------------------------------------------------------------
// calcTimeAnomalies и запуск во временном проекте
// ---------------------------------------------------------------------------

describe('calcTimeAnomalies и каталоги доски', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-plan-metrics-'));
    for (const dir of ['tickets/done', 'tickets/review', 'plans/current']) {
      fs.mkdirSync(path.join(root, '.workflow', ...dir.split('/')), { recursive: true });
    }
    fs.writeFileSync(path.join(root, '.workflow', 'plans', 'current', 'PLAN-001.md'),
      '---\nid: "PLAN-001"\ntitle: "План"\nstatus: active\n---\n', 'utf8');
    const put = (dir, id, frontmatter, body = '') => fs.writeFileSync(
      path.join(root, '.workflow', 'tickets', dir, `${id}.md`),
      ['---', `id: ${id}`, 'type: impl', 'parent_plan: "plans/current/PLAN-001.md"', ...frontmatter, '---', '', body].join('\n'),
      'utf8'
    );
    put('done', 'IMPL-001', ['created_at: "2026-09-28T00:00:00Z"', 'completed_at: "2026-09-29T00:00:00Z"'],
      `${reviewTable(['d1', '❌ failed', 'нет теста'], ['d2', '✅ passed'])}\n## Результат выполнения\n\n### Найденные дефекты\n\nкнопка не работает\n`);
    // completed_at раньше created_at: строкой и датой YAML без кавычек.
    put('done', 'IMPL-002', ['created_at: "2026-09-30T00:00:00Z"', 'completed_at: "2026-09-29T12:00:00Z"']);
    put('done', 'IMPL-003', ['created_at: 2026-09-30T00:00:00Z', 'completed_at: 2026-09-29T18:00:00Z']);
    put('review', 'IMPL-004', ['created_at: "2026-09-28T00:00:00Z"'], reviewTable(['d1', '✅ passed']));
    // Тикет другого плана в счёт не входит.
    fs.writeFileSync(path.join(root, '.workflow', 'tickets', 'done', 'IMPL-900.md'),
      '---\nid: IMPL-900\nparent_plan: "plans/current/PLAN-002.md"\n---\n', 'utf8');
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('calcTimeAnomalies: completed_at раньше created_at (Date из YAML и строка) у done и archive', () => {
    const anomalies = calcTimeAnomalies([
      { id: 'A', status: 'done', created_at: new Date('2026-09-30T00:00:00Z'), completed_at: new Date('2026-09-29T00:00:00Z') },
      { id: 'B', status: 'archive', created_at: '2026-09-30T00:00:00Z', completed_at: '2026-09-29T00:00:00Z' },
      { id: 'C', status: 'done', created_at: '2026-09-28T00:00:00Z', completed_at: '2026-09-29T00:00:00Z' },
      { id: 'D', status: 'review', created_at: '2026-09-30T00:00:00Z', completed_at: '2026-09-29T00:00:00Z' },
      { id: 'E', status: 'done', created_at: null, completed_at: '2026-09-29T00:00:00Z' },
    ]);
    assert.deepEqual(anomalies.map((a) => a.id), ['A', 'B']);
  });

  test('запуск CLI: блок ---RESULT--- с метриками ревью, дефектами и аномалиями времени; review/ — в total, не в completion', () => {
    const run = spawnSync(process.execPath, [SCRIPT, 'PLAN-001'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const block = run.stdout.split('---RESULT---')[1];
    assert.ok(block, run.stdout);
    const result = JSON.parse(block);

    for (const key of ['reviewed', 'first_pass_rate', 'rework_rate', 'reworked_tickets', 'recorded_defects', 'defects_section_missing', 'time_anomalies']) {
      assert.ok(key in result, `нет поля ${key}`);
    }
    assert.equal(result.total_tickets, 4);
    assert.deepEqual(result.distribution, { done: 3, review: 1 });
    assert.equal(result.completion_pct, 75);
    assert.equal(result.avg_time_to_done, 1, 'аномальные тикеты в среднее не входят');
    assert.deepEqual(result.time_anomalies.map((a) => a.id).sort(), ['IMPL-002', 'IMPL-003']);
    assert.equal(result.reviewed, 2);
    assert.equal(result.first_pass_rate, 50);
    assert.deepEqual(result.reworked_tickets.map((t) => t.id), ['IMPL-001']);
    assert.deepEqual(result.recorded_defects.map((d) => [d.id, d.text]), [['IMPL-001', 'кнопка не работает']]);
    assert.deepEqual(result.defects_section_missing.map((d) => d.id).sort(), ['IMPL-002', 'IMPL-003', 'IMPL-004']);
  });

  test('запуск CLI без аргумента — код выхода 1', () => {
    const run = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /не указан ID плана/);
  });
});
