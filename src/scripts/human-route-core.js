/**
 * Детерминированные маршруты ожидания и отказа ревью human-тикетов.
 * CLI-обёртки передают корень проекта и аргумент стадии.
 */

import path from 'node:path';
import fs from 'node:fs';
import { createTicketContext } from './pick-next-task-core.js';
import {
  parseFrontmatter,
  serializeFrontmatter,
  printResult,
  tempSiblingPath,
} from 'workflow-ai/lib/utils.mjs';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { approveOpenGates } from 'workflow-ai/lib/operations/tickets.mjs';

const STATUS_DIR_KEYS = [
  ['backlog', 'backlogDir'],
  ['ready', 'readyDir'],
  ['in-progress', 'inProgressDir'],
  ['blocked', 'blockedDir'],
  ['review', 'reviewDir'],
  ['done', 'doneDir'],
  ['archive', 'archiveDir'],
];

function diagnostic(ticketId, reason, message) {
  return {
    status: 'human_route_error',
    ticket_id: ticketId || '',
    reason,
    message,
  };
}

function humanAction(ticket, reason, message) {
  return {
    status: 'human_action_required',
    ticket_id: ticket.id,
    ticket_status: ticket.status,
    plan_id: ticket.frontmatter.parent_plan || '',
    reason,
    message,
  };
}

function validateTicketId(ticketId) {
  if (
    typeof ticketId !== 'string' ||
    !ticketId.trim() ||
    /[/\\\r\n\0]/.test(ticketId) ||
    ticketId === '.' ||
    ticketId === '..'
  ) {
    throw new Error('Не задан корректный ticket_id');
  }
}

/**
 * Читает точный файл тикета. Повторный поиск нужен, если тикет переместили
 * между поиском пути и чтением. Другие ошибки чтения не скрываются.
 */
