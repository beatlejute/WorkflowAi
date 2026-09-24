import YAML from './js-yaml.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';

// ============================================================================
// Публикация файла-артефакта: читателю виден прежний файл целиком или новый
// целиком. «Никогда пустой» здесь не обещано — где именно инвариант кончается,
// написано у запасного пути в replaceFileAtomicSync.
// ============================================================================

// Почему это вообще нужно. `writeFileSync(p, c)` открывает файл с флагом 'w',
// а это сначала обрезает его до нуля и только потом пишет содержимое. Всё, что
// между, — окно, в котором файл существует нулевой длины.
//
// Замер на этой машине (win32, NTFS; один посторонний читатель в тесном цикле,
// писатель обновляет тикет 200 раз, никаких искусственных задержек):
//   прямая запись  — 30 пустых и 1 обрезанное чтение из 469    (6,6 % чтений);
//   temp + rename  — 7 пустых и 5 обрезанных чтений из 24107    (0,05 % чтений).
// Ноль во второй строке не стоит, и это не погрешность: остаток — цена запасного
// пути, см. replaceFileAtomicSync.
//
// Цена пустого чтения выше, чем у ошибки: `parseFrontmatter('')` не бросает, а
// возвращает `{ frontmatter: {}, body: '' }`. Тикет с пустым frontmatter
// проходит дальше как тикет без зависимостей и без статуса, план без id и
// заголовка уезжает в MCP `get_plan` как нормальный ответ. Ни строки в журнале.
//
// Дальше — правила выбора операции и то, что за ними стоит на NTFS (всё
// проверено запуском, см. комментарии у каждой):
//   * замена содержимого существующего файла — rename поверх;
//   * создание файла, который никто не имеет права перезаписать, — link.

/** Коды, которыми NTFS отвечает на rename поверх файла, открытого читателем. */
const RENAME_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Лестница пауз перед повтором rename. Хвост лестницы — не запас на всякий
// случай, он делает основную работу. Замер на этой машине (NTFS, один читатель в
// тесном цикле ~12000 чтений/с, писатель 200 раз) — сколько повторов
// потребовалось до успеха:
//   0:12  1:19  2:17  3:25  4:24  5:18  6:19, лестницу исчерпали 66 публикаций.
// То есть повторы 3…6 (паузы 5, 10, 20 и 50 мс) спасли 86 публикаций из 188, не
// прошедших с первой попытки. Лестница [0,1,2,5,10] даёт 98 исчерпаний из 200
// вместо 66, лестница до 500 мс (888 мс суммой) — 24 из 200. Кривая плавная,
// порога, за которым отказы кончаются, нет; 88 мс выбраны как предел, который
// человек на перемещении тикета ещё не замечает.
//
// Боевые читатели держат файл открытым на порядки реже тестового: readFileSync —
// это десятки микросекунд, а pick-next-task читает колонку раз в стадию. Поэтому
// нулевая первая пауза — обычный случай, а не оптимизм.
//
// Где лестница не платится вовсе: rename на СВОБОДНОЕ имя открытого файла не
// встречает и EPERM не даёт. Поэтому циклы по тикетам — archiveTicketsOfArchivedPlans
// и autoCorrectTickets в src/scripts/pick-next-task.js, архивный цикл
// checkAndClosePlan ниже — ждут ноль: 300 публикаций на свободные имена под двумя
// сканерами каталога дали 0 срабатываний лестницы и 1502 мс на всё (проверено
// запуском). Ждать может только замена на месте: тикет после переезда, план при
// закрытии, approval-файл гейта, авто-блокировка — по одной публикации на
// операцию, ни одна не в цикле по доске.
const RENAME_RETRY_DELAYS_MS = [0, 1, 2, 5, 10, 20, 50];

/**
 * Полный бюджет ожидания одной публикации — сумма лестницы.
 *
 * Названа отдельно и вывешена наружу не для красоты. sleepSync — это
 * Atomics.wait на главном потоке: за эту паузу в процессе не выполняется ВООБЩЕ
 * ничего, ни таймер, ни ввод-вывод. Такой потолок обязан быть на виду, и
 * src/tests/race-ticket-file-atomic-content.test.mjs сверяет его с лестницей —
 * чтобы правка лестницы не подняла цену молча.
 */
export const RENAME_RETRY_BUDGET_MS = RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);

/**
 * Текст про несостоявшуюся атомарность.
 *
 * Сообщение называет и причину, и следствие: читать «не удалось переименовать»
 * и догадываться, что при этом файл всё-таки записан и в окне записи виден
 * пустым, — не работа читателя журнала.
 *
 * @param {string} filePath - Путь к артефакту, который пришлось записать напрямую
 * @returns {string}
 */
