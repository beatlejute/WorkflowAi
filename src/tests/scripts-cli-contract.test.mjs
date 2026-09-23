#!/usr/bin/env node

/**
 * scripts-cli-contract.test.mjs — контракт CLI трёх скриптов: код выхода,
 * сообщение об ошибке и блок ---RESULT---.
 *
 * Зачем файл появился: после выноса ядра в *-core.js в самих скриптах остался
 * только клей — разбор argv, печать сообщений и коды выхода. Этот клей и есть
 * то, что видит пайплайн: по коду выхода он решает, ретраить стадию или гасить
 * тикет, а сообщение уходит в лог инцидента. Тестов на него не было, покрытие
 * трёх скриптов провалилось ниже храповика (scripts/check-coverage-ratchet.mjs),
 * и весь `npm run coverage` в CI стал красным.
 *
 * Здесь проверяется не механика, а цена ошибки: скрипт обязан упасть с ненулевым
 * кодом и объяснить причину, а тикет при этом обязан остаться нетронутым —
 * молчаливое «успешно» на битом входе уводит пайплайн дальше по ветке passed.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/scripts-cli-contract.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'src', 'scripts');
const MARK_BLOCKED = path.join(SCRIPTS_DIR, 'mark-blocked.js');
const MOVE_TICKET = path.join(SCRIPTS_DIR, 'move-ticket.js');
const PICK_NEXT_TASK = path.join(SCRIPTS_DIR, 'pick-next-task.js');

const KANBAN_DIRS = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'archive'];

/**
 * Создаёт изолированный проект с .workflow/.
 * @param {object} [options]
 * @param {string[]} [options.columns] — какие колонки канбана создать
 */
