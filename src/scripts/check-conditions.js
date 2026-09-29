#!/usr/bin/env node

/**
 * check-conditions.js — Проверяет условия тикетов в backlog/ и выводит список готовых
 *
 * До просмотра backlog/ возвращает туда тикеты из ready/ с невыполненными условиями
 * (demoted_tickets), закрывает в done/ тикеты из blocked/, которые заменила готовая
 * повторная проверка полем `supersedes` (superseded_tickets, closeSupersededTickets), и
 * возвращает в backlog/ тикеты из blocked/, все исправления которых (поле `unblocks`)
 * готовы (unblocked_tickets, unblockFixedTickets). Все три поля есть в результате всегда,
 * пустые — без значения.
 *
 * Использование:
 *   node check-conditions.js
 *
 * Выводит результат в формате:
 *   ---RESULT---
 *   status: has_ready
 *   ready_tickets: IMPL-002, DOCS-001
 *   ---RESULT---
 *
 * или если готовых нет, но есть тикеты в ready/:
 *   ---RESULT---
 *   status: default
 *   ready_tickets:
 *   ---RESULT---
 *
 * или если backlog пуст и нет тикетов в ready/:
 *   ---RESULT---
 *   status: empty
 *   ready_tickets:
 *   ---RESULT---
 */

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { parseFrontmatter, printResult, normalizePlanId, extractPlanId, serializeFrontmatter, replaceFileAtomicSync } from 'workflow-ai/lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();
const WORKFLOW_DIR = path.join(PROJECT_DIR, '.workflow');
const TICKETS_DIR = path.join(WORKFLOW_DIR, 'tickets');
const BACKLOG_DIR = path.join(TICKETS_DIR, 'backlog');
const READY_DIR = path.join(TICKETS_DIR, 'ready');
const DONE_DIR = path.join(TICKETS_DIR, 'done');
const ARCHIVE_DIR = path.join(TICKETS_DIR, 'archive');
const BLOCKED_DIR = path.join(TICKETS_DIR, 'blocked');

/**
 * Проверяет одно условие тикета
 */
function checkCondition(condition) {
  const { type, value } = condition;

  switch (type) {
    case 'file_exists':
      return fs.existsSync(path.isAbsolute(value) ? value : path.join(PROJECT_DIR, value));

    case 'file_not_exists':
      return !fs.existsSync(path.isAbsolute(value) ? value : path.join(PROJECT_DIR, value));

    case 'tasks_completed': {
      if (!value || (Array.isArray(value) && value.length === 0)) return true;
      const ids = Array.isArray(value) ? value : [value];
      return ids.every(taskId =>
        fs.existsSync(path.join(DONE_DIR, `${taskId}.md`)) ||
        fs.existsSync(path.join(ARCHIVE_DIR, `${taskId}.md`))
      );
    }

    case 'date_after':
      return new Date() > new Date(value);

    case 'date_before':
      return new Date() < new Date(value);

    case 'manual_approval':
      return false;

    default:
      console.error(`[WARN] Unknown condition type: ${type}`);
      return true;
  }
}

/**
 * Проверяет зависимости тикета
 */
function checkDependencies(dependencies) {
  if (!dependencies || dependencies.length === 0) return true;
  return dependencies.every(depId =>
    fs.existsSync(path.join(DONE_DIR, `${depId}.md`)) ||
    fs.existsSync(path.join(ARCHIVE_DIR, `${depId}.md`))
  );
}

/**
 * Считывает все тикеты из директории
 */
function readTickets(dir) {
  if (!fs.existsSync(dir)) return [];

  const tickets = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '.gitkeep.md');

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      tickets.push({ id: frontmatter.id || file.replace('.md', ''), file, frontmatter });
    } catch (e) {
      console.error(`[WARN] Failed to read ticket ${file}: ${e.message}`);
    }
  }

  return tickets;
}

/**
 * Перемещает тикет из ready/ в backlog/
 *
 * Экспортируется для теста: публикация содержимого после переезда — тот же класс
 * гонки, что закрыт для маркера пайплайна и approval-файла, и проверяется
 * поведенчески (src/tests/race-ticket-demote-atomic-write.test.mjs).
 */
