import YAML from 'js-yaml';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Парсит YAML frontmatter из markdown-файла.
 *
 * @param {string} content - Содержимое markdown-файла
 * @returns {{ frontmatter: object, body: string }} Объект с frontmatter и телом документа
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterStr = match[1];
  const body = match[2];

  try {
    const frontmatter = YAML.load(frontmatterStr);
    return { frontmatter, body };
  } catch (e) {
    throw new Error(`Failed to parse frontmatter: ${e.message}`);
  }
}

/**
 * Сериализует объект frontmatter обратно в YAML-строку.
 *
 * @param {object} frontmatter - Объект frontmatter
 * @returns {string} YAML-строка с обрамлением ---
 */
export function serializeFrontmatter(frontmatter) {
  const yamlStr = YAML.dump(frontmatter, {
    lineWidth: -1, // Не переносить длинные строки
    quotingType: '"',
    forceQuotes: false
  });
  return `---\n${yamlStr}---\n`;
}

/**
 * Форматирует и выводит объект результата в stdout.
 *
 * @param {object} result - Объект результата для вывода
 */
export function printResult(result) {
  console.log('---RESULT---');
  for (const [key, value] of Object.entries(result)) {
    console.log(`${key}: ${value}`);
  }
  console.log('---RESULT---');
}

/**
 * Нормализует входное значение в формат PLAN-NNN.
 * Принимает: "PLAN-007", "7", "007", "plan-7", "plans/PLAN-007.md", "/abs/path/PLAN-007.md"
 *
 * @param {string} raw - Входное значение
 * @returns {string|null} Нормализованный ID плана или null
 */
export function normalizePlanId(raw) {
  if (!raw) return null;

  const basename = path.basename(raw, '.md');

  const full = basename.match(/^plan-(\d+)$/i);
  if (full) return `PLAN-${String(parseInt(full[1], 10)).padStart(3, '0')}`;

  const num = raw.trim().match(/^(\d+)$/);
  if (num) return `PLAN-${String(parseInt(num[1], 10)).padStart(3, '0')}`;

  return null;
}

/**
 * Извлекает plan_id из аргументов командной строки (контекст пайплайна).
 *
 * @returns {string|null} Нормализованный plan_id или null
 */
export function extractPlanId() {
  const prompt = process.argv.slice(2)[0] || '';
  const match = prompt.match(/plan_id:\s*(\S+)/i);
  return match ? normalizePlanId(match[1]) : null;
}

/**
 * Возвращает абсолютный путь к корню npm-пакета через import.meta.url.
 *
 * @returns {string} Абсолютный путь к корню пакета
 */
export function getPackageRoot() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // result/src/lib → result
  return path.resolve(__dirname, '../../');
}

/**
 * Парсит секцию "## Ревью" тикета и возвращает статус последней записи.
 * Поддерживает табличный и текстовый форматы.
 *
 * Табличный формат:
 * | Дата | Статус | Комментарий |
 * |------|--------|-------------|
 * | 2026-03-08 | passed | Всё ок |
 *
 * Текстовый формат:
 * - 2026-03-08: passed - Всё ок
 * - 2026-03-08: failed - Есть замечания
 *
 * @param {string} content - Содержимое тикета (markdown)
 * @returns {string|null} "passed", "failed" или null (если нет ревью)
 */
export function getLastReviewStatus(content) {
  if (!content) return null;

  // Находим секцию "## Ревью" — захватываем всё до следующего заголовка ## или конца файла
  const headerIdx = content.search(/^##\s*Ревью\s*$/m);
  if (headerIdx === -1) return null;

  const bodyStart = content.indexOf('\n', headerIdx);
  if (bodyStart === -1) return null;

  const nextH2 = content.indexOf('\n## ', bodyStart);
  const reviewSection = (nextH2 === -1
    ? content.slice(bodyStart + 1)
    : content.slice(bodyStart + 1, nextH2)).trim();
  if (!reviewSection) return null;

  // Пробуем распарсить табличный формат
  const tableRows = reviewSection.split('\n').filter(line => line.trim().startsWith('|'));
  if (tableRows.length >= 2) {
    // Есть заголовок и разделитель, ищем строки с данными
    const dataRows = tableRows.slice(2).filter(row => {
      const cells = row.split('|').map(c => c.trim()).filter(c => c);
      return cells.length >= 2;
    });

    if (dataRows.length > 0) {
      // Последняя строка таблицы = самое свежее ревью (записи ведутся хронологически сверху вниз)
      const latestRow = dataRows[dataRows.length - 1];
      const cells = latestRow.split('|').map(c => c.trim()).filter(c => c);
      const statusRaw = cells[1]?.toLowerCase() || '';
      if (statusRaw.includes('passed')) return 'passed';
      if (statusRaw.includes('failed')) return 'failed';
      if (statusRaw.includes('skipped')) return 'skipped';
    }
  }

  // Пробуем распарсить текстовый формат (список)
  const listItems = reviewSection.split('\n').filter(line => line.trim().match(/^[-*]\s/));
  if (listItems.length > 0) {
    // Последний элемент списка = самое свежее ревью (записи ведутся хронологически)
    const latestItem = listItems[listItems.length - 1].trim();
    const statusMatch = latestItem.match(/:\s*(passed|failed)\b/i);
    if (statusMatch) return statusMatch[1].toLowerCase();
  }

  return null;
}
