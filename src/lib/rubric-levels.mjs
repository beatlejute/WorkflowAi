/**
 * Шкала рубрики теста скила → пять текстов уровней по возрастанию.
 *
 * Нужна судье, который оценивает выбором уровня, а не текстом: модель решений
 * (протокол `decisions`) получает `criteria` — тексты уровней 1..5
 * (src/scripts/decisions-judge.js). Тот же разбор нужен стадии ревью PLAN-002,
 * поэтому модуль — в src/lib.
 *
 * Строка уровня — строка таблицы `| 4 | текст |` или `| **4** | текст |`.
 * Заголовок над таблицей не важен: подсчёт 2026-09-24 по 42 рубрикам канона —
 * 28 под «## Шкала оценки», 7 под «## Шкала», 5 без заголовка «Шкала», 2 без
 * таблицы (уровни списком под «## Проходной балл»; их 2026-09-26 перевели на
 * таблицу). Рубрика без таблицы даёт ошибку, и оценку даёт судья эскалации.
 *
 * Выражение и правила — из разбора пилота 2026-09-24 (D:\tmp\jev-pilot\jev_parse.py),
 * на нём посчитаны цифры согласия этапа 0 (PLAN-001): уровень берётся из первой
 * подходящей строки, пустой текст пропускается, обрамляющие `|` снимаются. Сверх
 * пилота снимается жирное выделение `**` внутри текста (PLAN-001, задача 9).
 * Меняешь разбор — перемеряешь согласие (src/scripts/compare-judges.js).
 */

export const RUBRIC_LEVEL_LINE = /^\|\s*\*{0,2}([1-5])\*{0,2}\s*\|(.+?)\|?\s*$/;
export const RUBRIC_LEVEL_COUNT = 5;

export class RubricLevelsError extends Error {
  constructor(rubric, message) {
    super(`Rubric ${rubric}: ${message}`);
    this.name = 'RubricLevelsError';
    this.rubric = rubric;
  }
}

function cleanLevelText(raw) {
  return raw.replace(/\*\*/g, '').trim().replace(/^\|+|\|+$/g, '').trim();
}

/**
 * @param {string} text - текст рубрики
 * @param {string} [rubricName] - имя для сообщения об ошибке
 * @returns {string[]} тексты уровней 1..5
 * @throws {RubricLevelsError} нет строки хотя бы для одного из уровней 1..5
 */
export function rubricLevels(text, rubricName = 'rubric') {
  const found = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(RUBRIC_LEVEL_LINE);
    if (!match) continue;
    const level = Number(match[1]);
    const body = cleanLevelText(match[2]);
    if (body && !found.has(level)) found.set(level, body);
  }
  const all = Array.from({ length: RUBRIC_LEVEL_COUNT }, (_, i) => i + 1);
  const missing = all.filter((level) => !found.has(level));
  if (missing.length === RUBRIC_LEVEL_COUNT) {
    throw new RubricLevelsError(rubricName, 'no level table (rows "| 1 | … |" … "| 5 | … |")');
  }
  if (missing.length > 0) {
    throw new RubricLevelsError(rubricName, `no table row for level(s) ${missing.join(', ')} — need all five, 1..5`);
  }
  return all.map((level) => found.get(level));
}