function makeProject({ columns = KANBAN_DIRS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-contract-'));
  const workflowDir = path.join(dir, '.workflow');
  const ticketsDir = path.join(workflowDir, 'tickets');
  for (const column of columns) {
    fs.mkdirSync(path.join(ticketsDir, column), { recursive: true });
  }
  fs.mkdirSync(path.join(workflowDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(workflowDir, 'plans', 'current'), { recursive: true });
  return { dir, workflowDir, ticketsDir };
}

/** Кладёт тикет в колонку и возвращает путь к файлу. */
function writeTicket(ticketsDir, column, id, extra = {}) {
  const frontmatter = {
    id,
    title: `Тикет ${id}`,
    priority: 2,
    type: 'impl',
    created_at: '2026-04-01T10:00:00.000Z',
    updated_at: '2026-04-01T10:00:00.000Z',
    ...extra,
  };
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const file = path.join(ticketsDir, column, `${id}.md`);
  fs.writeFileSync(file, `---\n${lines.join('\n')}\n---\n\n## Описание\n\nТело тикета ${id}.\n`, 'utf8');
  return file;
}

/** Кладёт тикет с невалидным YAML во frontmatter. */
function writeBrokenTicket(ticketsDir, column, id) {
  const file = path.join(ticketsDir, column, `${id}.md`);
  fs.writeFileSync(file, `---\nid: [не закрытая скобка\n---\n\n## Описание\n`, 'utf8');
  return file;
}

function writePlan(workflowDir, planId) {
  const file = path.join(workflowDir, 'plans', 'current', `${planId}.md`);
  fs.writeFileSync(
    file,
    `---\nid: ${planId}\ntitle: План ${planId}\nstatus: active\ncreated_at: "2026-04-01T10:00:00.000Z"\n---\n\n## Цель\n\nТест.\n`,
    'utf8'
  );
  return file;
}

function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** Разбирает блок ---RESULT--- в пары ключ/значение. */
function parseResult(stdout) {
  const marker = '---RESULT---';
  const start = stdout.indexOf(marker);
  if (start === -1) return null;
  const end = stdout.indexOf(marker, start + marker.length);
  if (end === -1) return null;
  const out = {};
  for (const line of stdout.slice(start + marker.length, end).split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function readTicket(file) {
  return fs.readFileSync(file, 'utf8');
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ============================================================================
// mark-blocked.js — разбор аргументов и коды выхода
// ============================================================================

test('mark-blocked: --attempts не число — выход с ошибкой, тикет не помечен блокированным', () => {
  const { dir, ticketsDir } = makeProject();
  const ticket = writeTicket(ticketsDir, 'ready', 'IMPL-201');

  const result = run(MARK_BLOCKED, ['IMPL-201', '--attempts=шесть', '--reason=max_review_attempts'], dir);

  assert.notStrictEqual(result.code, 0, 'битое число попыток обязано валить скрипт: иначе в тикет уедет attempts: null');
  assert.match(result.stderr, /--attempts/, 'в stderr должно быть названо поле, из-за которого скрипт встал');
  assert.doesNotMatch(readTicket(ticket), /auto_blocked_reason/, 'тикет не должен быть помечен блокированным после отказа');

  cleanup(dir);
});

test('mark-blocked: аргументов хватает, но --reason нет — выход с ошибкой, тикет не помечен', () => {
  const { dir, ticketsDir } = makeProject();
  const ticket = writeTicket(ticketsDir, 'ready', 'IMPL-202');

  // Три аргумента: проверка «мало аргументов» пропускает, до обязательного --reason доходит.
  const result = run(MARK_BLOCKED, ['IMPL-202', '--attempts=6', '--stage=review-result'], dir);

  assert.notStrictEqual(result.code, 0, 'блокировка без причины бесполезна: в алерте и тикете не останется, за что тикет встал');
  assert.match(result.stderr, /--reason/, 'в stderr должно быть названо отсутствующее поле');
  assert.doesNotMatch(readTicket(ticket), /auto_blocked_reason/, 'тикет не должен быть помечен блокированным после отказа');

  cleanup(dir);
});

test('mark-blocked: тикета нет на доске — выход с ошибкой и указанием, где искали', () => {
  const { dir, ticketsDir } = makeProject();
  writeTicket(ticketsDir, 'ready', 'IMPL-203');

  const result = run(MARK_BLOCKED, ['IMPL-999', '--attempts=6', '--reason=max_review_attempts'], dir);

  assert.notStrictEqual(result.code, 0, 'опечатка в id не должна выглядеть как успешная блокировка');
  assert.match(result.stderr, /IMPL-999/, 'в stderr должен быть id, который не нашли');
  assert.match(result.stderr, /не найден/, 'сообщение должно называть причину отказа');

  cleanup(dir);
});

test('mark-blocked: битый frontmatter тикета — выход с ошибкой, а не тихая порча файла', () => {
  const { dir, ticketsDir } = makeProject();
  const ticket = writeBrokenTicket(ticketsDir, 'ready', 'IMPL-204');
  const before = readTicket(ticket);

  const result = run(MARK_BLOCKED, ['IMPL-204', '--attempts=6', '--reason=max_review_attempts'], dir);

  assert.notStrictEqual(result.code, 0, 'нечитаемый тикет обязан валить скрипт: перезапись сотрёт то, что ещё можно спасти');
  assert.match(result.stderr, /Ошибка/, 'в stderr должно быть сообщение об ошибке');
  assert.strictEqual(readTicket(ticket), before, 'файл тикета должен остаться байт в байт прежним');

  cleanup(dir);
});

// ============================================================================
// move-ticket.js — валидация перехода и целевая колонка
// ============================================================================

test('move-ticket: колонки с таким именем нет — отказ со списком допустимых, тикет на месте', () => {
  const { dir, ticketsDir } = makeProject();
  writeTicket(ticketsDir, 'backlog', 'IMPL-210');

  const result = run(MOVE_TICKET, ['IMPL-210', 'in_progress'], dir);
  const parsed = parseResult(result.stdout);

  assert.notStrictEqual(result.code, 0, 'опечатка в имени колонки не должна выглядеть как выполненный переход');
  assert.ok(parsed, 'пайплайн читает блок ---RESULT---, он обязан быть даже при отказе');
  assert.strictEqual(parsed.status, 'error');
  assert.match(parsed.error, /Неверный целевой статус/, 'ответ должен называть причину отказа');
  assert.match(parsed.error, /in-progress/, 'ответ должен перечислять допустимые колонки — иначе агент гадает');
  assert.ok(fs.existsSync(path.join(ticketsDir, 'backlog', 'IMPL-210.md')), 'тикет обязан остаться в исходной колонке');

  cleanup(dir);
});

test('move-ticket: целевой колонки нет на диске — создаётся, тикет не теряется', () => {
  // ready/ намеренно не создаём: на свежей доске и после ручной чистки колонки нет,
  // а терять тикет между колонками нельзя.
  const { dir, ticketsDir } = makeProject({ columns: ['backlog'] });
  writeTicket(ticketsDir, 'backlog', 'IMPL-211');

  const result = run(MOVE_TICKET, ['IMPL-211', 'ready'], dir);
  const parsed = parseResult(result.stdout);

  assert.strictEqual(result.code, 0, 'отсутствие колонки не повод валить переход');
  assert.strictEqual(parsed.status, 'moved');
  assert.ok(fs.existsSync(path.join(ticketsDir, 'ready', 'IMPL-211.md')), 'тикет обязан оказаться в ready/');
  assert.ok(!fs.existsSync(path.join(ticketsDir, 'backlog', 'IMPL-211.md')), 'в исходной колонке копии остаться не должно');
  assert.match(readTicket(path.join(ticketsDir, 'ready', 'IMPL-211.md')), /status: ready/, 'status во frontmatter обязан совпасть с колонкой');

  cleanup(dir);
});

test('move-ticket: битый frontmatter — отказ, тикет остаётся в исходной колонке', () => {
  const { dir, ticketsDir } = makeProject();
  const ticket = writeBrokenTicket(ticketsDir, 'backlog', 'IMPL-212');
  const before = readTicket(ticket);

  const result = run(MOVE_TICKET, ['IMPL-212', 'ready'], dir);
  const parsed = parseResult(result.stdout);

  assert.notStrictEqual(result.code, 0, 'нечитаемый тикет не должен уезжать в следующую колонку как ни в чём не бывало');
  assert.strictEqual(parsed.status, 'error');
  assert.ok(fs.existsSync(ticket), 'файл обязан остаться в исходной колонке');
  assert.strictEqual(readTicket(ticket), before, 'файл тикета должен остаться байт в байт прежним');
  assert.ok(!fs.existsSync(path.join(ticketsDir, 'ready', 'IMPL-212.md')), 'в целевой колонке файла быть не должно');

  cleanup(dir);
});

// ============================================================================
// pick-next-task.js — фильтр по плану и закрытие плана
// ============================================================================

test('pick-next-task: в контексте есть plan_id — берётся тикет своего плана, чужой не трогается', () => {
  const { dir, workflowDir, ticketsDir } = makeProject();
  writePlan(workflowDir, 'PLAN-101');
  writePlan(workflowDir, 'PLAN-102');
  writeTicket(ticketsDir, 'ready', 'IMPL-220', { parent_plan: 'plans/current/PLAN-102.md' });
  writeTicket(ticketsDir, 'ready', 'IMPL-221', { parent_plan: 'plans/current/PLAN-101.md' });

  const prompt = 'pick-next-task\n\nContext:\n  plan_id: PLAN-101\n';
  const result = run(PICK_NEXT_TASK, [prompt], dir);
  const parsed = parseResult(result.stdout);

  assert.strictEqual(parsed.status, 'found');
  assert.strictEqual(parsed.ticket_id, 'IMPL-221', 'взят тикет чужого плана — пайплайн уедет работать не над тем планом');
  assert.match(result.stdout, /plan_id: PLAN-101/, 'фильтр по плану должен быть виден в логе стадии');
  assert.match(result.stdout, /PLAN-101 progress: 0\/1/, 'прогресс плана нужен в логе: по нему видно, что план ещё жив');

  cleanup(dir);
});

test('pick-next-task: все тикеты плана в done — план закрывается, очередь пуста', () => {
  const { dir, workflowDir, ticketsDir } = makeProject();
  const planFile = writePlan(workflowDir, 'PLAN-103');
  writeTicket(ticketsDir, 'done', 'IMPL-230', {
    parent_plan: 'plans/current/PLAN-103.md',
    completed_at: '2026-04-02T10:00:00.000Z',
  });

  const prompt = 'pick-next-task\n\nContext:\n  plan_id: PLAN-103\n';
  const result = run(PICK_NEXT_TASK, [prompt], dir);
  const parsed = parseResult(result.stdout);

  assert.strictEqual(result.code, 0, 'пустая очередь — штатный конец плана, а не падение стадии');
  assert.strictEqual(parsed.status, 'empty');
  assert.match(result.stdout, /PLAN-103 closed/, 'закрытие плана должно быть видно в логе стадии');
  assert.match(readTicket(planFile), /status: completed/, 'план обязан быть помечен завершённым, иначе он вечно в работе');

  cleanup(dir);
});

test('pick-next-task: авто-коррекция по конфигу — passed уезжает в done с отметкой времени, done без вердикта возвращается в backlog', () => {
  const { dir, workflowDir, ticketsDir } = makeProject();
  // Берём боевой конфиг правил, а не выдумываем свой: проверяем ту же таблицу,
  // которую workflow init кладёт в проект.
  fs.mkdirSync(path.join(workflowDir, 'config'), { recursive: true });
  fs.copyFileSync(
    path.join(PROJECT_ROOT, 'configs', 'ticket-movement-rules.yaml'),
    path.join(workflowDir, 'config', 'ticket-movement-rules.yaml')
  );

  const reviewed = writeTicket(ticketsDir, 'review', 'IMPL-240');
  fs.appendFileSync(
    reviewed,
    '\n## Ревью\n\n| Дата | Статус | Самари | Агент |\n|------|--------|--------|-------|\n| 2026-04-02 10:00 | ✅ passed | ок | review-agent |\n',
    'utf8'
  );
  writeTicket(ticketsDir, 'done', 'IMPL-241');
  writeTicket(ticketsDir, 'ready', 'IMPL-242');

  const result = run(PICK_NEXT_TASK, [], dir);
  const parsed = parseResult(result.stdout);

  assert.strictEqual(parsed.status, 'found');
  assert.strictEqual(parsed.ticket_id, 'IMPL-242');
  assert.strictEqual(parsed.auto_corrected, '2', 'в RESULT должно быть число сдвинутых тикетов: по нему пайплайн отчитывается о коррекции');
  assert.match(result.stdout, /\[AUTO-CORRECT\] IMPL-240/, 'сдвиг тикета обязан быть виден в логе — молча переложенный тикет не расследуешь');

  const movedToDone = path.join(ticketsDir, 'done', 'IMPL-240.md');
  assert.ok(fs.existsSync(movedToDone), 'тикет с пройденным ревью обязан уехать в done/');
  assert.match(
    readTicket(movedToDone),
    /completed_at:/,
    'без completed_at следующий проход отправит закрытый тикет на новый круг (HUMAN-4, HUMAN-5 2026-08-04)'
  );

  assert.ok(fs.existsSync(path.join(ticketsDir, 'backlog', 'IMPL-241.md')), 'тикет в done/ без вердикта ревью обязан вернуться в backlog/');
  assert.ok(!fs.existsSync(path.join(ticketsDir, 'done', 'IMPL-241.md')), 'копии в done/ остаться не должно');

  cleanup(dir);
});
