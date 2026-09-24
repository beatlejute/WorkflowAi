/**
 * Тикет, который авто-блокировка правит на стадии review-result, обязан быть виден
 * читателю целиком — либо в прежнем виде, либо уже заблокированным. Пустого и
 * обрезанного промежутка быть не должно.
 *
 * Инцидент того же класса, что approval-файл ручного гейта и маркер запущенного
 * пайплайна: markBlockedTicket дописывал auto_blocked_* и клал результат обратно
 * одним writeFileSync поверх тикета. writeFileSync — это open(файл, 'w') плюс
 * запись вторым шагом: усечение происходит сразу, содержимое приходит позже.
 * В этом окне читатель получает тикет нулевой длины или обрезанный хвост.
 *
 * Цена: доску в этот момент сканируют pick-next-task (readTicketsFromDir),
 * check-conditions (readTickets), sync-ticket-status и check-anomalies — например
 * когда другой агент дёргает pick_next_ticket через MCP. Пустой тикет теряет
 * frontmatter целиком (id подставляется из имени файла, статус и parent_plan
 * пропадают), обрезанный теряет хвост тела — секцию Result, по которой
 * findCompletedInProgress решает, что тикет доделан. Тихая порча метаданных:
 * ни одна из этих функций не падает, все они просто считают неправду.
 * Окно доказано прогоном без единой правки боевого кода: конкурентный читатель
 * за 4 секунды получил 3 пустых и 23 обрезанных чтения из 275.
 *
 * Стенных часов в тесте нет: наблюдатель подменяет методы fs и снимает состояние
 * тикета глазами читателя после каждой мутации каталога.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/race-ticket-auto-block-atomic-write.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { markBlockedTicket, findTicketFile } from '../scripts/mark-blocked-core.js';
import { readTicketsFromDir } from '../scripts/pick-next-task-core.js';

const TICKET_ID = 'TASK-001';
// Хвост тела: по нему видно обрезанную запись. Тело крупное намеренно — чем
// больше содержимое, тем шире окно между усечением и записью.
const BODY_TAIL = 'КОНЕЦ-ТЕЛА-ТИКЕТА\n';

function ticketContent() {
  const filler = 'строка тела тикета, чтобы файл не влезал в один write. '.repeat(30);
  return `---\nid: "${TICKET_ID}"\ntitle: "Тикет для проверки атомарности"\nstatus: "review"\n---\n\n`
    + `## Описание\n\n${(filler + '\n').repeat(60)}\n${BODY_TAIL}`;
}

function createBoard() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-auto-block-'));
  const reviewDir = path.join(tmpDir, '.workflow', 'tickets', 'review');
  const stateDir = path.join(tmpDir, '.workflow', 'state');
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const ticketFile = path.join(reviewDir, `${TICKET_ID}-demo.md`);
  fs.writeFileSync(ticketFile, ticketContent(), 'utf8');
  return { tmpDir, reviewDir, stateDir, ticketFile, alertsFile: path.join(stateDir, 'alerts.jsonl') };
}

/**
 * Что видит читатель тикета прямо сейчас: 'нет файла', 'целый' или описание порчи.
 * Проверка та же, что делают боевые читатели: прочитать файл и разобрать frontmatter.
 */
function readerView(ticketFile) {
  if (!fs.existsSync(ticketFile)) return 'нет файла';
  const content = fs.readFileSync(ticketFile, 'utf8');
  if (content.length === 0) return 'пустой (0 байт)';
  if (!content.endsWith(BODY_TAIL)) return `обрезанный (${content.length} байт, хвост тела потерян)`;
  const { frontmatter } = parseFrontmatter(content);
  if (!frontmatter || frontmatter.id !== TICKET_ID) return 'без frontmatter (id пришлось бы брать из имени файла)';
  return 'целый';
}

// Мутации каталога, после которых читателю может открыться промежуточное состояние.
const MUTATORS = new Set([
  'renameSync', 'linkSync', 'unlinkSync', 'appendFileSync',
  'mkdirSync', 'copyFileSync', 'rmSync', 'truncateSync',
]);

/**
 * fs-наблюдатель. writeFileSync раскрывается в свои настоящие шаги —
 * open('w') (усечение) → write → close, — потому что окно живёт ВНУТРИ вызова
 * и снаружи неотличимо от атомарной записи.
 */