export function readRoutingTicket(projectRoot, ticketId) {
  validateTicketId(ticketId);
  const ctx = createTicketContext(projectRoot);

  for (let attempt = 0; attempt < 2; attempt++) {
    const matches = STATUS_DIR_KEYS
      .map(([status, key]) => ({
        status,
        filePath: path.join(ctx[key], `${ticketId}.md`),
      }))
      .filter(({ filePath }) => ctx.fs.existsSync(filePath));

    if (matches.length === 0) {
      // Единственный оригинал мог остаться в резервной копии после падения
      // прошлой блокировки. Восстановить и искать заново: решает повторное
      // сканирование. Занятый слот (конкурент создал тикет между сканированием
      // и link) — тоже повторное сканирование, а не отказ (ревью Сола
      // 2026-10-05: иначе свежий тикет терялся за сообщением о ручном разборе).
      const recovery = recoverReviewBackup(ctx, ticketId);
      if (recovery === 'restored' || recovery === 'slot-taken') continue;
      if (recovery === 'locked') {
        throw new Error(
          `Тикет ${ticketId} не найден; в review есть резервная копия ` +
          `${backupPathFor(ctx, ticketId)} и замок ` +
          `${routeLockPath(ctx.reviewDir, ticketId)} — идёт операция ` +
          'маршрутизации или она погибла: удалите замок для восстановления',
        );
      }
      throw new Error(`Тикет ${ticketId} не найден`);
    }
    if (matches.length !== 1) {
      throw new Error(
        `Тикет ${ticketId} находится в нескольких колонках: ` +
        matches.map(({ status }) => status).join(', '),
      );
    }

    const match = matches[0];
    let content;
    try {
      content = ctx.fs.readFileSync(match.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' && attempt === 0) continue;
      throw error;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    if (
      !frontmatter ||
      typeof frontmatter !== 'object' ||
      Array.isArray(frontmatter) ||
      Object.keys(frontmatter).length === 0
    ) {
      throw new Error(`Тикет ${ticketId}: отсутствует frontmatter`);
    }
    if (frontmatter.id && frontmatter.id !== ticketId) {
      throw new Error(
        `Тикет ${ticketId}: frontmatter.id не совпадает с именем файла`,
      );
    }

    return {
      id: ticketId,
      status: match.status,
      filePath: match.filePath,
      blockedDir: ctx.blockedDir,
      frontmatter,
      body,
      content,
    };
  }

  throw new Error(`Не удалось прочитать тикет ${ticketId}`);
}

/**
 * type обозначает тип задачи, executor_type — исполнителя.
 * Поэтому type: qa + executor_type: human не является противоречием.
 * type: human + явно иной executor_type требует решения человека.
 */
export function classifyRoutingTicket(frontmatter) {
  if (
    frontmatter.type === 'human' &&
    frontmatter.executor_type &&
    frontmatter.executor_type !== 'human'
  ) {
    return 'conflict';
  }

  return frontmatter.type === 'human' ||
    frontmatter.executor_type === 'human'
    ? 'human'
    : 'agent';
}

export function routeHumanGate(projectRoot, ticketId) {
  try {
    const ticket = readRoutingTicket(projectRoot, ticketId);
    const kind = classifyRoutingTicket(ticket.frontmatter);

    if (kind === 'conflict') {
      return humanAction(
        ticket,
        'human_metadata_conflict',
        'Тип human противоречит executor_type; требуется уточнить исполнителя',
      );
    }
    if (kind !== 'human') {
      return diagnostic(
        ticketId,
        'not_human_ticket',
        `Тикет ${ticketId} больше не является human-тикетом`,
      );
    }

    if (['review', 'done', 'archive'].includes(ticket.status)) {
      return {
        status: 'continue',
        ticket_id: ticket.id,
        ticket_status: ticket.status,
      };
    }

    if (['ready', 'in-progress'].includes(ticket.status)) {
      return humanAction(
        ticket,
        'human_result_not_submitted',
        'Результат ещё не передан; заполните результат и передайте тикет в review',
      );
    }

    if (ticket.status === 'blocked') {
      return humanAction(
        ticket,
        'human_ticket_blocked',
        'Тикет заблокирован: ' +
        (ticket.frontmatter.blocked_reason || 'причина не указана'),
      );
    }

    return humanAction(
      ticket,
      'human_ticket_backlog',
      'Тикет возвращён в backlog; требуется решение человека о продолжении',
    );
  } catch (error) {
    return diagnostic(ticketId, 'ticket_read_error', error.message);
  }
}

/**
 * Отказ ревью human-тикету → блокировка одной защищённой операцией.
 * Ревью 2026-10-04/05 (Сол): replaceFileAtomic воссоздавал файл в review/
 * (rename поверх исчезнувшего пути проходит), а прямая запись в единственный
 * файл портила его при частичной записи. Здесь исходный файл не пишется вовсе:
 *  1. сравнение с raw-снимком — правка или переезд до старта дают changed;
 *  2. новое содержимое пишется в temp (dot-файл с хвостом .tmp — невидим
 *     сканерам колонок и artifact-snapshot); сбой диска не трогает тикет;
 *  3. оригинал атомарным rename уезжает в резервную копию (захват слота).
 *     Именно rename, не link+unlink: сохранение редактора между link и
 *     unlink атомарно подменяет файл, и unlink удалял бы свежую правку
 *     (ревью Сола 2026-10-05, проба на Windows). rename перевозит
 *     актуальное содержимое целиком — правка уезжает вместе с файлом и
 *     ловится сверкой копии;
 *  4. содержимое копии сверяется со снимком: правка, уехавшая в захват,
 *     возвращается на место, маршрут даёт changed;
 *  5. temp становится blocked-тикетом эксклюзивным link (существующий не
 *     заменяется); отказ уборки temp после успешного link откатом не
 *     является — blocked уже создан. При сбое создания оригинал
 *     возвращается из копии, ошибка называет её путь — единственный
 *     оригинал не теряется;
 *  6. сверённая копия удаляется последней — сбой процесса до этого
 *     оставляет копию с детерминированным именем: её возвращает
 *     recoverReviewBackup при следующем чтении тикета (см. readRoutingTicket)
 *     или человек по имени файла.
 * Одновременные запуски маршрутизации одного тикета — единственные писатели
 * копии — сериализуются замком `<id>.md.route-lock` ('wx', угонов нет: замок
 * существует — маршрут отказывает, погибший запуск разрешается удалением
 * замка), поэтому rename в шаге 3 не может заменить чужую копию, а link в
 * шаге 5 — чужой blocked-тикет. Правка или создание тикета
 * редактором/конкурентом без замка между захватом (3) и созданием (5)
 * даёт дубль в двух колонках, который ловит проверка «в нескольких
 * колонках» при следующем чтении, — тихой потери нет.
 * Возвращает { changed: true }, если тикет ушёл из-под маршрута, либо
 * { targetPath } после успешной блокировки.
 */
/**
 * Остатки temp-файлов невидимы сканерам колонок и не мешают работе, а свежие
 * файлы на Windows держит антивирус (EPERM на удалении до секунды) — очистка
 * только best-effort, сбой уборки не превращает успешную операцию в ошибку.
 */
function bestEffortRemove(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Оставляем файл уборке следующего запуска/человека.
  }
}

/**
 * Резервная копия оригинала на время блокировки. Имя детерминировано и несёт
 * id тикета (не TEMP-мусор: восстановление вручную — по имени, автоматически —
 * readRoutingTicket при следующем чтении), и при этом не кончается на `.md`,
 * чтобы сканеры колонок не приняли копию за тикет.
 */
export const TICKET_BACKUP_SUFFIX = '.review-block-bak';

/**
 * Замок маршрутизации одного тикета (`<id>.md.route-lock`): сериализует
 * одновременные запуски — единственных писателей резервной копии. Захват
 * через 'wx', угонов нет: пока замок существует, его содержимое не проверяют
 * и не удаляют чужие процессы, поэтому освобождение по имени удаляет ровно
 * свой замок. Погибший запуск (падение с замком) блокирует маршрут до
 * ручного удаления — отказ называет файл.
 */
function routeLockPath(reviewDir, ticketId) {
  return path.join(reviewDir, `${ticketId}.md.route-lock`);
}

/**
 * Возраст замка для диагностики отказа; угоном не служит.
 */
const ROUTE_LOCK_STALE_MS = 60 * 1000;

function backupPathFor(ctx, ticketId) {
  return path.join(ctx.reviewDir, `${ticketId}.md${TICKET_BACKUP_SUFFIX}`);
}

/**
 * Падение прошлого запуска между захватом оригинала и созданием blocked
 * оставляет единственную копию тикета в резервном файле: вернуть её в review.
 * Только эксклюзивный link: rename заменил бы тикет, созданный конкурентом
 * между проверкой и переездом (ревью Сола 2026-10-05, проба на Windows); и
 * именно EEXIST от link — признак занятого слота, отдельной проверки перед
 * link нет, чтобы окно «появился после проверки» не возвращалось.
 * При живом или погибшем замке маршрутизации копию не трогаем: восстановление
 * во время активной операции срывало её, а погибшую операцию сначала разрешает
 * удаление замка (ревью Сола 2026-10-05, проба).
 * Возвращает причину: restored — копия возвращена в review; slot-taken —
 * слот review занят (конкурент): копия сохранена; locked — операция под
 * замком, копия сохранена; nothing — копии нет.
 */
export function recoverReviewBackup(ctx, ticketId) {
  const backupPath = backupPathFor(ctx, ticketId);
  const reviewPath = path.join(ctx.reviewDir, `${ticketId}.md`);
  if (ctx.fs.existsSync(routeLockPath(ctx.reviewDir, ticketId))) {
    return 'locked';
  }
  if (!ctx.fs.existsSync(backupPath)) {
    return 'nothing';
  }
  try {
    fs.linkSync(backupPath, reviewPath);
  } catch (error) {
    if (error.code === 'EEXIST') return 'slot-taken'; // слот занял конкурент
    throw error;
  }
  fs.unlinkSync(backupPath);
  return 'restored';
}

export function blockHumanTicket(ticket, reason) {
  const frontmatter = {
    ...ticket.frontmatter,
    blocked_reason: `${reason}: требуется уточнить результат по последнему отказу ревью`,
    updated_at: new Date().toISOString(),
  };
  const content = serializeFrontmatter(frontmatter) + ticket.body;
  const reviewDir = path.dirname(ticket.filePath);
  const targetPath = path.join(ticket.blockedDir, `${ticket.id}.md`);
  const tempPath = tempSiblingPath(ticket.filePath);
  const bakPath = backupPathFor({ reviewDir }, ticket.id);
  const lockPath = path.join(reviewDir, `${ticket.id}.md.route-lock`);

  // Замк сериализует одновременные запуски маршрутизации одного тикета —
  // единственного писателя резервной копии. Захват через 'wx', угонов нет:
  // удаление чужого или «протухшего» замка открывало окно, в котором под
  // именем оказывался свежий замок другого процесса (ревью Сола 2026-10-05).
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let staleHint = '';
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > ROUTE_LOCK_STALE_MS) {
        staleHint =
          ' (замок старше минуты — вероятно, погибший запуск; ' +
          'удалите файл, чтобы продолжить)';
      }
    } catch {
      // Замок исчез между open и stat — решит повторная проверка.
    }
    if (fs.existsSync(lockPath)) {
      throw new Error(
        `Маршрутизация тикета уже выполняется другим процессом` +
        `${staleHint} — замок ${lockPath}`,
      );
    }
    // Замок исчез: повторный захват; если слот снова заняли, EEXIST уйдёт
    // в диагностический маршрут как есть.
    lockFd = fs.openSync(lockPath, 'wx');
  }
  try {
    fs.writeSync(lockFd, String(process.pid));
  } catch {
    // Пустой замок тоже работает: важен сам файл.
  }

  try {
    return blockHumanTicketLocked(ticket, reason, {
      content, reviewDir, targetPath, tempPath, bakPath,
    });
  } finally {
    try {
      fs.closeSync(lockFd);
    } catch {
      // closeSync падает только на уже закрытом дескрипторе.
    }
    bestEffortRemove(lockPath);
  }
}

