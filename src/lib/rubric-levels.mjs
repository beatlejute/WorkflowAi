/**
 * Шкала рубрики теста скила → пять текстов уровней по возрастанию.
 *
 * Нужна судье, который оценивает выбором уровня, а не текстом: модель решений
 * (протокол `decisions`) получает `criteria` — тексты уровней 1..5
 * (src/scripts/decisions-judge.js). Тот же разбор нужен стадии ревью, поэтому
 * модуль — в src/lib.
 *
 * Строка уровня — строка таблицы `| 4 | текст |` или `| **4** | текст |`.
 * Заголовок над таблицей не важен: рубрики канона встречаются под «## Шкала оценки»,
 * под «## Шкала» и вовсе без заголовка, иногда без таблицы (уровни списком под
 * «## Проходной балл»). Рубрика без таблицы даёт ошибку, и оценку даёт судья эскалации.
 *
 * Уровень берётся из первой подходящей строки, пустой текст пропускается, обрамляющие
 * `|` снимаются, жирное выделение `**` внутри текста тоже снимается. Меняешь разбор —
 * перемеряешь согласие (src/scripts/compare-judges.js).
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