export function demoteToBacklog(ticketId) {
  const sourcePath = path.join(READY_DIR, `${ticketId}.md`);
  const targetPath = path.join(BACKLOG_DIR, `${ticketId}.md`);

  if (!fs.existsSync(sourcePath)) {
    console.error(`[WARN] ${ticketId}: not found in ready/, skipping`);
    return false;
  }

  const content = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  // status — колонка, как у move-ticket.js: иначе в backlog/ лежит тикет со status: ready
  frontmatter.status = 'backlog';
  frontmatter.updated_at = new Date().toISOString();

  const newContent = serializeFrontmatter(frontmatter) + body;

  if (!fs.existsSync(BACKLOG_DIR)) {
    fs.mkdirSync(BACKLOG_DIR, { recursive: true });
  }

  // Сначала переезд, потом содержимое: тикет всё время лежит ровно в одной
  // колонке. Прямая запись обрезала только что переехавший файл до нуля, и
  // следующий же readTickets в этом самом скрипте мог прочитать тикет с пустым
  // frontmatter — то есть без зависимостей, из-за которых его сюда и отправили.
  fs.renameSync(sourcePath, targetPath);
  replaceFileAtomicSync(targetPath, newContent);
  return true;
}

// Все колонки доски: тикет, который называет заблокированный полем `unblocks`, может
// лежать в любой из них, и пока он не в done/ или archive/, исправление не готово.
const ALL_COLUMNS = ['backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive'];
const FINISHED_COLUMNS = new Set(['done', 'archive']);

// Список id из frontmatter: массив непустых строк, иначе null (поле испорчено).
function idList(value) {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.trim() === '')) return null;
  return value.map(v => v.trim());
}

// Списки, которые пишет этот скрипт (`unblocked_by`, `unblocks_applied`,
// `supersedes_applied`); строку (правка руками) читаем как один id.
function writtenList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  return [];
}

// Время из frontmatter в мс: js-yaml читает ISO без кавычек как Date, в кавычках — как
// строку; нет поля или не дата — NaN.
function timeOf(value) {
  return value === undefined || value === null ? NaN : new Date(value).getTime();
}

// id цели → тикеты любой колонки с корректным `unblocks`, которые её называют.
function unblocksNamers(board) {
  const namers = new Map();
  for (const t of board) {
    const list = idList(t.frontmatter.unblocks);
    if (!list) continue;
    for (const id of new Set(list)) {
      if (!namers.has(id)) namers.set(id, []);
      namers.get(id).push(t);
    }
  }
  return namers;
}

function readBoard() {
  const board = [];
  for (const column of ALL_COLUMNS) {
    const dir = path.join(TICKETS_DIR, column);
    for (const t of readTickets(dir)) {
      if (!t.frontmatter) continue;
      board.push({ ...t, column, filePath: path.join(dir, t.file) });
    }
  }
  return board;
}

// Отметки «уже обработано» копятся за запуск и пишутся в тикет один раз в конце:
// доска читается до переносов, а отметить тикет может и чужой перенос (возврат цели
// отмечает все исправления, которые её называют).
function createMarks(field) {
  const marks = new Map(); // filePath → { ticket, ids: Set }
  return {
    has(ticket, id) {
      const entry = marks.get(ticket.filePath);
      return writtenList(ticket.frontmatter[field]).includes(id) || Boolean(entry && entry.ids.has(id));
    },
    add(ticket, ids) {
      let entry = marks.get(ticket.filePath);
      if (!entry) marks.set(ticket.filePath, entry = { ticket, ids: new Set() });
      for (const id of ids) entry.ids.add(id);
    },
    flush() {
      for (const { ticket, ids } of marks.values()) {
        let parsed;
        try {
          parsed = parseFrontmatter(fs.readFileSync(ticket.filePath, 'utf8'));
        } catch (e) {
          console.error(`[WARN] ${ticket.id}: не удалось записать ${field}: ${e.message}`);
          continue;
        }
        const { frontmatter: fm, body } = parsed;
        const prev = writtenList(fm[field]);
        const next = [...new Set([...prev, ...ids])];
        if (Array.isArray(fm[field]) && next.length === prev.length) continue;
        fm[field] = next;
        replaceFileAtomicSync(ticket.filePath, serializeFrontmatter(fm) + body);
      }
    },
  };
}

