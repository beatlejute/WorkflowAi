/**
 * Наблюдатель за публикацией файла-артефакта.
 *
 * Зачем он такой. Инвариант «читатель видит либо отсутствие файла, либо целый
 * файл» нельзя проверить стенными часами: окно между обрезанием файла до нуля и
 * записью содержимого длится микросекунды, и тест на таймере ловит его через
 * раз. Поэтому наблюдатель встаёт вместо методов fs и после КАЖДОЙ мутации
 * файловой системы делает синхронный снимок артефакта глазами постороннего
 * читателя. Окно любой длины попадает между двумя мутациями и видно всегда.
 *
 * Чем это НЕ является — и почему это главное в файле. Снимок «после возврата из
 * патченного метода» сам по себе прямой записи не видит: `writeFileSync(p, c)`
 * раскрывается в open(p,'w'), который усекает файл до нуля, и запись вторым
 * шагом, то есть окно живёт ВНУТРИ одного вызова и снаружи неотличимо от
 * атомарной публикации. Проверено запуском: наблюдатель со снимком только после
 * вызова давал на прямой writeFileSync 1 мутацию и 0 нарушений, и три
 * поведенческих теста плановых путей зеленели на коде БЕЗ правки (чинил их
 * только текстовый grep по исходнику). Поэтому запись здесь раскрывается в свои
 * настоящие шаги — open → write → close — и снимок делается между ними.
 *
 * Чтение внутри снимка идёт через сохранённые оригиналы методов: иначе
 * наблюдатель считал бы собственные обращения к диску и уходил в рекурсию.
 */

import realFs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../lib/utils.mjs';

// Методы, которыми в принципе публикуется файл. Список намеренно шире, чем
// используют нынешние реализации: тест не должен зеленеть только оттого, что
// запись переехала на другой вызов. writeFileSync/promises.writeFile из списка
// вынесены — они не просто оборачиваются, а раскрываются на шаги (см. ниже).
const SYNC_METHODS = [
  'appendFileSync', 'renameSync', 'linkSync', 'unlinkSync',
  'copyFileSync', 'ftruncateSync', 'truncateSync', 'writeSync', 'closeSync',
];
const PROMISE_METHODS = [
  'appendFile', 'rename', 'link', 'unlink', 'copyFile', 'truncate',
];

// Оригиналы, снятые до любой подмены: снимок обязан читать диск мимо
// наблюдателя, а раскрытая запись — не попадать в собственный счётчик дважды.
const ORIGINAL = {
  readFileSync: realFs.readFileSync,
  readdirSync: realFs.readdirSync,
  existsSync: realFs.existsSync,
  openSync: realFs.openSync,
  writeSync: realFs.writeSync,
  closeSync: realFs.closeSync,
  promisesOpen: realFs.promises.open,
};

/**
 * Открывает ли этот флаг файл на запись.
 *
 * Разделение обязательно: openSync с флагом чтения мутацией не является, и
 * записывать её в счётчик нельзя — иначе `mutations > 0` станет правдой от
 * одного readFileSync, и проверка «тест хоть что-то увидел» перестанет
 * что-либо значить.
 *
 * @param {string|number|undefined} flags - флаги открытия (undefined → 'r')
 * @returns {boolean}
 */
function opensForWriting(flags) {
  if (typeof flags === 'number') {
    const { O_WRONLY, O_RDWR, O_TRUNC, O_APPEND, O_CREAT } = realFs.constants;
    return (flags & (O_WRONLY | O_RDWR | O_TRUNC | O_APPEND | O_CREAT)) !== 0;
  }
  if (typeof flags !== 'string') return false;
  return /[wa+]/.test(flags);
}

/** Содержимое записи в виде буфера — как его укладывает настоящий writeFileSync. */
function toBuffer(data, encoding) {
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data), encoding || 'utf8');
}

/** Опции записи в едином виде: третий аргумент бывает строкой-кодировкой. */
function writeOptions(options) {
  if (typeof options === 'string') return { encoding: options };
  return options || {};
}