function createObserver(ticketFile) {
  const seen = [];
  const written = [];
  const observe = () => seen.push(readerView(ticketFile));

  const proxy = new Proxy(fs, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;

      if (prop === 'writeFileSync') {
        return (file, data, options) => {
          written.push(String(file));
          const encoding = typeof options === 'string' ? options : options?.encoding ?? 'utf8';
          const fd = target.openSync(file, 'w');
          observe();
          try {
            target.writeSync(fd, Buffer.from(String(data), encoding));
            observe();
          } finally {
            target.closeSync(fd);
          }
          observe();
        };
      }

      if (MUTATORS.has(prop)) {
        return (...args) => {
          const result = value.apply(target, args);
          observe();
          return result;
        };
      }

      return (...args) => value.apply(target, args);
    },
  });

  return { fs: proxy, seen, written };
}

test('авто-блокировка: читателю тикета ни в одной точке записи не виден пустой или обрезанный файл', () => {
  const board = createBoard();
  const observer = createObserver(board.ticketFile);

  try {
    markBlockedTicket({
      ticketId: TICKET_ID,
      attempts: 6,
      reason: 'нет прогресса за 6 попыток',
      ticketsDir: board.reviewDir,
      stateDir: board.stateDir,
      alertsFile: board.alertsFile,
      project: 'race-probe',
      fsModule: observer.fs,
    });

    const broken = observer.seen.filter((state) => state !== 'целый' && state !== 'нет файла');
    assert.deepEqual(
      broken,
      [],
      `между вызовами fs читатель видел испорченный тикет: ${broken.join('; ')}`,
    );

    const { frontmatter } = parseFrontmatter(fs.readFileSync(board.ticketFile, 'utf8'));
    assert.equal(frontmatter.auto_blocked_reason, 'нет прогресса за 6 попыток', 'работа должна быть сделана');
    assert.equal(frontmatter.id, TICKET_ID, 'frontmatter тикета не должен пострадать');
  } finally {
    fs.rmSync(board.tmpDir, { recursive: true, force: true });
  }
});

test('авто-блокировка: после записи в колонке тикетов не остаётся посторонних файлов', () => {
  const board = createBoard();
  try {
    markBlockedTicket({
      ticketId: TICKET_ID,
      attempts: 6,
      reason: 'нет прогресса',
      ticketsDir: board.reviewDir,
      stateDir: board.stateDir,
      alertsFile: board.alertsFile,
      project: 'race-probe',
    });

    const leftovers = fs.readdirSync(board.reviewDir).filter((name) => name !== `${TICKET_ID}-demo.md`);
    assert.deepEqual(leftovers, [], `в колонке остался мусор: ${leftovers.join(', ')}`);
  } finally {
    fs.rmSync(board.tmpDir, { recursive: true, force: true });
  }
});

test('авто-блокировка: временный файл записи не виден ни одному сканеру колонки тикетов', () => {
  const board = createBoard();
  const observer = createObserver(board.ticketFile);

  try {
    markBlockedTicket({
      ticketId: TICKET_ID,
      attempts: 6,
      reason: 'нет прогресса',
      ticketsDir: board.reviewDir,
      stateDir: board.stateDir,
      alertsFile: board.alertsFile,
      project: 'race-probe',
      fsModule: observer.fs,
    });

    // Имя временного файла берётся из самой записи, а не угадывается.
    const tempPaths = observer.written.filter((file) => file !== board.ticketFile);
    assert.equal(
      tempPaths.length,
      1,
      `ожидалась ровно одна запись во временный файл рядом с тикетом: ${observer.written.join(', ')}`,
    );
    const tempName = path.basename(tempPaths[0]);
    assert.equal(
      path.dirname(tempPaths[0]),
      board.reviewDir,
      'временный файл должен лежать на том же томе, рядом с тикетом',
    );

    // Осиротевший остаток мёртвого процесса лежит в колонке — доска обязана
    // читаться так, будто его нет.
    fs.writeFileSync(path.join(board.reviewDir, tempName), 'мусор от убитого процесса', 'utf8');

    assert.ok(!tempName.endsWith('.md'), `имя "${tempName}" подхватит любой сканер с фильтром .md`);
    assert.ok(tempName.startsWith('.'), `имя "${tempName}" подхватят сканеры, отсеивающие только точечные файлы`);

    const tickets = readTicketsFromDir({ fs }, board.reviewDir);
    assert.deepEqual(
      tickets.map((t) => t.id),
      [TICKET_ID],
      `pick-next-task увидел в колонке лишнее: ${tickets.map((t) => t.id).join(', ')}`,
    );

    assert.equal(
      findTicketFile(TICKET_ID, board.reviewDir),
      board.ticketFile,
      'поиск тикета по префиксу не должен наткнуться на временный файл',
    );
  } finally {
    fs.rmSync(board.tmpDir, { recursive: true, force: true });
  }
});