function blockHumanTicketLocked(ticket, reason, paths) {
  const { content, targetPath, tempPath, bakPath } = paths;

  // Прошлый запуск мог упасть между захватом и созданием blocked: сначала
  // возвращаем его оригинал, иначе захватил бы пустоту.
  if (fs.existsSync(bakPath)) {
    if (fs.existsSync(ticket.filePath)) {
      throw new Error(
        `В review лежат и тикет ${ticket.filePath}, и резервная копия ` +
        `${bakPath} — требуется ручной разбор`,
      );
    }
    try {
      fs.linkSync(bakPath, ticket.filePath);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(
          `Слот review занял конкурент, резервная копия осталась в ${bakPath}`,
        );
      }
      throw new Error(`Не удалось вернуть резервную копию ${bakPath}: ${error.message}`);
    }
    fs.unlinkSync(bakPath);
  }

  // Сбой возврата оригинала — не безымянная ошибка: сообщение называет файл
  // единственной копии. Только эксклюзивный link: rename заменил бы тикет,
  // воссозданный человеком в пустом слоте.
  const restoreOriginal = () => {
    try {
      fs.linkSync(bakPath, ticket.filePath);
    } catch (restoreError) {
      if (restoreError.code === 'EEXIST') {
        throw new Error(
          `Слот review занял конкурент, оригинал сохранён в ${bakPath}`,
        );
      }
      throw new Error(
        `Не удалось вернуть тикет на место; оригинал сохранён в ` +
        `${bakPath}: ${restoreError.message}`,
      );
    }
    bestEffortRemove(bakPath);
  };

  let current;
  try {
    current = fs.readFileSync(ticket.filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { changed: true };
    throw error;
  }
  if (current !== ticket.content) {
    return { changed: true };
  }

  fs.mkdirSync(ticket.blockedDir, { recursive: true });
  fs.writeFileSync(tempPath, content);

  // Захват — атомарный rename (ревью Сола 2026-10-05: link+unlink в захвате
  // удалял свежую правку редактора, сохранившую файл между link и unlink).
  // rename перевозит актуальное содержимое целиком: правка, вклинившаяся до
  // него, уезжает вместе с файлом и ловится сверкой копии, правка после —
  // воссоздаёт слот и детектируется на следующем чтении. Одновременный
  // запуск маршрутизации исключён замком, поэтому существующую копию rename
  // заменить не может. Слот пуст, так что rename работает как перенос.
  try {
    fs.renameSync(ticket.filePath, bakPath);
  } catch (error) {
    bestEffortRemove(tempPath);
    if (error.code === 'ENOENT') return { changed: true };
    throw error;
  }

  try {
    const claimed = fs.readFileSync(bakPath, 'utf8');
    if (claimed !== ticket.content) {
      restoreOriginal();
      bestEffortRemove(tempPath);
      return { changed: true };
    }
  } catch (error) {
    restoreOriginal();
    bestEffortRemove(tempPath);
    throw error;
  }

  // Создание blocked — эксклюзивный link: rename заменил бы тикет,
  // созданный конкурентом. Отказ уборки temp после успешного link откатом
  // не является: blocked уже существует (ревью Сола 2026-10-05).
  try {
    fs.linkSync(tempPath, targetPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      restoreOriginal();
      bestEffortRemove(tempPath);
      throw new Error(
        `Тикет ${targetPath} уже создан конкурентом; оригинал возвращён в review`,
      );
    }
    restoreOriginal();
    bestEffortRemove(tempPath);
    throw error;
  }
  bestEffortRemove(tempPath);
  bestEffortRemove(bakPath);

  return { targetPath };
}

