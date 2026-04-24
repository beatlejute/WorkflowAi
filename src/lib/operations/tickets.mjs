import { findProjectRoot } from '../find-root.mjs';
import { parseFrontmatter, serializeFrontmatter, getLastReviewStatus } from '../utils.mjs';
import { existsSync, readdirSync, promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';

// Доступные статусы
const VALID_STATUSES = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "review",
  "done",
  "archive",
];

// Таблица допустимых переходов
const VALID_TRANSITIONS = {
  backlog: ["ready", "blocked", "done"],
  ready: ["in-progress", "review", "backlog"],
  "in-progress": ["done", "blocked", "review"],
  blocked: ["ready"],
  review: ["done", "ready", "in-progress", "blocked"],
  done: ["ready", "blocked", "archive"],
  archive: ["backlog"],
};

/**
 * Форматирует номер с ведущими нулями (1 → 001)
 */
function formatNumber(num) {
  return String(num).padStart(3, '0');
}

/**
 * Находит следующий свободный ID для указанного типа тикетов
 * @param {string} projectRoot - Корень проекта
 * @param {string} type - Тип тикета (например, IMPL, QA)
 * @returns {Promise<string>} Следующий ID в формате TYPE-NNN
 */
export async function getNextId(projectRoot, type) {
  // Если projectRoot не предоставлен, ищем его сами
  const root = projectRoot || findProjectRoot();

  const ticketsDir = join(root, '.workflow', 'tickets');

  // Если директория тикетов не существует, возвращаем первый ID
  if (!existsSync(ticketsDir)) {
    return `${type}-001`;
  }

  // Рекурсивный поиск всех файлов {TYPE}-*.md
  const maxNum = findMaxNumber(ticketsDir, type);
  const nextNum = maxNum + 1;
  return `${type}-${formatNumber(nextNum)}`;
}

/**
 * Рекурсивно ищет максимальный номер для файлов с заданным префиксом
 * @param {string} targetDir - Директория для поиска
 * @param {string} prefix - Префикс файла (например, IMPL)
 * @returns {number} Максимальный найденный номер
 */
function findMaxNumber(targetDir, prefix) {
  let maxNum = 0;
  const regex = new RegExp(`^${prefix}-(\\d+)\\.md$`, "i");

  function scanDirectory(dir) {
    if (!existsSync(dir)) {
      return;
    }

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        scanDirectory(fullPath);
      } else if (entry.isFile()) {
        const match = entry.name.match(regex);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) {
            maxNum = num;
          }
        }
      }
    }
  }

  scanDirectory(targetDir);
  return maxNum;
}

/**
 * Определяет текущий статус тикета по расположению файла
 */
function getStatusFromPath(ticketId, ticketsDir) {
  for (const status of VALID_STATUSES) {
    const statusDir = join(ticketsDir, status);
    const expectedPath = join(statusDir, `${ticketId}.md`);
    if (existsSync(expectedPath)) {
      return status;
    }
  }
  return null;
}

/**
 * Проверяет допустимость перехода и бросает ошибку если недопустим
 */
function assertValidTransition(from, to) {
  if (!VALID_STATUSES.includes(from)) {
    throw { code: 'INVALID_TRANSITION', from, to, id: null };
  }
  if (!VALID_STATUSES.includes(to)) {
    throw { code: 'INVALID_TRANSITION', from, to, id: null };
  }

  const allowedTransitions = VALID_TRANSITIONS[from] || [];
  if (!allowedTransitions.includes(to)) {
    throw { code: 'INVALID_TRANSITION', from, to, id: null };
  }
}

/**
 * Перемещает тикет между колонками канбан-доски
 * @param {string} projectRoot - Корень проекта
 * @param {string} id - ID тикета
 * @param {string} target - Целевой статус
 * @returns {{from: string, to: string, path: string}} Результат перемещения
 */