// Переносит тикет из blocked/ в колонку `column`: сначала переезд, потом содержимое
// (replaceFileAtomicSync), как demoteToBacklog, — тикет всё время лежит ровно в одной
// колонке. `status` — колонка назначения, как у move-ticket.js: закрытый в done/ тикет
// иначе оставался со status: blocked, и потребители frontmatter (скорость в workflow-mcp,
// sync-ticket-status) видели его заблокированным. Файл с тем же id в колонке назначения
// или нечитаемый тикет — WARN, false.
function moveOutOfBlocked(targetId, column, edit) {
  const sourcePath = path.join(BLOCKED_DIR, `${targetId}.md`);
  const targetDir = path.join(TICKETS_DIR, column);
  const targetPath = path.join(targetDir, `${targetId}.md`);
  if (fs.existsSync(targetPath)) {
    console.error(`[WARN] ${targetId}: в ${column}/ уже есть файл с этим id — из blocked/ не переносим`);
    return false;
  }
  let parsed;
  try {
    parsed = parseFrontmatter(fs.readFileSync(sourcePath, 'utf8'));
  } catch (e) {
    console.error(`[WARN] ${targetId}: не удалось прочитать тикет из blocked/: ${e.message}`);
    return false;
  }
  const { frontmatter: fm, body } = parsed;
  edit(fm);
  delete fm.blocked_reason;
  fm.status = column;
  fm.updated_at = new Date().toISOString();
  const newContent = serializeFrontmatter(fm) + body;

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  fs.renameSync(sourcePath, targetPath);
  replaceFileAtomicSync(targetPath, newContent);
  return true;
}

/**
 * Возвращает в backlog/ заблокированные тикеты, которые назвали полем
 * `unblocks: [ID, ...]` готовые тикеты.
 *
 * Зачем: тестовый тикет, упавший до исправления продукта, уходит в blocked/, а
 * decompose-gaps тикеты не двигает — пишет только новые в backlog/. PulseProxy PLAN-017
 * 2026-09-28: QA-162 упал до исправления и встал в blocked/, разбиение завело FIX-032 и
 * новую повторную проверку QA-163; обе прошли, а QA-162 так и остался в blocked/, и
 * complete-plan отвечал not_ready 69/70 — план не закрывался. Теперь автор тикета
 * исправления пишет в него `unblocks` (данные, а не команду), а переносит тикет пайплайн,
 * когда исправление готово. Вернувшийся тикет оценивает обычный просмотр backlog/ в этом
 * же запуске — готовность решают его условия и зависимости.
 *
 * Ждёт всех исправлений: цель возвращается, только когда каждый тикет любой колонки,
 * который называет её в `unblocks`, лежит в done/ или archive/. Исправлен один дефект из
 * двух — повторная проверка упала бы на втором (платный прогон впустую); пока какое-то
 * исправление открыто — `[INFO] <id>: ждёт исправлений <ids>`, тикет не тронут.
 *
 * Каждое исправление действует один раз, и отметка — на нём самом: обработанные id
 * пишутся в его `unblocks_applied` (цель возвращена, или была не в blocked/, или её нет).
 * Поэтому старое исправление не вернёт тикет, заблокированный позже по другой причине,
 * а WARN о цели не в blocked/ звучит один раз. При возврате в `unblocked_by` цели пишутся
 * все исправления, которые её называют (почему тикет вернулся), и отмечаются все они.
 * Исправление, чья цель ждёт других, не отмечается: вернёт её, когда готовы все.
 *
 * `unblocks` не списком строк — WARN один раз (затем `unblocks_applied: []`); файл с тем
 * же id уже в backlog/ — WARN, без переноса и без отметки.
 */
