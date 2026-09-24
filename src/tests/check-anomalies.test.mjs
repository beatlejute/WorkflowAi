/**
 * Поиск аномалий на доске (src/scripts/check-anomalies.js): тикет лежит в in-progress/,
 * но раздел результата у него заполнен — значит работа сделана, а тикет не переехал.
 * До этого файла скрипт не имел ни одного теста: покрытие 0% (база храповика, коммит
 * 1156f42).
 *
 * Главное здесь — распознавание «заполненного» результата, и оба промаха стоят дорого:
 *  - пустой шаблон, посчитанный заполненным, объявляет аномалией каждый тикет в работе,
 *    и сигнал перестают читать;
 *  - заполненный результат, посчитанный пустым, оставляет доделанный тикет в in-progress
 *    навсегда — пайплайн его не подберёт и не закроет.
 * Поэтому проверяются: отсутствие раздела, раздел без подраздела Summary, подраздел из
 * одних HTML-комментариев (ровно то, что стоит в шаблоне тикета), заполненный подраздел,
 * оба написания раздела (русское и английское) и граница следующей секции.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/check-anomalies.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Каталог in-progress вычисляется от корня проекта при импорте — импорт из временного
// проекта, cwd возвращается назад (приём из check-plan-templates.test.mjs).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anomalies-'));
const IN_PROGRESS = path.join(ROOT, '.workflow', 'tickets', 'in-progress');
fs.mkdirSync(IN_PROGRESS, { recursive: true });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const cwdBefore = process.cwd();
process.chdir(ROOT);
const { hasFilledResult, checkAnomalies } = await import('../scripts/check-anomalies.js');
process.chdir(cwdBefore);

const EMPTY_TEMPLATE = [
  '# Тикет',
  '',
  '## Результат выполнения',
  '',
  '### Summary',
  '',
  '<!-- Кратко: что сделано -->',
  '',
  '### Файлы',
  '',
  '<!-- список файлов -->',
  '',
].join('\n');

const FILLED = [
  '# Тикет',
  '',
  '## Результат выполнения',
  '',
  '### Summary',
  '',
  'Добавлен разбор конфига и тест на него.',
  '',
  '### Файлы',
  '',
  '- src/lib/config.mjs',
  '',
].join('\n');

function put(id, body, { title = 'Задача' } = {}) {
  const text = ['---', `id: "${id}"`, `title: "${title}"`, 'status: in-progress', 'parent_plan: "PLAN-001"', '---', '', body].join('\n');
  fs.writeFileSync(path.join(IN_PROGRESS, `${id}.md`), text, 'utf8');
}

function clear() {
  for (const name of fs.readdirSync(IN_PROGRESS)) fs.unlinkSync(path.join(IN_PROGRESS, name));
}

test('hasFilledResult: раздела результата нет — не аномалия', () => {
  assert.equal(hasFilledResult('# Тикет\n\n## Задача\n\nСделать.\n'), false);
});

test('hasFilledResult: раздел есть, подраздела Summary нет — не аномалия', () => {
  assert.equal(hasFilledResult('# Тикет\n\n## Результат выполнения\n\n### Файлы\n\n- a.mjs\n'), false);
});

test('hasFilledResult: пустой шаблон с комментариями — не аномалия', () => {
  assert.equal(hasFilledResult(EMPTY_TEMPLATE), false);
});

test('hasFilledResult: заполненный Summary — аномалия', () => {
  assert.equal(hasFilledResult(FILLED), true);
});

test('hasFilledResult: английские заголовки Result и Summary распознаются', () => {
  const body = '# Ticket\n\n## Result\n\n### Summary\n\nDone.\n';
  assert.equal(hasFilledResult(body), true);
});

test('hasFilledResult: текст из следующей секции за заполненный Summary не считается', () => {
  const body = [
    '# Тикет',
    '',
    '## Результат выполнения',
    '',
    '### Summary',
    '',
    '<!-- Кратко: что сделано -->',
    '',
    '## Ревью',
    '',
    'Замечаний нет.',
    '',
  ].join('\n');
  assert.equal(hasFilledResult(body), false);
});

test('checkAnomalies: пустая колонка — ok без аномалий', async () => {
  clear();
  const result = await checkAnomalies();
  assert.equal(result.status, 'ok');
  assert.equal(result.anomalies_count, 0);
  assert.deepEqual(result.anomalies, []);
});

test('checkAnomalies: тикет с заполненным результатом попадает в аномалии с id и title', async () => {
  clear();
  put('IMPL-001', FILLED, { title: 'Разбор конфига' });
  put('IMPL-002', EMPTY_TEMPLATE);

  const result = await checkAnomalies();

  assert.equal(result.status, 'anomalies_found');
  assert.equal(result.anomalies_count, 1);
  assert.equal(result.anomalies[0].id, 'IMPL-001');
  assert.equal(result.anomalies[0].title, 'Разбор конфига');
  assert.match(result.anomalies[0].recommendation, /переместите в done\/ или review\//);
});

test('checkAnomalies: .gitkeep.md и не-md файлы не считаются тикетами', async () => {
  clear();
  fs.writeFileSync(path.join(IN_PROGRESS, '.gitkeep.md'), '', 'utf8');
  fs.writeFileSync(path.join(IN_PROGRESS, 'notes.txt'), 'не тикет\n', 'utf8');

  const result = await checkAnomalies();

  assert.equal(result.status, 'ok');
  assert.equal(result.anomalies_count, 0);
  clear();
});