/**
 * Отказ ревью не означает новую попытку человеческого исполнения.
 * Агентский тикет возвращается существующему счётчику попыток.
 */
export async function routeReviewFailure(projectRoot, ticketId) {
  try {
    const ticket = readRoutingTicket(projectRoot, ticketId);
    const kind = classifyRoutingTicket(ticket.frontmatter);

    if (kind === 'conflict') {
      return humanAction(
        ticket,
        'human_metadata_conflict',
        'Тип human противоречит executor_type; требуется уточнить исполнителя',
      );
    }

    // Не применяем отказ старого ревью к тикету, уже сменившему состояние.
    if (ticket.status !== 'review') {
      if (kind === 'human') {
        return humanAction(
          ticket,
          'human_review_state_changed',
          `После отказа ревью тикет находится в ${ticket.status}; ` +
          'автоматическое перемещение не выполнено',
        );
      }

      return diagnostic(
        ticketId,
        'review_state_changed',
        `После отказа ревью тикет находится в ${ticket.status}, а не в review`,
      );
    }

    if (kind === 'agent') {
      return {
        status: 'agent_failed',
        ticket_id: ticket.id,
        ticket_status: ticket.status,
      };
    }

    const reason = 'human_review_failed';

    // Причина, запись и переезд review → blocked — одна защищённая операция
    // (blockHumanTicket). Результат, DoD и запись решения человека не
    // переписываются.
    let blocked;
    try {
      blocked = blockHumanTicket(ticket, reason);
    } catch (error) {
      return diagnostic(
        ticketId,
        'review_failure_route_error',
        `Не удалось заблокировать тикет: ${error.message}`,
      );
    }
    if (blocked.changed) {
      return humanAction(
        ticket,
        'human_review_state_changed',
        'Пока маршрут работал, тикет изменён или перемещён человеком; ' +
        'автоматическое перемещение не выполнено',
      );
    }

    // Гейты открывает само перемещение — как в moveTicket; тикетные файлы
    // эта операция не трогает.
    await approveOpenGates(projectRoot, ticket.id, 'blocked');

    return humanAction(
      { ...ticket, status: 'blocked' },
      reason,
      'Ревью человеческого результата отклонено; тикет заблокирован ' +
      'до уточнения человеком. Решение и отметки DoD сохранены',
    );
  } catch (error) {
    return diagnostic(ticketId, 'review_failure_route_error', error.message);
  }
}