export function unblockFixedTickets(board = readBoard()) {
  const unblocked = [];
  const applied = createMarks('unblocks_applied');

  const namers = unblocksNamers(board);

  const fixes = board.filter(t => FINISHED_COLUMNS.has(t.column)
    && t.frontmatter.unblocks !== undefined && t.frontmatter.unblocks !== null);
  const waitingLogged = new Set();

  for (const fix of fixes) {
    const list = idList(fix.frontmatter.unblocks);
    if (!list) {
      if (fix.frontmatter.unblocks_applied === undefined) {
        console.error(`[WARN] ${fix.id}: поле unblocks не список id тикетов (${JSON.stringify(fix.frontmatter.unblocks)}), пропускаем`);
        applied.add(fix, []);
      }
      continue;
    }

    for (const targetId of new Set(list)) {
      if (applied.has(fix, targetId)) continue;

      if (!fs.existsSync(path.join(BLOCKED_DIR, `${targetId}.md`))) {
        // Цель не в blocked/ в момент готовности исправления — отмечаем: позже
        // заблокированный по другой причине тикет это исправление не вернёт.
        console.error(`[WARN] ${fix.id}: unblocks ${targetId} — тикета нет в blocked/, отмечаем без переноса`);
        applied.add(fix, [targetId]);
        continue;
      }

      const all = namers.get(targetId) || [];
      const open = all.filter(t => !FINISHED_COLUMNS.has(t.column));
      if (open.length > 0) {
        if (!waitingLogged.has(targetId)) {
          waitingLogged.add(targetId);
          console.log(`[INFO] ${targetId}: ждёт исправлений ${open.map(t => t.id).join(', ')}`);
        }
        continue;
      }

      const fixIds = all.map(t => t.id);
      const moved = moveOutOfBlocked(targetId, 'backlog', fm => {
        fm.unblocked_by = [...new Set([...writtenList(fm.unblocked_by), ...fixIds])];
      });
      if (!moved) continue;

      for (const t of all) applied.add(t, [targetId]);
      const done = fixIds.length === 1 ? `исправление ${fixIds[0]} готово` : `исправления ${fixIds.join(', ')} готовы`;
      console.log(`[INFO] ${targetId}: blocked/ → backlog/ (${done})`);
      unblocked.push(targetId);
    }
  }

  applied.flush();
  return unblocked;
}

/**
 * Закрывает заблокированные тикеты, которые заменил готовый тикет повторной проверки
 * полем `supersedes: [ID, ...]`.
 *
 * Зачем: тикет тестирования T упал на дефекте продукта и встал в blocked/, а исправление
 * к моменту разбора уже готово (тикет плана без зависимости от T, исправление прошлого
 * запуска). Новое исправление с `unblocks` не нужно, а готовое скил править не может —
 * он пишет повторную проверку R, зависящую от исправления, с `supersedes: [T]`. R в done/
 * или archive/ — сценарий перепроверен, и T переезжает blocked/ → done/ с
 * `superseded_by: R`, `completed_at` и `updated_at` сейчас, без `blocked_reason`. Иначе
 * T навсегда в blocked/, и complete-plan отвечает not_ready.
 *
 * T называет в `unblocks` тикет исправления F — R закрывает T, только если каждый такой F
 * готов и закрыт раньше, чем R проверил сценарий: R прогнан после всех исправлений. Время
 * проверки R — его `rechecked_at`, если R сам закрыт заменой (время проверки, которая его
 * заменила), иначе `completed_at`. Пока какой-то F открыт — `[INFO] T: ждёт исправлений …`,
 * R не отмечен. F закрыт позже проверки или время не сверить — R не применяется (отмечен), и
 * T перепроверит все дефекты сам: его вернёт unblockFixedTickets, а если каждый такой F уже
 * возвращал T раньше (`unblocks_applied`) и второй раз не вернёт — T возвращается в backlog/
 * здесь же, с `unblocked_by`. Иначе T с двумя дефектами — один исправлен, второй ждёт
 * FIX-033 с `unblocks` — закрывала бы проверка R первого дефекта, и после FIX-033 сценарий
 * никто не перепроверял бы (ревью 2026-09-29).
 *
 * Как у `unblocks`: R действует один раз, обработанные id — в его `supersedes_applied`
 * (T перенесён, или T не в blocked/, или его нет, или R прогнан раньше исправления);
 * `supersedes` не списком строк — WARN один раз; файл с тем же id уже в done/ — WARN, без
 * переноса и без отметки.
 *
 * Цепочка проверок закрывается за один запуск: R2 заменяет заблокированную проверку R1,
 * а R1 — тикет T. Закрытая сейчас R1 попадает в done/ со своим `supersedes` и
 * `rechecked_at` проверки R2, и следующий проход по перечитанной доске решает T по этому
 * времени, а не по времени закрытия. Проходы идут, пока проход уносит из blocked/ хоть один
 * тикет, поэтому цикл конечен. Иначе T ждал бы следующего запуска, а этот уходил бы в
 * платный отчёт при T в blocked/ (ревью 2026-09-29).
 *
 * Возвращает { superseded, unblocked } — закрытые в done/ и возвращённые в backlog/.
 */