function fallbackWarning(filePath) {
  return `[WARN] atomic-publish: ${path.basename(filePath)} записан НЕ атомарно — ` +
    `${RENAME_RETRY_DELAYS_MS.length} попыток замены за ${RENAME_RETRY_BUDGET_MS} мс отклонены ` +
    '(файл держит открытым другой процесс), запись сделана напрямую. ' +
    'На время этой записи файл виден читателю пустым. Повторяется на каждой публикации — ' +
    'значит сосед держит файл открытым дольше бюджета, и его надо искать.';
}

/** Блокирующая пауза: publish-функции синхронные, ждать событийным циклом негде. */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Предел длины одного компонента пути. Проверено запуском на этой машине
 * (win32, NTFS): имя в 255 символов создаётся, в 256 — ENOENT, причём полный
 * путь в обоих случаях длиннее 300 символов. То есть упирается именно компонент,
 * а не путь, и запас по общей длине пути делу не помогает.
 */
const MAX_PATH_COMPONENT = 255;

/**
 * Имя временного файла рядом с артефактом: `.<имя артефакта>.<pid>.<hex>.tmp`.
 *
 * Требование к имени одно и оно жёсткое: ни одно сканирование каталога не
 * должно принять временный файл за артефакт. Точка в начале отсекает его у тех,
 * кто фильтрует `!f.startsWith('.')`; отсутствие хвоста `.md` — у всех
 * остальных (`f.endsWith('.md')`, `^PREFIX-\d+\.md$`, поиск тикета по
 * `startsWith(id) && endsWith('.md')`); хвост `.tmp` — у снимка артефактов
 * (см. ниже). Разбирает это имя обратно parsePublishTempName.
 *
 * pid и случайный хвост дают уникальность и называют владельца файла. Но
 * УБОРЩИКА у этих имён нет ни одного, и утверждать обратное нельзя: единственный
 * уборщик остатков в проекте — sweepApprovalTmpLeftovers в src/runner.mjs, а его
 * шаблон `^\.approval-tmp\.(\d+)\.[0-9a-f]+$` имена такой формы не покрывает.
 * Значит остаток процесса, убитого между записью временного файла и его
 * публикацией, лежит в plans/ и tickets/ до тех пор, пока его не уберут руками.
 * Проверено запуском: дочерний процесс, убитый SIGKILL в этом окне, оставил файл
 * в plans/current навсегда.
 *
 * Почему с этим живём. Боевые сканирования каталогов тикетов и планов остаток
 * не видят: они фильтруют `f.endsWith('.md')` (проверено обходом всех readdir в
 * src/lib, src/scripts, src/runner.mjs, src/init.mjs), listPlans лишнего плана
 * не показывает, а git его не покажет тем более — `workflow init` кладёт в
 * .gitignore весь `.workflow/` (src/init.mjs, updateGitignore; проверено через
 * git check-ignore).
 *
 * Одно сканирование фильтра `.md` всё же не имеет, и именно из-за него `.tmp`
 * стоит в конце имени, а не в середине. src/lib/artifact-snapshot.mjs обходит
 * `.workflow/tickets` и `.workflow/plans` целиком, без фильтра по расширению, и
 * при прежней форме имени («.IMPL-001.md.tmp.<pid>.<hex>») остаток попадал в его
 * diff как СОЗДАННЫЙ артефакт — то есть verify-artifacts объявлял артефакты
 * изменёнными на пустом месте. Проверено запуском обеих форм подряд: прежняя дала
 * `created: [".workflow/tickets/in-progress/.IMPL-001.md.tmp.99999.deadbeef1234"]`,
 * нынешняя — пустой diff. В списке исключений того же модуля уже стоит глоб
 * `*.tmp` под префиксом из двух звёздочек, и ему не хватало ровно хвоста: глоб
 * требует конца строки. Охраняет это
 * src/tests/race-ticket-file-atomic-content.test.mjs («временный файл не виден и
 * снимку артефактов»).
 *
 * Уборщика по-прежнему нет, и заводить его на пути публикации нечестно: он стоил
 * бы readdir + stat на КАЖДУЮ запись, а цена approval-хука зафиксирована в
 * src/tests/perf-approval-hook-latency.test.mjs ровно пятью обращениями к диску.
 * pid в имени оставлен как готовый первый признак владельца — тот же, на котором
 * построен approval-уборщик, — но пока уборщика нет, читать имя приходится
 * глазами.
 *
 * Имя артефакта в середине — только удобство отладки, и поэтому оно первое, что
 * урезается: суффикс `.<pid>.<hex>.tmp` добавляет к имени ещё ~24 символа, а
 * id тикета бывает длиной больше 200 (src/tests/edge-ticket-id-long.test.mjs).
 * Без бюджета имя выходило за предел компонента, временный файл не создавался и
 * запись падала ENOENT ровно там, где прямая запись раньше проходила. Цена этого
 * проверена запуском: у moveTicket порог начинался с id в 229 символов, и тикет
 * оставался в новой колонке со старым updated_at, а manual-gate — неподтверждённым,
 * потому что бросок стоит ПОСЛЕ переезда файла и ДО approveOpenGates;
 * у checkAndClosePlan ENOENT глотал `catch (_)`, и тикет молча оставался в done/
 * с пустым archived в ответе.
 *
 * @param {string} filePath - Путь к артефакту
 * @param {string} [dir] - Каталог для временного файла (по умолчанию — каталог артефакта)
 * @returns {string}
 */