/**
 * Ставит наблюдателя на методы fs и fs.promises.
 *
 * @param {(label: string) => string[]} inspect - снимок; возвращает список нарушений
 * @returns {{ violations: string[], mutations: number, restore: () => void }}
 */
export function watchFsMutations(inspect) {
  const violations = [];
  const saved = new Map();
  const state = { mutations: 0, armed: true };

  const record = (label) => {
    state.mutations++;
    if (!state.armed) return;
    for (const v of inspect(label)) violations.push(v);
  };

  for (const name of SYNC_METHODS) {
    const original = realFs[name];
    if (typeof original !== 'function') continue;
    saved.set(name, original);
    realFs[name] = function patched(...args) {
      const result = original.apply(realFs, args);
      record(name);
      return result;
    };
  }

  // Открытие на запись — отдельная мутация: код может публиковать файл не
  // writeFileSync'ом, а вручную (open('w') → write → close), и такой путь
  // обязан краснеть так же.
  const originalOpenSync = realFs.openSync;
  saved.set('openSync', originalOpenSync);
  realFs.openSync = function patchedOpenSync(...args) {
    const fd = originalOpenSync.apply(realFs, args);
    if (opensForWriting(args[1])) record('openSync(w)');
    return fd;
  };

  // Прямая запись раскрывается в свои настоящие шаги: снимок после open('w')
  // видит файл уже усечённым до нуля — то самое окно, ради которого заведён
  // весь наблюдатель.
  const originalWriteFileSync = realFs.writeFileSync;
  saved.set('writeFileSync', originalWriteFileSync);
  realFs.writeFileSync = function patchedWriteFileSync(file, data, options) {
    const opts = writeOptions(options);
    const flag = opts.flag === undefined ? 'w' : opts.flag;
    // fd вместо пути и дописывание раскрывать нечего и нельзя: усечения там
    // нет, а переоткрывать чужой дескриптор наблюдатель не вправе.
    if (typeof file === 'number' || flag !== 'w') {
      const result = originalWriteFileSync.call(realFs, file, data, options);
      record('writeFileSync');
      return result;
    }

    const buffer = toBuffer(data, opts.encoding);
    const fd = ORIGINAL.openSync.call(realFs, file, 'w', opts.mode === undefined ? 0o666 : opts.mode);
    try {
      record('writeFileSync/open(w) — файл усечён до нуля');
      let written = 0;
      while (written < buffer.length) {
        const n = ORIGINAL.writeSync.call(realFs, fd, buffer, written, buffer.length - written);
        record('writeFileSync/write');
        if (n <= 0) break; // запись не двигается — дальше цикл был бы бесконечным
        written += n;
      }
    } finally {
      ORIGINAL.closeSync.call(realFs, fd);
    }
    record('writeFileSync/close');
  };

  const promises = realFs.promises;
  const savedPromises = new Map();
  for (const name of PROMISE_METHODS) {
    const original = promises[name];
    if (typeof original !== 'function') continue;
    savedPromises.set(name, original);
    promises[name] = async function patched(...args) {
      const result = await original.apply(promises, args);
      record(`promises.${name}`);
      return result;
    };
  }

  // Асинхронная прямая запись раскрывается так же: окно между усечением и
  // содержимым у fs.promises.writeFile ровно то же самое.
  const originalPromiseWriteFile = promises.writeFile;
  savedPromises.set('writeFile', originalPromiseWriteFile);
  promises.writeFile = async function patchedWriteFile(file, data, options) {
    const opts = writeOptions(options);
    const flag = opts.flag === undefined ? 'w' : opts.flag;
    const isHandle = file !== null && typeof file === 'object' && typeof file.write === 'function';
    if (typeof file === 'number' || isHandle || flag !== 'w' || opts.signal) {
      const result = await originalPromiseWriteFile.call(promises, file, data, options);
      record('promises.writeFile');
      return result;
    }

    const buffer = toBuffer(data, opts.encoding);
    const handle = await ORIGINAL.promisesOpen.call(promises, file, 'w', opts.mode === undefined ? 0o666 : opts.mode);
    try {
      record('promises.writeFile/open(w) — файл усечён до нуля');
      let written = 0;
      while (written < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, written, buffer.length - written);
        record('promises.writeFile/write');
        if (bytesWritten <= 0) break;
        written += bytesWritten;
      }
    } finally {
      await handle.close();
    }
    record('promises.writeFile/close');
  };

  return {
    violations,
    get mutations() { return state.mutations; },
    restore() {
      state.armed = false;
      for (const [name, original] of saved) realFs[name] = original;
      for (const [name, original] of savedPromises) promises[name] = original;
    },
  };
}