export function closeSupersededTickets() {
  const superseded = [];
  const unblocked = [];
  const waitingLogged = new Set(); // «ждёт исправлений» — один раз за запуск, не за проход
  for (;;) {
    const pass = closeSupersededOnce(readBoard(), waitingLogged);
    superseded.push(...pass.superseded);
    unblocked.push(...pass.unblocked);
    if (pass.superseded.length + pass.unblocked.length === 0) break;
  }
  return { superseded, unblocked };
}

// Время, когда проверка R прогнала сценарий: закрытая заменой R несёт время заменившей
// проверки в `rechecked_at`, её `completed_at` — только время закрытия, поэтому без
// `rechecked_at` время такой R не сверить (ревью 2026-09-29).
function recheckTimeOf(recheck) {
  const { rechecked_at: rechecked, completed_at: completed, superseded_by: supersededBy } = recheck.frontmatter;
  // Закрытая заменой R без rechecked_at: время её закрытия — не время проверки, сверять не с чем
  if (supersededBy !== undefined && supersededBy !== null) return rechecked === '' ? undefined : rechecked;
  return completed;
}

function closeSupersededOnce(board, waitingLogged) {
  const superseded = [];
  const unblocked = [];
  const applied = createMarks('supersedes_applied');
  const fixesApplied = createMarks('unblocks_applied');
  const namers = unblocksNamers(board);

  const rechecks = board.filter(t => FINISHED_COLUMNS.has(t.column)
    && t.frontmatter.supersedes !== undefined && t.frontmatter.supersedes !== null);

  for (const recheck of rechecks) {
    const list = idList(recheck.frontmatter.supersedes);
    if (!list) {
      if (recheck.frontmatter.supersedes_applied === undefined) {
        console.error(`[WARN] ${recheck.id}: поле supersedes не список id тикетов (${JSON.stringify(recheck.frontmatter.supersedes)}), пропускаем`);
        applied.add(recheck, []);
      }
      continue;
    }

    for (const targetId of new Set(list)) {
      if (applied.has(recheck, targetId)) continue;

      if (!fs.existsSync(path.join(BLOCKED_DIR, `${targetId}.md`))) {
        console.error(`[WARN] ${recheck.id}: supersedes ${targetId} — тикета нет в blocked/, отмечаем без переноса`);
        applied.add(recheck, [targetId]);
        continue;
      }

      const fixes = namers.get(targetId) || [];
      const open = fixes.filter(t => !FINISHED_COLUMNS.has(t.column));
      if (open.length > 0) {
        if (!waitingLogged.has(targetId)) {
          waitingLogged.add(targetId);
          console.log(`[INFO] ${targetId}: ждёт исправлений ${open.map(t => t.id).join(', ')} — supersedes не применяется`);
        }
        continue;
      }
      const checkedAt = recheckTimeOf(recheck);
      const recheckTime = timeOf(checkedAt);
      const later = fixes.filter(t => !(timeOf(t.frontmatter.completed_at) < recheckTime));
      if (later.length > 0) {
        const laterIds = later.map(t => t.id).join(', ');
        const pending = later.filter(t => !writtenList(t.frontmatter.unblocks_applied).includes(targetId));
        if (pending.length > 0) {
          console.log(`[INFO] ${recheck.id}: supersedes ${targetId} не применяется — исправление ${laterIds} закрыто позже проверки или без completed_at, ${targetId} вернётся по unblocks`);
          applied.add(recheck, [targetId]);
          continue;
        }
        // Каждое такое исправление уже возвращало T и второй раз его не вернёт — возвращаем
        // здесь, иначе T навсегда в blocked/, а R израсходован (ревью 2026-09-29)
        const fixIds = fixes.map(t => t.id);
        const back = moveOutOfBlocked(targetId, 'backlog', fm => {
          fm.unblocked_by = [...new Set([...writtenList(fm.unblocked_by), ...fixIds])];
        });
        if (!back) continue;
        applied.add(recheck, [targetId]);
        for (const t of fixes) fixesApplied.add(t, [targetId]);
        console.log(`[INFO] ${targetId}: blocked/ → backlog/ (supersedes ${recheck.id} не применяется — исправление ${laterIds} закрыто позже проверки или без completed_at и уже возвращало тикет)`);
        unblocked.push(targetId);
        continue;
      }

      const moved = moveOutOfBlocked(targetId, 'done', fm => {
        fm.superseded_by = recheck.id;
        if (checkedAt !== undefined && checkedAt !== null && checkedAt !== '') fm.rechecked_at = checkedAt;
        fm.completed_at = new Date().toISOString();
      });
      if (!moved) continue;

      applied.add(recheck, [targetId]);
      console.log(`[INFO] ${targetId}: blocked/ → done/ (заменён ${recheck.id})`);
      superseded.push(targetId);
    }
  }

  applied.flush();
  fixesApplied.flush();
  return { superseded, unblocked };
}