export function tempSiblingPath(filePath, dir) {
  const baseDir = dir || path.dirname(filePath);
  const suffix = `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  // Неприкосновенны две части: точка в начале (отсекает файл от сканеров,
  // фильтрующих `startsWith('.')`) и хвост `.tmp` (под него настроено исключение
  // `**/*.tmp` в artifact-snapshot). Уникальность держат pid и случайный хвост,
  // поэтому урезание имени артефакта столкновения не создаёт.
  const budget = MAX_PATH_COMPONENT - 1 - suffix.length;
  const base = path.basename(filePath).slice(0, Math.max(0, budget));
  return path.join(baseDir, `.${base}${suffix}`);
}

/**
 * Шаблон временного имени публикации: `.<имя артефакта>.<pid>.<12 hex>.tmp`.
 * Конец строки в шаблоне обязателен — иначе под него попал бы любой файл,
 * начинающийся так же.
 */
const PUBLISH_TEMP_NAME_RE = /^\..*\.(\d+)\.[0-9a-f]{12}\.tmp$/;

/**
 * Временное ли это имя публикации (и чей pid в нём).
 *
 * Экспортируется для тестов: проверка «в каталоге не осталось мусора» обязана
 * спрашивать форму имени у самого помощника, а не повторять шаблон руками. Пока
 * она повторяла его руками (`f.includes('.tmp.')`), правка имени сделала бы её
 * не красной, а бессмысленно зелёной — фильтр просто перестал бы совпадать.
 *
 * @param {string} name - Имя файла без каталога
 * @returns {{ pid: number } | null} null — имя не временное
 */
export function parsePublishTempName(name) {
  const match = PUBLISH_TEMP_NAME_RE.exec(name);
  return match ? { pid: Number(match[1]) } : null;
}

/**
 * Имя временного файла для записи решения в approval-файл.
 *
 * Лежит в `.workflow`, а не в `.workflow/approvals`: том тот же (link и rename
 * между томами не работают), но каталог гейтов остаётся чистым — ни шаблон
 * `^<ticket>_manual-gate-.*_\d+\.json$`, ни `readdirSync(approvals)[0]` в тестах
 * временный файл не увидят.
 *
 * Форма имени `.approval-tmp.<pid>.<hex>` выбрана не произвольно: под неё
 * настроен уборщик остатков умерших прогонов в src/runner.mjs
 * (`APPROVAL_TMP_NAME_RE`, `sweepApprovalTmpLeftovers`). Менять её здесь в
 * одиночку нельзя — мусор перестанет убираться, и никто этого не заметит.
 *
 * @param {string} workflowDir - Каталог .workflow проекта
 * @returns {string}
 */
export function approvalTempPath(workflowDir) {
  return path.join(workflowDir, `.approval-tmp.${process.pid}.${randomBytes(6).toString('hex')}`);
}

/**
 * Заменяет содержимое файла целиком: читателю виден либо прежний файл, либо новый.
 *
 * Операция — rename поверх, а не link: файл уже существует, перезапись здесь
 * норма, а link на занятом имени упал бы с EEXIST и сломал бы штатный путь.
 *
 * Повторы. На NTFS rename поверх файла, который другой процесс держит открытым,
 * падает с EPERM — проверено запуском: `renameSync(tmp, dst)` при живом
 * `openSync(dst, 'r')` даёт EPERM, тогда как `writeFileSync(dst, ...)` в тех же
 * условиях проходит. То есть наивная замена rename'ом не закрывает окно, а
 * меняет его на новый отказ. Поэтому rename повторяется по лестнице пауз.
 *
 * Запасной путь. Если лестница исчерпана, пишем как раньше — прямой записью, и
 * это возвращает старое окно целиком. Выбор в пользу записи, а не отказа, сделан
 * потому, что отказ здесь дороже: для перемещения тикета он означал бы тикет в
 * новой папке со старым frontmatter (тот самый фантомный статус из FIX-69), а
 * для approval-файла — потерянное решение человека.
 *
 * Чего про запасной путь говорить НЕЛЬЗЯ — «это редкий случай» и «хуже прежнего
 * не становится». Проверено запуском: пока сосед держит файл открытым дольше
 * лестницы (88 мс суммой), запасным путём идут ВСЕ публикации подряд — 20 из 20,
 * — и окно возвращается полностью. По времени тоже хуже: та же двадцатка стоила
 * 3146 мс, то есть ~157 мс на публикацию против 1.92 мс в обычном случае
 * (300 публикаций за 576 мс, из них запасным путём ни одна). Одинаково с прежним
 * кодом здесь только одно — содержимое файла в конце.
 *
 * Поэтому запасной путь обязан быть слышен. `{ atomic: false }` для этого не
 * годится: поле не смотрит ни один из вызывающих (проверено grep-ом по src/), и
 * деградация проходила бы молча. Сообщение уходит в `warn` (по умолчанию
 * console.warn, то есть stderr — stdout у скриптов занят JSON-ответом).
 *
 * @param {string} filePath - Путь к артефакту
 * @param {string} content - Новое содержимое целиком
 * @param {object} [options]
 * @param {object} [options.fsModule] - модуль fs (подмена в тестах и замерах)
 * @param {string} [options.tmpPath] - путь временного файла (по умолчанию — рядом с артефактом)
 * @param {(message: string) => void} [options.warn] - приёмник сообщения о неатомарной записи
 * @returns {{ atomic: boolean }} atomic:false — сработал запасной путь прямой записи
 */
export function replaceFileAtomicSync(filePath, content, { fsModule = fs, tmpPath, warn = console.warn } = {}) {
  // Подменённый в тесте fs бывает урезанным (только read/write/readdir). Гонки в
  // выдуманной файловой системе нет, поэтому там честнее писать напрямую, чем
  // падать на отсутствующем методе. Это не деградация, а отсутствие предмета
  // защиты, поэтому и предупреждения здесь нет.
  if (typeof fsModule.renameSync !== 'function') {
    fsModule.writeFileSync(filePath, content, 'utf8');
    return { atomic: false };
  }

  const tempPath = tmpPath || tempSiblingPath(filePath);
  fsModule.writeFileSync(tempPath, content, 'utf8');

  for (let attempt = 0; attempt < RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      fsModule.renameSync(tempPath, filePath);
      return { atomic: true };
    } catch (err) {
      if (!RENAME_BUSY_CODES.has(err.code)) {
        try { fsModule.unlinkSync(tempPath); } catch { /* уже нет — не мешает */ }
        throw err;
      }
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }

  try { fsModule.unlinkSync(tempPath); } catch { /* уже нет — не мешает */ }
  fsModule.writeFileSync(filePath, content, 'utf8');
  warn(fallbackWarning(filePath));
  return { atomic: false };
}

/**
 * То же самое для асинхронных вызывающих (fs.promises). Про запасной путь и про
 * то, почему он обязан быть слышен, — в комментарии к replaceFileAtomicSync.
 *
 * @param {string} filePath - Путь к артефакту
 * @param {string} content - Новое содержимое целиком
 * @param {object} [options]
 * @param {string} [options.tmpPath] - путь временного файла
 * @param {(message: string) => void} [options.warn] - приёмник сообщения о неатомарной записи
 * @returns {Promise<{ atomic: boolean }>}
 */
export async function replaceFileAtomic(filePath, content, { tmpPath, warn = console.warn } = {}) {
  const tempPath = tmpPath || tempSiblingPath(filePath);
  await fs.promises.writeFile(tempPath, content, 'utf8');

  for (let attempt = 0; attempt < RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await fs.promises.rename(tempPath, filePath);
      return { atomic: true };
    } catch (err) {
      if (!RENAME_BUSY_CODES.has(err.code)) {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw err;
      }
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  await fs.promises.unlink(tempPath).catch(() => {});
  await fs.promises.writeFile(filePath, content, 'utf8');
  warn(fallbackWarning(filePath));
  return { atomic: false };
}

/**
 * Создаёт файл, которого ещё не было: содержимое появляется под финальным
 * именем одной операцией, а занятое имя отсекается отказом.
 *
 * Операция — link, а не rename: link на занятом имени падает с EEXIST
 * (проверено запуском на NTFS) и этим сохраняет эксклюзивность создания, тогда
 * как rename молча затёр бы чужой файл. Для плана, чей номер выдан сканированием
 * каталога, «молча затёр» означает потерянный план соседнего прогона.
 *
 * Запасной путь через rename — для файловых систем без жёстких ссылок
 * (EXDEV/ENOTSUP/EPERM/ENOSYS): содержимое там тоже видно целиком, но
 * эксклюзивность приходится проверять отдельной проверкой существования.
 *
 * @param {string} filePath - Путь к создаваемому файлу
 * @param {string} content - Содержимое целиком
 * @param {object} [options]
 * @param {object} [options.fsModule] - модуль fs (подмена в тестах)
 * @param {string} [options.tmpPath] - путь временного файла
 * @throws {Error} с code 'EEXIST', если имя уже занято
 */
export function createFileExclusiveSync(filePath, content, { fsModule = fs, tmpPath } = {}) {
  const tempPath = tmpPath || tempSiblingPath(filePath);
  fsModule.writeFileSync(tempPath, content, 'utf8');

  try {
    try {
      fsModule.linkSync(tempPath, filePath);
      return;
    } catch (linkErr) {
      if (linkErr.code === 'EEXIST') throw linkErr;
      if (!['EXDEV', 'ENOTSUP', 'EPERM', 'ENOSYS'].includes(linkErr.code)) throw linkErr;
      if (fsModule.existsSync(filePath)) {
        const exists = new Error(`file already exists at ${filePath}`);
        exists.code = 'EEXIST';
        throw exists;
      }
      fsModule.renameSync(tempPath, filePath);
    }
  } finally {
    // После link временное имя не нужно, после rename его уже нет.
    try { fsModule.unlinkSync(tempPath); } catch { /* уже нет — не мешает */ }
  }
}

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

export { getLastReviewStatus, appendReviewEntry } from './review-section.mjs';

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
  const allDirNames = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'archive'];
  const allTickets = [];

  for (const dirName of allDirNames) {
    const dir = path.join(ticketsDir, dirName);
    if (!fs.existsSync(dir)) continue;

    // Точечные файлы каталога служебные: `.gitkeep.md` кладёт `workflow init`.
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
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
  const done = allTickets.filter(t => t.dir === 'done' || t.dir === 'archive').length;

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

  // Закрытие плана — замена содержимого на месте. Прямая запись обрезала файл до
  // нуля, и `listPlans`/`getPlan` (src/lib/operations/plans.mjs) в это окно
  // отдавали вызывающему план без id, заголовка и статуса — без ошибки, по
  // которой это можно было бы заметить. Решение по плану принималось на пустых
  // данных.
  replaceFileAtomicSync(planPath, serializeFrontmatter(frontmatter) + body);

  // Архивируем все done-тикеты этого плана
  const archiveDir = path.join(ticketsDir, 'archive');
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const archived = [];
  const doneDir = path.join(ticketsDir, 'done');
  if (fs.existsSync(doneDir)) {
    const doneTickets = allTickets.filter(t => t.dir === 'done');
    for (const ticket of doneTickets) {
      const srcPath = path.join(doneDir, `${ticket.id}.md`);
      const destPath = path.join(archiveDir, `${ticket.id}.md`);
      try {
        if (fs.existsSync(srcPath)) {
          const content = fs.readFileSync(srcPath, 'utf8');
          const { frontmatter: fm, body: bd } = parseFrontmatter(content);
          fm.updated_at = new Date().toISOString();
          fm.archived_at = new Date().toISOString();
          // Тикет появляется в archive/ целиком: иначе pick-next-task и метрики
          // видели в архиве файл с пустым frontmatter и считали его тикетом без
          // плана и без зависимостей. Имя в archive/ свободно, поэтому цикл по
          // done-тикетам не ждёт лестницу повторов ни на одном шаге.
          replaceFileAtomicSync(destPath, serializeFrontmatter(fm) + bd);
          fs.unlinkSync(srcPath);
          archived.push(ticket.id);
        }
      } catch (_) { /* skip errors */ }
    }
  }

  return { closed: true, reason: 'All tickets done', total, done, archived };
}