export async function moveTicket(projectRoot, id, target) {
  const root = projectRoot || findProjectRoot();
  const ticketsDir = join(root, '.workflow', 'tickets');

  // Найти текущий статус тикета
  const from = getStatusFromPath(id, ticketsDir);
  if (!from) {
    throw { code: 'INVALID_TRANSITION', from: null, to: target, id };
  }

  // Проверить допустимость перехода
  assertValidTransition(from, target);

  const sourcePath = join(ticketsDir, from, `${id}.md`);
  const targetDir = join(ticketsDir, target);
  const targetPath = join(targetDir, `${id}.md`);

  // Чтение файла тикета
  let content;
  try {
    content = await fs.readFile(sourcePath, 'utf8');
  } catch (e) {
    throw new Error(`Не удалось прочитать файл: ${e.message}`);
  }

  // Парсинг frontmatter
  let frontmatter, body;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch (e) {
    throw new Error(e.message);
  }

  // Обновление frontmatter
  const now = new Date().toISOString();
  frontmatter.updated_at = now;

  // Если переход в done, добавляем completed_at
  if (target === "done" && from !== "done") {
    frontmatter.completed_at = now;
  }

  // Fallback: если тикет идёт в done из review, но агент не записал секцию "## Ревью" — дописываем
  if (
    target === "done" &&
    from === "review" &&
    getLastReviewStatus(content) === null
  ) {
    const date = now.slice(0, 16).replace("T", " ");
    const reviewSection = `\n## Ревью\n\n| Дата | Статус | Самари |\n|------|--------|--------|\n| ${date} | ✅ passed | Pipeline fallback: агент не записал секцию ревью |\n`;
    body = body.trimEnd() + "\n" + reviewSection;
  }

  // Если переход из blocked, удаляем blocked_reason
  if (from === "blocked" && frontmatter.blocked_reason) {
    delete frontmatter.blocked_reason;
  }

  // Сериализация нового контента
  const newContent = serializeFrontmatter(frontmatter) + body;

  // Создание целевой директории если не существует
  if (!existsSync(targetDir)) {
    await fs.mkdir(targetDir, { recursive: true });
  }

  // Перемещение файла
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (e) {
    throw new Error(`Не удалось переместить файл: ${e.message}`);
  }

  // Запись обновлённого контента
  try {
    await fs.writeFile(targetPath, newContent, 'utf8');
  } catch (e) {
    throw new Error(`Не удалось записать файл: ${e.message}`);
  }

  return { from, to: target, path: targetPath };
}

/**
 * Проверяет одно условие (condition) тикета
 */
function checkCondition(projectRoot, condition) {
  const { type, value } = condition;

  switch (type) {
    case 'file_exists':
      return existsSync(join(projectRoot, value));

    case 'file_not_exists':
      return !existsSync(join(projectRoot, value));

    case 'tasks_completed': {
      if (!value || (Array.isArray(value) && value.length === 0)) return true;
      const ids = Array.isArray(value) ? value : [value];
      const doneDir = join(projectRoot, '.workflow', 'tickets', 'done');
      const archiveDir = join(projectRoot, '.workflow', 'tickets', 'archive');
      return ids.every(taskId =>
        existsSync(join(doneDir, `${taskId}.md`)) ||
        existsSync(join(archiveDir, `${taskId}.md`))
      );
    }

    case 'date_after':
      return new Date() > new Date(value);

    case 'date_before':
      return new Date() < new Date(value);

    case 'manual_approval':
      return false;

    default:
      return true;
  }
}

/**
 * Проверяет зависимости тикета
 */
function checkDependencies(projectRoot, dependencies) {
  if (!dependencies || dependencies.length === 0) return true;
  const doneDir = join(projectRoot, '.workflow', 'tickets', 'done');
  const archiveDir = join(projectRoot, '.workflow', 'tickets', 'archive');
  return dependencies.every(depId =>
    existsSync(join(doneDir, `${depId}.md`)) ||
    existsSync(join(archiveDir, `${depId}.md`))
  );
}

/**
 * Создаёт новый тикет в tickets/backlog/ с автоинкрементированным ID
 * @param {string} projectRoot - Корень проекта
 * @param {object} data - Данные для frontmatter (title, type, priority, tags, context, etc.)
 * @returns {Promise<{id: string, path: string}>} Созданный ID и абсолютный путь
 */
