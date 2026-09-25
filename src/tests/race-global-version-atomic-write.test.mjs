/**
 * Файл версии общей установки (<WORKFLOW_HOME>/.version) обязан быть виден
 * читателю целиком — либо со старой версией, либо с новой. Пустого промежутка
 * быть не должно.
 *
 * Инцидент того же класса, что approval-файл ручного гейта и маркер запущенного
 * пайплайна, но с особенностью: этот файл общий для ВСЕХ проектов на машине.
 * ensureGlobalDir и refreshGlobalDir клали версию прямым writeFileSync, а это
 * open(файл, 'w') плюс запись вторым шагом — файл усекается сразу, содержимое
 * приходит позже.
 *
 * Цена. getGlobalVersion() читает файл и делает .trim(); на пустом файле он
 * отдаёт не null, а пустую строку, поэтому isGlobalDirStale() сравнивает '' с
 * версией пакета, не совпадает — и объявляет установку устаревшей. Следствие:
 * лишний copyPackageRuntime в общий каталог, а при неудачном совпадении
 * два одновременных копирования в один каталог, где каждое начинается с
 * rmSync(dest). Тикеты и планы при этом не теряются — цена в избыточной работе
 * и в риске, что один прогон сносит каталог, пока другой в него копирует.
 *
 * Окно доказано запуском, а не рассуждением: читатель, повторяющий getGlobalVersion,
 * за 5 секунд получил 671 пустое чтение из 1590, пока писатель обновлял файл.
 * Пять байт содержимого от этого не спасают — усечение происходит на open.
 *
 * Стенных часов в тесте нет: наблюдатель подменяет методы fs и снимает состояние
 * файла глазами getGlobalVersion после каждой мутации каталога.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/race-global-version-atomic-write.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ensureGlobalDir, refreshGlobalDir, isGlobalDirStale, getGlobalDir } from '../global-dir.mjs';

const OLD_VERSION = '1.0.0';
const NEW_VERSION = '9.9.9';

/** Пакет-пустышка: без src/skills, src/scripts, configs и src/rails копировать нечего. */
function createPackageRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'race-version-pkg-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fake', version: NEW_VERSION }));
  return root;
}

/**
 * Готовит изолированный общий каталог и подменяет WORKFLOW_HOME на время вызова.
 * Прежнее значение возвращается: его ставит преднагрузка _rails-home.mjs, и
 * сносить чужой каталог хук на выходе не должен.
 */
function withGlobalHome(fn, { seedVersion = OLD_VERSION } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'race-version-home-'));
  const previous = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = home;
  try {
    if (seedVersion !== null) {
      fs.writeFileSync(path.join(home, '.version'), seedVersion);
    } else {
      fs.rmSync(home, { recursive: true, force: true });
    }
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Что видит читатель версии прямо сейчас. Проверка построчно повторяет
 * getGlobalVersion(): существует ли файл → прочитать → .trim().
 */
function readerView(home) {
  const versionFile = path.join(home, '.version');
  if (!fs.existsSync(versionFile)) return 'нет файла';
  const value = fs.readFileSync(versionFile, 'utf-8').trim();
  if (value === '') return 'пустой (устаревшей объявится любая установка)';
  if (value !== OLD_VERSION && value !== NEW_VERSION) return `обрезанный (${JSON.stringify(value)})`;
  return 'целый';
}

// Мутации каталога, после которых читателю может открыться промежуточное состояние.
const MUTATORS = ['renameSync', 'linkSync', 'unlinkSync', 'mkdirSync', 'rmSync', 'copyFileSync', 'truncateSync'];

/**
 * Подменяет методы fs на время вызова. writeFileSync раскрывается в свои
 * настоящие шаги — open('w') (усечение) → write → close, — потому что окно
 * живёт ВНУТРИ вызова и снаружи неотличимо от атомарной записи.
 */
function observeWhile(home, fn) {
  const seen = [];
  const written = [];
  const observe = () => seen.push(readerView(home));
  const original = {};

  original.writeFileSync = fs.writeFileSync;
  fs.writeFileSync = (file, data, options) => {
    written.push(String(file));
    const encoding = typeof options === 'string' ? options : options?.encoding ?? 'utf8';
    const fd = original.openSync ? original.openSync(file, 'w') : fs.openSync(file, 'w');
    observe();
    try {
      fs.writeSync(fd, Buffer.from(String(data), encoding));
      observe();
    } finally {
      fs.closeSync(fd);
    }
    observe();
  };

  for (const name of MUTATORS) {
    if (typeof fs[name] !== 'function') continue;
    const real = fs[name];
    original[name] = real;
    fs[name] = (...args) => {
      const result = real.apply(fs, args);
      observe();
      return result;
    };
  }

  try {
    fn();
  } finally {
    for (const [name, real] of Object.entries(original)) fs[name] = real;
  }

  return { seen, written };
}

test('версия общей установки: читателю ни в одной точке записи не виден пустой файл версии', () => {
  const packageRoot = createPackageRoot();
  try {
    withGlobalHome((home) => {
      const { seen } = observeWhile(home, () => refreshGlobalDir(packageRoot));

      const broken = seen.filter((state) => state !== 'целый' && state !== 'нет файла');
      assert.deepEqual(
        broken,
        [],
        'между вызовами fs читатель видел неполный файл версии, а это ложное «устарело» '
        + `и лишнее копирование в общий каталог: ${broken.join('; ')}`,
      );

      assert.equal(fs.readFileSync(path.join(home, '.version'), 'utf-8'), NEW_VERSION, 'версия должна обновиться');
      assert.equal(isGlobalDirStale(packageRoot), false, 'после обновления установка не считается устаревшей');
    });
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('версия общей установки: первая установка кладёт версию целиком', () => {
  const packageRoot = createPackageRoot();
  try {
    withGlobalHome((home) => {
      const { seen } = observeWhile(home, () => ensureGlobalDir(packageRoot));

      const broken = seen.filter((state) => state !== 'целый' && state !== 'нет файла');
      assert.deepEqual(broken, [], `при первой установке читатель видел неполный файл версии: ${broken.join('; ')}`);
      assert.equal(fs.readFileSync(path.join(getGlobalDir(), '.version'), 'utf-8'), NEW_VERSION);
    }, { seedVersion: null });
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('версия общей установки: временный файл не остаётся в общем каталоге и не выдаёт себя за версию', () => {
  const packageRoot = createPackageRoot();
  try {
    withGlobalHome((home) => {
      const { written } = observeWhile(home, () => refreshGlobalDir(packageRoot));

      // Имя временного файла берётся из самой записи, а не угадывается.
      const versionFile = path.join(home, '.version');
      // package.json копии пакета пишется рядом тем же способом — его записи не про версию.
      const tempPaths = written.filter((file) => file !== versionFile && !path.basename(file).startsWith('.package.json.'));
      assert.equal(tempPaths.length, 1, `ожидалась ровно одна запись во временный файл: ${written.join(', ')}`);
      assert.equal(path.dirname(tempPaths[0]), home, 'временный файл должен лежать на том же томе, рядом с версией');
      assert.notEqual(path.basename(tempPaths[0]), '.version', 'временный файл не должен занимать имя версии');

      const leftovers = fs.readdirSync(home).filter((name) => name !== '.version' && name !== 'package.json');
      assert.deepEqual(leftovers, [], `в общем каталоге остался мусор: ${leftovers.join(', ')}`);
    });
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});