/**
 * Проверяет все тикеты в backlog/ и возвращает список готовых
 *
 * ВАЖНО: этот скрипт ничего не перемещает — физический перенос backlog/ → ready/
 * делает move-to-ready.js по имени файла `${id}.md`. Поэтому в ready попадают
 * только те тикеты, которые move-to-ready реально сможет найти и переместить,
 * иначе has_ready → moved: 0 → pick-next-task (empty) → check-conditions
 * закручивается в холостой цикл до max_steps.
 */
function checkBacklog(planId) {
  const allTickets = readTickets(BACKLOG_DIR);
  const tickets = planId
    ? allTickets.filter(t => normalizePlanId(t.frontmatter.parent_plan) === planId)
    : allTickets;

  const ready = [];
  const waiting = [];
  const unmovable = [];

  for (const ticket of tickets) {
    const { frontmatter, id, file } = ticket;

    const conditions = frontmatter.conditions || [];
    const dependencies = frontmatter.dependencies || [];

    const depsMet = checkDependencies(dependencies);
    const conditionsMet = conditions.every(checkCondition);

    if (depsMet && conditionsMet) {
      // frontmatter.id не совпал с именем файла — move-to-ready не найдёт `${id}.md`
      if (file !== `${id}.md`) {
        unmovable.push({ id, file });
        continue;
      }
      ready.push(id);
      if (frontmatter.type === 'human') {
        console.log(`[INFO] ${id}: type is 'human' (выполняется человеком через manual-gate)`);
      }
    } else {
      const reasons = [];
      if (!depsMet) reasons.push(`ждёт зависимости: ${dependencies.join(', ')}`);
      conditions.forEach(c => {
        if (!checkCondition(c)) reasons.push(`условие не выполнено: ${c.type}`);
      });
      waiting.push({ id, reasons });
    }
  }

  return { ready, waiting, unmovable, total: tickets.length };
}

/**
 * Проверяет тикеты в ready/ и возвращает тикеты в backlog при невыполненных условиях
 */
function checkReady(planId) {
  const allTickets = readTickets(READY_DIR);
  const tickets = planId
    ? allTickets.filter(t => normalizePlanId(t.frontmatter.parent_plan) === planId)
    : allTickets;

  const demoted = [];

  for (const ticket of tickets) {
    const { frontmatter, id } = ticket;
    const conditions = frontmatter.conditions || [];
    const dependencies = frontmatter.dependencies || [];

    const depsMet = checkDependencies(dependencies);
    const conditionsMet = conditions.every(checkCondition);

    if (!depsMet || !conditionsMet) {
      if (demoteToBacklog(id)) {
        console.log(`[INFO] ${id}: ready/ → backlog/ (условия не выполнены)`);
        demoted.push(id);
      }
    }
  }

  return { demoted, total: tickets.length };
}

