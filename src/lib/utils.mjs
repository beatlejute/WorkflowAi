import YAML from './js-yaml.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

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

  // Находим последний заголовок H2 "## Ревью" (только строки начинающиеся с "## ")
  const lines = content.split('\n');
  let lastHeaderLineIndex = -1;
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && lines[i].includes('Ревью')) {
      lastHeaderLineIndex = i;
    }
  }

  if (lastHeaderLineIndex === -1) return null;

  // Собираем содержимое после заголовка до следующего H2 заголовка
  const reviewLines = [];
  for (let i = lastHeaderLineIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break; // следующий H2 заголовок
    reviewLines.push(lines[i]);
  }
  
  const reviewSection = reviewLines.join('\n').trim();
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
    const statusMatch = latestItem.match(/:\s*(passed|failed|skipped)\b/i);
    if (statusMatch) return statusMatch[1].toLowerCase();
  }

  return null;
}

/**
 * Загружает конфигурацию правил перемещения тикетов.
 *
 * @param {string} configPath - Путь к конфигурационному файлу
 * @returns {object} Объект конфигурации с правилами
 */
export function loadTicketMovementRules(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const content = fs.readFileSync(configPath, 'utf8');
  return YAML.load(content);
}

/**
 * Проверяет все тикеты плана и закрывает его если все выполнены.
 *
 * @param {string} workflowDir - Путь к директории .workflow/
 * @param {string} planId - Нормализованный ID плана (например "PLAN-002")
 * @returns {{ closed: boolean, reason: string, total: number, done: number }}
 */
export function checkAndClosePlan(workflowDir, planId) {
  if (!workflowDir || !planId) {
    return { closed: false, reason: 'Missing workflowDir or planId', total: 0, done: 0 };
  }

  const ticketsDir = path.join(workflowDir, 'tickets');
  const allDirNames = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done'];
  const allTickets = [];

  for (const dirName of allDirNames) {
    const dir = path.join(ticketsDir, dirName);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        if (normalizePlanId(frontmatter.parent_plan) === planId) {
          allTickets.push({ id: frontmatter.id || file.replace('.md', ''), dir: dirName });
        }
      } catch (_) { /* skip malformed */ }
    }
  }

  const total = allTickets.length;
  const done = allTickets.filter(t => t.dir === 'done').length;

  if (total === 0) {
    return { closed: false, reason: 'No tickets found for plan', total, done };
  }

  if (done < total) {
    return { closed: false, reason: `${done}/${total} tickets done`, total, done };
  }

  const plansDir = path.join(workflowDir, 'plans', 'current');
  if (!fs.existsSync(plansDir)) {
    return { closed: false, reason: 'Plans directory not found', total, done };
  }

  const planFile = fs.readdirSync(plansDir)
    .filter(f => f.endsWith('.md'))
    .find(f => normalizePlanId(f) === planId);

  if (!planFile) {
    return { closed: false, reason: 'Plan file not found', total, done };
  }

  const planPath = path.join(plansDir, planFile);
  const planContent = fs.readFileSync(planPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(planContent);

  if (frontmatter.status === 'completed') {
    return { closed: false, reason: 'Plan already completed', total, done };
  }

  frontmatter.status = 'completed';
  frontmatter.completed_at = new Date().toISOString();
  frontmatter.updated_at = new Date().toISOString();

  fs.writeFileSync(planPath, serializeFrontmatter(frontmatter) + body, 'utf8');

  return { closed: true, reason: 'All tickets done', total, done };
}
