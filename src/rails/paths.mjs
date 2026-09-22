/**
 * Rails — пути и разрешение путей (спецификация §2).
 *
 * Сравнение путей ведётся только через realpath: скилы подключены
 * junction-цепочкой, и агент может править файл как по проектному пути, так
 * и по каноническому — строковое сравнение эти два пути не отождествит.
 * Модуль не имеет побочных эффектов при импорте.
 *
 * Обход junction/symlink при сопоставлении паттерна (`matchesGlob`,
 * `isInside`): паттерн (`write_scope`/`write_deny`/`stage_actions.match`)
 * описывает ВИРТУАЛЬНЫЙ (проектный) путь, а не настоящий. Наивно склеить
 * паттерн с `root` и взять realpath от результата нельзя — на пути от `root`
 * до цели паттерна почти всегда стоит junction (например,
 * `.workflow/src/skills/coach` — junction на канон), и realpath наивно
 * склеенного пути с ним уже не совпадёт. Поэтому паттерн раскрывается ПО
 * ФАЙЛОВОЙ СИСТЕМЕ (как обход фрагментов в `graph.mjs`): для каждого
 * сегмента без wildcard — просто `join`, для сегмента с `*`/`**` —
 * перечисление реальных записей каталога. Каждая найденная так точка
 * (в её виртуальном, ещё не разрешённом виде) прогоняется через
 * `realpathDeep` и сравнивается с уже разрешённым путём цели по префиксу
 * (`isInside`-семантика) — так junction на пути и обнаруживается.
 *
 * `expandGlobToFsRoots` — генератор, а не eager-массив: кандидаты отдаются
 * по мере обхода, и `isInside`/`matchesGlob` останавливаются на первом же
 * совпадении, не досчитывая обход до конца (§7, бюджет 200 мс на решение;
 * `isInside(path, os.tmpdir())` для `allow_temp` — самый частый вызов этого
 * рода, и `os.tmpdir()` может содержать сотни посторонних записей). Для
 * ХВОСТОВОГО `**` (сам паттерн заканчивается на `**`, как в этих двух
 * функциях) обычный (не-ссылка) подкаталог не даёт отдельного кандидата —
 * его совпадение по префиксу и так поймает самый первый кандидат (сам
 * `dir`, нулевые сегменты) без единого лишнего `realpath`; спуск в такие
 * подкаталоги нужен только чтобы найти ссылки ГЛУБЖЕ них.
 */

import { realpathSync, readdirSync, statSync } from 'node:fs';
import { dirname, basename, join, resolve, isAbsolute, sep } from 'node:path';

const IS_WIN32 = process.platform === 'win32';

// Предохранители от патологического обхода (циклы через symlink, огромные
// поддеревья под `**`): дерево скила — маленькое, этого с запасом хватает.
// Замер 2026-09-22: при 2000 каталогах / глубине 16 промах `isInside(<файл вне temp>, os.tmpdir())`
// стоил 9 с (обход всего %TEMP%). Скил-дерево укладывается в сотни каталогов и глубину < 8.
const MAX_EXPAND_DEPTH = 8;
const MAX_EXPAND_CANDIDATES = 400;
// Каталоги, в которых ссылок на скилы не бывает, а записей — тысячи.
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

/**
 * Настоящий путь (`realpathSync.native`, раскрывает короткие имена 8.3 на
 * Windows — см. `find-root.mjs`). Для ещё не существующего пути (например,
 * цель `Write`) берётся realpath ближайшего существующего предка плюс
 * остаток пути как есть.
 *
 * @param {string} p
 * @returns {string}
 */
export function realpathDeep(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new TypeError(`rails: realpathDeep ожидает непустой строковый путь, получено: ${JSON.stringify(p)}`);
  }

  let current = resolve(p);
  let remainder = '';

  for (;;) {
    try {
      const real = realpathSync.native(current);
      return remainder ? join(real, remainder) : real;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        const parent = dirname(current);
        if (parent === current) {
          // Дошли до корня файловой системы, и его тоже нет — сдаёмся,
          // возвращаем то, что просили, как есть.
          throw err;
        }
        remainder = remainder ? join(basename(current), remainder) : basename(current);
        current = parent;
        continue;
      }
      throw err;
    }
  }
}

function normalizeForCompare(p) {
  const s = String(p).replace(/\\/g, '/');
  return IS_WIN32 ? s.toLowerCase() : s;
}

// `realCandidate` уже нормализован через normalizeForCompare (прямые слэши,
// на Windows — нижний регистр). Возвращает true, если `realP` (тоже
// нормализован) равен ему или лежит внутри (с учётом границы сегмента).
function normalizedIsInside(realP, realCandidate) {
  if (realP === realCandidate) return true;
  const withSep = realCandidate.endsWith('/') ? realCandidate : `${realCandidate}/`;
  return realP.startsWith(withSep);
}