/**
 * Снимок markdown-артефакта (тикет, план, шаблон) глазами читателя.
 *
 * Пустой файл — именно то, чем эта гонка опасна: `parseFrontmatter('')` не
 * бросает, а возвращает frontmatter без единого поля. Читатель не падает и
 * ничего не пишет в журнал — он просто считает, что у тикета нет ни статуса, ни
 * зависимостей, а у плана нет ни id, ни заголовка.
 *
 * @param {string} filePath - Путь к артефакту
 * @param {string} label - Что произошло перед снимком
 * @returns {string[]} Нарушения инварианта (пустой список — всё цело)
 */
export function inspectMarkdownArtifact(filePath, label) {
  let content;
  try {
    content = ORIGINAL.readFileSync.call(realFs, filePath, 'utf8');
  } catch (err) {
    // Отсутствие файла инвариант не нарушает: читатель видит «ещё не появился».
    if (err.code === 'ENOENT') return [];
    return [`${label}: ${path.basename(filePath)} не читается (${err.code})`];
  }

  if (content.length === 0) {
    return [`${label}: ${path.basename(filePath)} виден читателю пустым — ` +
      'frontmatter разбирается в пустой объект, и артефакт уходит дальше без ' +
      'статуса: тикет как тикет без зависимостей, план как план без id и заголовка'];
  }

  let frontmatter;
  try {
    ({ frontmatter } = parseFrontmatter(content));
  } catch (err) {
    return [`${label}: ${path.basename(filePath)} не разбирается (${err.message})`];
  }

  if (!frontmatter || !frontmatter.id) {
    return [`${label}: ${path.basename(filePath)} виден читателю без id — ` +
      `обрезанное содержимое длиной ${content.length}`];
  }

  return [];
}

/**
 * Снимок approval-файла глазами раннера.
 *
 * Здесь пустое чтение дороже: readApprovalFile отвечает на него «corrupt
 * approval file» и уводит стадию в goto.error ровно в тот момент, когда человек
 * нажал approve.
 *
 * @param {string} filePath - Путь к approval-файлу
 * @param {string} label - Что произошло перед снимком
 * @returns {string[]}
 */
export function inspectApprovalArtifact(filePath, label) {
  let content;
  try {
    content = ORIGINAL.readFileSync.call(realFs, filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    return [`${label}: ${path.basename(filePath)} не читается (${err.code})`];
  }

  try {
    const data = JSON.parse(content);
    if (!data.step_id) {
      return [`${label}: ${path.basename(filePath)} разобрался, но без step_id`];
    }
  } catch (err) {
    return [`${label}: ${path.basename(filePath)} виден читателю битым ` +
      `(длина ${content.length}) — раннер отвечает на это «corrupt approval file» ` +
      `и уводит стадию в goto.error: ${err.message}`];
  }

  return [];
}

/**
 * Файлы каталога глазами боевых сканирований.
 *
 * Фильтр повторяет тот, что стоит у читателей каталогов тикетов и планов
 * (`f.endsWith('.md') && !f.startsWith('.')`). Временный файл публикации обязан
 * не проходить этот фильтр — иначе он сам станет фантомным тикетом или планом.
 *
 * @param {string} dir - Каталог артефактов
 * @returns {string[]} Имена, которые сканирование примет за артефакт
 */
export function listAsScanner(dir) {
  try {
    return ORIGINAL.readdirSync.call(realFs, dir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.') && f !== '.gitkeep.md');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Все файлы каталога, включая временные: чтобы увидеть оставшийся мусор. */
export function listRaw(dir) {
  try {
    return ORIGINAL.readdirSync.call(realFs, dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