/**
 * Агент-скрипт получает промпт стадии через stdin (prompt_stdin: true у агента
 * в конфиге); для ручной диагностики допускается прямой аргумент ticket_id.
 */
function ticketIdFromStdin(input) {
  const match = String(input).match(/^[ \t]*ticket_id:[ \t]*(.+?)[ \t]*$/m);
  if (!match) throw new Error('В Context из stdin отсутствует ticket_id');
  return match[1].replace(/^["']|["']$/g, '');
}

export function ticketIdFromArgs(args) {
  if (args.length !== 1) {
    throw new Error('Ожидается ticket_id или один промпт стадии');
  }

  const value = args[0];
  if (!/\bContext:/.test(value)) return value.trim();

  const context = value.split(/\bContext:/, 2)[1]
    .split(/^\s*(?:Counters|Instructions):/m, 1)[0];
  const match = context.match(/^[ \t]*ticket_id:[ \t]*(.+?)[ \t]*$/m);
  if (!match) throw new Error('В Context отсутствует ticket_id');

  return match[1].replace(/^["']|["']$/g, '');
}

/**
 * Промпт стадии раннер кладёт в stdin и закрывает поток (stdin.end() после
 * записи). Синхронное readFileSync(0) на Windows-пайпе возвращает пустоту
 * (2026-10-04: проверено spawnSync-пробами), поэтому читаем асинхронно —
 * и ждём конца потока: разбор частичного ввода даёт усечённый ticket_id,
 * а таймаут без конца потока — ошибка чтения, не префикс (ревью Сола
 * 2026-10-04). Порог для тестов переопределяется переменной окружения.
 */
function stdinTimeoutMs() {
  const raw = Number(process.env.HUMAN_ROUTE_STDIN_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : 10000;
}

function readStdinAsync() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        // Открытый пайп держит цикл событий: без destroy процесс-сирота
        // пережил бы напечатанный результат.
        process.stdin.destroy?.();
        reject(error);
      } else {
        resolve(data);
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`stdin не закрыт за ${stdinTimeoutMs()} мс`)),
      stdinTimeoutMs(),
    );
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => finish());
    process.stdin.on('error', finish);
  });
}

export async function runRoutingCli(route) {
  let ticketId = '';
  try {
    const args = process.argv.slice(2);
    ticketId = args.length > 0
      ? ticketIdFromArgs(args)
      : ticketIdFromStdin(await readStdinAsync());
    const result = await route(findProjectRoot(), ticketId);
    printResult(result);
  } catch (error) {
    printResult(diagnostic(ticketId, 'route_input_error', error.message));
  }
}