/**
 * Раскрывает АБСОЛЮТНЫЙ путь-паттерн (уже `join(root, glob)` или абсолютный
 * `glob`, ещё с возможными `*`/`**`) по файловой системе в ЛЕНИВЫЙ поток
 * конкретных (виртуальных, не realpath) точек-кандидатов: мест, где
 * дальнейшее сопоставление паттерна можно остановить и проверить цель через
 * `realpathDeep` + сравнение по префиксу. Кандидаты отдаются генератором по
 * мере обхода — вызывающий код (`isInside`/`matchesGlob`) останавливается
 * на первом совпадении, не оплачивая обход остатка дерева (§7).
 *
 * - Сегмент без `*` — просто `join`; для непоследнего сегмента требуется,
 *   чтобы он существовал и был каталогом (иначе паттерн неприменим дальше);
 *   последний сегмент кандидатом становится в любом случае (цель `write`
 *   может ещё не существовать).
 * - Сегмент с одиночным `*` — перечисление реальных записей каталога,
 *   сопоставление по имени (без учёта регистра на Windows).
 * - `**` — ноль и более полных сегментов пути: сам каталог (ноль сегментов)
 *   плюс рекурсивный обход его реальных подкаталогов (один и более
 *   сегментов), включая спуск ВНУТРЬ встреченного junction/symlink (не
 *   только на него самого) — иначе паттерн вида `skills` + `**` + `cases` +
 *   `**` (несколько "**" подряд с подкаталогом между ними) не находит
 *   ничего глубже junction'а на скил (основной случай §2). Цикл
 *   (ссылка на своего предка) отсекается множеством посещённых realpath
 *   ссылок; для обычных (не-ссылка) каталогов вместо этого работает
 *   предохранитель `MAX_EXPAND_DEPTH`, как и раньше — на них realpath не
 *   считается вовсе (см. ниже), так что зацикливание через них и так
 *   исключено. Когда `**` — ПОСЛЕДНИЙ сегмент паттерна (хвостовой случай:
 *   `isInside`, `matchesGlob('scope/**')`), обычный подкаталог кандидатом
 *   не становится (его накрывает кандидат самого `dir` через сравнение по
 *   префиксу без обхода) — спуск в него нужен только чтобы найти ссылки
 *   глубже; кандидатом всегда становится только ссылка.
 *
 * @param {string} patternPath
 * @returns {IterableIterator<string>}
 */
function* expandGlobToFsRoots(patternPath) {
  const rawSegs = patternPath.split(sep).filter((s) => s.length > 0);
  let base;
  if (IS_WIN32 && /^[A-Za-z]:$/.test(rawSegs[0])) {
    base = `${rawSegs.shift()}${sep}`;
  } else {
    base = sep;
  }

  let count = 0;
  // realpath уже пройденных ссылок в этом вызове — отсекает циклы junction
  // на предка/себя; для обычных каталогов не ведётся (нет realpath-вызова,
  // и depth-предохранитель их и так ограничивает).
  const visitedLinkReal = new Set();

  function* matchFrom(dir, remaining, depth, suppressSelf) {
    if (depth > MAX_EXPAND_DEPTH || count >= MAX_EXPAND_CANDIDATES) return;
    if (remaining.length === 0) {
      if (!suppressSelf) {
        count++;
        yield dir;
      }
      return;
    }

    const [seg, ...rest] = remaining;

    if (seg === '**') {
      // Ноль сегментов: остаток паттерна пробуем прямо здесь.
      yield* matchFrom(dir, rest, depth, suppressSelf);
      if (count >= MAX_EXPAND_CANDIDATES) return;

      // Один и более сегментов: спускаемся по реальным подкаталогам,
      // `**` остаётся активным (remaining, не rest).
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const ent of entries) {
        if (count >= MAX_EXPAND_CANDIDATES) return;
        // На Windows junction (directory reparse point) в Dirent приходит
        // как isSymbolicLink()===true, isDirectory()===false — сам он всё
        // равно каталог, просто readdir его так помечает.
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        const childDir = join(dir, ent.name);
        if (ent.isSymbolicLink()) {
          let realChild;
          try {
            realChild = normalizeForCompare(realpathDeep(childDir));
          } catch {
            continue;
          }
          if (visitedLinkReal.has(realChild)) continue;
          visitedLinkReal.add(realChild);
          yield* matchFrom(childDir, remaining, depth + 1, false);
        } else {
          // Хвостовой "**" (rest.length===0): обычный каталог кандидата не
          // даёт (см. комментарий функции выше) — спускаемся только искать
          // ссылки глубже. Не в хвосте — кандидат нужен как раньше.
          yield* matchFrom(childDir, remaining, depth + 1, rest.length === 0);
        }
      }
      return;
    }

    if (!seg.includes('*')) {
      const candidate = join(dir, seg);
      if (rest.length === 0) {
        count++;
        yield candidate;
        return;
      }
      let st;
      try {
        st = statSync(candidate);
      } catch {
        return;
      }
      if (!st.isDirectory()) return;
      // Фиксированный сегмент глубину не тратит: предохранитель считает только
      // wildcard-спуски, иначе паттерн под глубоким %TEMP% не раскрывается вовсе.
      yield* matchFrom(candidate, rest, depth, false);
      return;
    }

    // Одиночный `*` в сегменте — по реальным записям каталога.
    const re = new RegExp(`^${globSegmentToRegExpSource(seg)}$`, IS_WIN32 ? 'i' : undefined);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      if (count >= MAX_EXPAND_CANDIDATES) return;
      if (!re.test(ent.name)) continue;
      const candidate = join(dir, ent.name);
      if (rest.length === 0) {
        count++;
        yield candidate;
      } else if (ent.isDirectory() || ent.isSymbolicLink()) {
        yield* matchFrom(candidate, rest, depth + 1, false);
      }
    }
  }

  yield* matchFrom(base, rawSegs, 0, false);
}