async function main() {
  const planId = extractPlanId();

  if (planId) {
    console.log(`[INFO] Filtering by plan_id: ${planId}`);
  }

  // Сначала демотирование невалидных тикетов из ready/
  console.log(`[INFO] Checking ready/ for invalid tickets: ${READY_DIR}`);
  const { demoted, total: readyTotal } = checkReady(planId);
  console.log(`[INFO] Total in ready/${planId ? ` (plan ${planId})` : ''}: ${readyTotal}`);
  console.log(`[INFO] Demoted to backlog: ${demoted.length}`);

  // Заменённые повторной проверкой (поле supersedes) — в done/, раньше возврата по
  // unblocks: сценарий уже перепроверен, второй прогон того же тикета не нужен
  console.log(`[INFO] Checking done/ and archive/ for supersedes: ${BLOCKED_DIR}`);
  const { superseded, unblocked: unblockedBySupersedes } = closeSupersededTickets();
  console.log(`[INFO] Superseded to done: ${superseded.length}`);

  // Возврат заблокированных тикетов, все исправления которых готовы (поле unblocks), —
  // до просмотра backlog/, чтобы вернувшиеся оценились в этом же запуске
  console.log(`[INFO] Checking done/ and archive/ for unblocks: ${BLOCKED_DIR}`);
  const unblocked = [...unblockedBySupersedes, ...unblockFixedTickets()];
  console.log(`[INFO] Unblocked to backlog: ${unblocked.length}`);

  // Затем проверка backlog — демотированные тикеты сразу переоцениваются
  console.log(`[INFO] Scanning backlog/: ${BACKLOG_DIR}`);

  const { ready, waiting, unmovable, total } = checkBacklog(planId);

  console.log(`[INFO] Total in backlog${planId ? ` (plan ${planId})` : ''}: ${total}`);
  console.log(`[INFO] Ready: ${ready.length}, Waiting: ${waiting.length}`);

  for (const { id, file } of unmovable) {
    console.error(`[WARN] ${id}: id не совпадает с именем файла (${file}) — move-to-ready не сможет переместить, пропускаем`);
  }

  if (ready.length > 0) {
    console.log(`[INFO] Ready tickets (будут перемещены стадией move-to-ready): ${ready.join(', ')}`);
  }

  for (const { id, reasons } of waiting) {
    console.log(`[INFO] ${id}: ${reasons.join('; ')}`);
  }

  if (ready.length > 0) {
    printResult({ status: 'has_ready', ready_tickets: ready.join(', '), demoted_tickets: demoted.join(', '), unblocked_tickets: unblocked.join(', '), superseded_tickets: superseded.join(', ') });
    return;
  }

  // Нет готовых — проверяем есть ли что-то в ready/
  const readyDirTickets = readTickets(READY_DIR);
  if (readyDirTickets.length > 0) {
    console.log(`[INFO] No new ready tickets, but ready/ has ${readyDirTickets.length} ticket(s)`);
    printResult({ status: 'default', ready_tickets: '', demoted_tickets: demoted.join(', '), unblocked_tickets: unblocked.join(', '), superseded_tickets: superseded.join(', ') });
  } else {
    console.log('[INFO] No ready tickets and ready/ is empty');
    printResult({ status: 'empty', ready_tickets: '', demoted_tickets: demoted.join(', '), unblocked_tickets: unblocked.join(', '), superseded_tickets: superseded.join(', ') });
  }
}

// Запуск main() только при прямом вызове (не при импорте) — тот же приём, что в
// check-plan-templates.js. Пайплайн зовёт скрипт командой
// `node .workflow/src/scripts/check-conditions.js` (configs/pipeline.yaml), а импорт
// нужен тесту демотирования: без этой проверки импорт прогонял всю доску.
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('check-conditions.js') ||
  process.argv[1].endsWith('check-conditions')
);

if (isDirectRun) {
  main().catch(e => {
    console.error(`[ERROR] ${e.message}`);
    printResult({ status: 'error', error: e.message });
    process.exit(1);
  });
}