export async function createTicket(projectRoot, data) {
  const root = projectRoot || findProjectRoot();
  const ticketsDir = join(root, '.workflow', 'tickets');
  const backlogDir = join(ticketsDir, 'backlog');

  // 1. Получить следующий ID
  const type = data.type ?? 'impl';
  const id = await getNextId(root, type);

  // 2. Сформировать frontmatter
  const frontmatter = {
    id,
    title: data.title ?? '',
    priority: data.priority ?? 3,
    type: data.type ?? 'impl',
    required_capabilities: data.required_capabilities ?? [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: '',
    parent_plan: data.parent_plan ?? '',
    parent_task: data.parent_task ?? '',
    dependencies: data.dependencies ?? [],
    conditions: data.conditions ?? [],
    context: data.context ?? { files: [], references: [], notes: '' },
    complexity: data.complexity ?? 'medium',
    tags: data.tags ?? []
  };

  // 3. Добавить executor_type если type === 'human'
  if (data.type === 'human') {
    frontmatter.executor_type = 'human';
  }

  // 4. Записать файл в backlog/
  if (!existsSync(backlogDir)) {
    await fs.mkdir(backlogDir, { recursive: true });
  }

  const path = join(backlogDir, `${id}.md`);
  const content = serializeFrontmatter(frontmatter) + '\n## Описание\n\n\n## Критерии готовности (Definition of Done)\n\n- [ ] \n';

  try {
    await fs.writeFile(path, content, 'utf8');
  } catch (e) {
    throw new Error(`Не удалось записать файл: ${e.message}`);
  }

  return { id, path };
}

/**
 * Выбирает следующий доступный тикет из директории ready/
 * @param {string} projectRoot - Корень проекта
 * @returns {Promise<object>} {ticket} если найден, или {empty: true, reason}
 */
export async function pickNext(projectRoot) {
  const root = projectRoot || findProjectRoot();
  const readyDir = join(root, '.workflow', 'tickets', 'ready');

  // 1. Проверка пустой ready/
  if (!existsSync(readyDir)) {
    return { empty: true, reason: 'no_ready_tickets' };
  }

  const files = readdirSync(readyDir).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');
  if (files.length === 0) {
    return { empty: true, reason: 'no_ready_tickets' };
  }

  const tickets = [];

  // 2. Чтение и парсинг тикетов
  for (const file of files) {
    const filePath = join(readyDir, file);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      tickets.push({
        id: frontmatter.id || file.replace('.md', ''),
        frontmatter,
        path: filePath
      });
    } catch (e) {
      // Пропускаем битые файлы
    }
  }

  // 3. Фильтрация по условиям и зависимостям
  const eligibleTickets = tickets.filter(ticket => {
    const { frontmatter, id, path: filePath } = ticket;

    // Пропускаем human-тики
    if (frontmatter.type === 'human') return false;

    // Проверка зависимостей
    const depsMet = checkDependencies(root, frontmatter.dependencies || []);
    if (!depsMet) return false;

    // Проверка условий
    const conditions = frontmatter.conditions || [];
    const conditionsMet = conditions.every(c => checkCondition(root, c));
    if (!conditionsMet) return false;

    // Проверка на дубликаты (тикет не должен быть в in-progress, review, done и т.д.)
    const otherDirs = ['done', 'in-progress', 'review', 'blocked'].map(d =>
      join(root, '.workflow', 'tickets', d)
    );
    const duplicate = otherDirs.some(dir =>
      existsSync(join(dir, `${id}.md`))
    );
    if (duplicate) return false;

    return true;
  });

  if (eligibleTickets.length === 0) {
    return { empty: true, reason: 'no_eligible_tickets' };
  }

  // 4. Сортировка: приоритет (меньше = важнее), затем created_at (старые первые)
  eligibleTickets.sort((a, b) => {
    const priorityA = a.frontmatter.priority || 999;
    const priorityB = b.frontmatter.priority || 999;
    if (priorityA !== priorityB) return priorityA - priorityB;

    const dateA = new Date(a.frontmatter.created_at || '9999-12-31');
    const dateB = new Date(b.frontmatter.created_at || '9999-12-31');
    return dateA - dateB;
  });

  // 5. Возврат первого подходящего
  const selected = eligibleTickets[0];
  return {
    ticket: {
      id: selected.id,
      ...selected.frontmatter,
      path: selected.path
    }
  };
}