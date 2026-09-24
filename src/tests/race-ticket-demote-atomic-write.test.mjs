/**
 * Тикет, которого проверка условий возвращает из ready/ в backlog/, обязан быть виден
 * читателю целиком: сначала переезд, потом публикация содержимого заменой. Пустого и
 * обрезанного промежутка быть не должно.
 *
 * Инцидент того же класса, что маркер запущенного пайплайна, approval-файл ручного гейта
 * и авто-блокировка тикета (все 2026-09-24): содержимое клалось поверх только что
 * переехавшего файла одним writeFileSync. writeFileSync — это open(файл, 'w') плюс
 * запись вторым шагом: усечение сразу, содержимое позже.
 *
 * Цена названа в самом скрипте: следующий же readTickets в этом прогоне читает backlog/
 * и в это окно получает тикет с пустым frontmatter — то есть без зависимостей и условий,
 * из-за которых тикет сюда и отправили. Такой тикет тут же снова считается готовым.
 *
 * Стенных часов в тесте нет: наблюдатель подменяет методы fs и снимает состояние тикета
 * глазами читателя после каждой мутации каталога.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/race-ticket-demote-atomic-write.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { watchFsMutations, inspectMarkdownArtifact, listRaw } from './_atomic-publish-observer.mjs';

// Скрипт вычисляет каталоги доски от корня проекта при импорте, поэтому импорт идёт из
// временного проекта, а cwd возвращается назад (тот же приём, что в check-plan-templates.test.mjs).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'demote-atomic-'));
const READY_DIR = path.join(ROOT, '.workflow', 'tickets', 'ready');
const BACKLOG_DIR = path.join(ROOT, '.workflow', 'tickets', 'backlog');
fs.mkdirSync(READY_DIR, { recursive: true });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const cwdBefore = process.cwd();
process.chdir(ROOT);
const { demoteToBacklog } = await import('../scripts/check-conditions.js');
process.chdir(cwdBefore);

const BODY_TAIL = '## Зависимости\n\nЖдёт соседнюю задачу.\n';
const BODY = `# Тикет\n\n${'Описание работы и критерии приёмки.\n'.repeat(60)}\n${BODY_TAIL}`;

function ticketText(id) {
  return [
    '---',
    `id: "${id}"`,
    'title: "Задача"',
    'status: ready',
    'parent_plan: "PLAN-001"',
    'dependencies: ["TASK-000"]',
    '---',
    '',
    BODY,
  ].join('\n');
}

function putReady(id) {
  fs.writeFileSync(path.join(READY_DIR, `${id}.md`), ticketText(id), 'utf8');
}

test('демотирование: читатель ни в одной точке не видит пустой или обрезанный тикет', () => {
  const id = 'TASK-101';
  putReady(id);

  const watch = watchFsMutations((label) => [
    ...inspectMarkdownArtifact(path.join(READY_DIR, `${id}.md`), label),
    ...inspectMarkdownArtifact(path.join(BACKLOG_DIR, `${id}.md`), label),
  ]);

  let moved;
  try {
    moved = demoteToBacklog(id);
  } finally {
    watch.restore();
  }

  assert.equal(moved, true);
  assert.ok(watch.mutations > 0, 'наблюдатель обязан был увидеть хотя бы одну мутацию каталога');
  assert.deepEqual(watch.violations, [], `читатель видел неполный тикет: ${watch.violations.join('; ')}`);

  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(path.join(BACKLOG_DIR, `${id}.md`), 'utf8'));
  assert.equal(frontmatter.id, id);
  assert.deepEqual(frontmatter.dependencies, ['TASK-000'], 'зависимости, из-за которых тикет вернули, на месте');
  assert.ok(frontmatter.updated_at, 'время правки обновлено');
  assert.ok(body.includes(BODY_TAIL.trim()), 'хвост тела на месте');
});

test('демотирование: тикет лежит ровно в одной колонке и мусора рядом нет', () => {
  const id = 'TASK-102';
  putReady(id);

  demoteToBacklog(id);

  assert.equal(fs.existsSync(path.join(READY_DIR, `${id}.md`)), false, 'из ready тикет ушёл');
  assert.deepEqual(
    listRaw(BACKLOG_DIR).filter((name) => name.startsWith('.') || !name.endsWith('.md')),
    [],
    'временных файлов в колонке не осталось'
  );
});

test('демотирование: тикета в ready нет — отказ без записи', () => {
  const before = listRaw(BACKLOG_DIR);
  assert.equal(demoteToBacklog('TASK-999'), false);
  assert.deepEqual(listRaw(BACKLOG_DIR), before, 'колонка не изменилась');
});