/**
 * Путь `p` (уже разрешённый или ещё нет) находится внутри каталога `dir`.
 * Границы сегментов пути учитываются: `/foo/bar` не считается внутри
 * `/foo/ba`. `dir` может содержать junction/symlink на любом уровне между
 * собой и `p` (например, `dir/<skill>` — junction на канон): обход идёт по
 * файловой системе (см. `expandGlobToFsRoots`), не наивным realpath(dir).
 *
 * @param {string} p
 * @param {string} dir
 * @returns {boolean}
 */
export function isInside(p, dir, { followLinks = true } = {}) {
  const realP = normalizeForCompare(realpathDeep(p));
  // Быстрые пути без обхода: realpath цели под realpath каталога, либо цель
  // задана путём, лексически лежащим под `dir` (достижима через `dir` как есть).
  try {
    if (normalizedIsInside(realP, normalizeForCompare(realpathDeep(dir)))) return true;
  } catch {
    // каталога нет — обход ниже тоже ничего не найдёт
    return false;
  }
  if (normalizedIsInside(normalizeForCompare(resolve(p)), normalizeForCompare(resolve(dir)))) return true;
  // `followLinks: false` — только префиксы (для `allow_temp`: ссылки внутри
  // os.tmpdir() не нужны, а обход %TEMP% стоил до 9 с — замер 2026-09-22).
  if (!followLinks) return false;
  const patternPath = join(resolve(dir), '**');
  for (const candidate of expandGlobToFsRoots(patternPath)) {
    let realCandidate;
    try {
      realCandidate = normalizeForCompare(realpathDeep(candidate));
    } catch {
      continue;
    }
    if (normalizedIsInside(realP, realCandidate)) return true;
  }
  return false;
}

function escapeRegExpLiteral(s) {
  return s.replace(/[.?+^${}()|[\]\\]/g, '\\$&');
}

/** Источник regex для ОДНОГО сегмента glob-паттерна (без `/`): `*` — любые
 * символы (в пределах сегмента путь-разделитель и так не встречается). */
function globSegmentToRegExpSource(seg) {
  return seg.split('*').map(escapeRegExpLiteral).join('.*');
}

/**
 * `realpath` подходит под glob-паттерн (`write_scope` / `write_deny` /
 * `stage_actions[].match` из `rails.yaml`). Паттерн — относительно `root`,
 * если не абсолютный. Регистр на Windows не учитывается.
 *
 * Паттерн раскрывается по файловой системе (см. `expandGlobToFsRoots`,
 * junction-aware), а не наивной склейкой с последующим `realpath` — иначе
 * скилы, подключённые junction'ом (основной случай §2), не сопоставляются
 * ни по проектному, ни по каноническому пути цели.
 *
 * @param {string} realpath уже разрешённый путь (например, из `realpathDeep`)
 * @param {string} glob паттерн из `rails.yaml`
 * @param {string} root корень проекта (или другой базовый каталог для относительных паттернов)
 * @returns {boolean}
 */
export function matchesGlob(realpath, glob, root) {
  const patternPath = isAbsolute(glob) ? glob : join(root, glob);
  const normRealpath = normalizeForCompare(realpath);
  for (const candidate of expandGlobToFsRoots(patternPath)) {
    let realCandidate;
    try {
      realCandidate = normalizeForCompare(realpathDeep(candidate));
    } catch {
      continue;
    }
    if (normalizedIsInside(normRealpath, realCandidate)) return true;
  }
  return false;
}

/** Разделитель пути текущей платформы — экспортирован для тестов/отладки. */
export const PATH_SEP = sep;
