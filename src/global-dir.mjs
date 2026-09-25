import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { replaceFileAtomicSync } from './lib/utils.mjs';

const isWindows = process.platform === 'win32';

function isJunctionOrSymlink(path) {
  if (!fs.existsSync(path)) {
    return false;
  }
  try {
    if (fs.lstatSync(path).isSymbolicLink()) {
      return true;
    }
  } catch {}
  if (isWindows) {
    try {
      const output = execSync(`fsutil reparsepoint query "${path}"`, { encoding: 'utf-8', stdio: 'pipe' });
      return output.includes('Symbolic Link') || output.includes('Mount Point');
    } catch {}
  }
  return false;
}

export function getGlobalDir() {
  if (process.env.WORKFLOW_HOME) {
    return process.env.WORKFLOW_HOME;
  }
  return join(homedir(), '.workflow');
}

function getPackageVersion(packageRoot) {
  const packageJsonPath = join(packageRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in ${packageRoot}`);
  }
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  return pkg.version;
}

function getGlobalVersion() {
  const globalDir = getGlobalDir();
  const versionFile = join(globalDir, '.version');
  if (!fs.existsSync(versionFile)) {
    return null;
  }
  return fs.readFileSync(versionFile, 'utf-8').trim();
}

/**
 * Временные скилы прогонов (__test-* в src/skills) в глобальную установку не
 * попадают. Они живут секунды: run-skill-tests.test.mjs создаёт и удаляет их
 * прямо в каноне, и cpSync успевал поймать ENOENT на исчезнувшей директории —
 * параллельный init.test.mjs падал целиком, без единого проваленного сабтеста.
 */
function isTemporaryTestEntry(entryPath) {
  return basename(entryPath).startsWith('__test-');
}

function copyDirectory(src, dest) {
  if (!fs.existsSync(src)) {
    return;
  }
  if (isJunctionOrSymlink(dest)) {
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, filter: (from) => !isTemporaryTestEntry(from) });
}

/**
 * globalDir — копия `src/` пакета (без тестов) плюс `configs/` и package.json.
 *
 * Проекты ссылаются на `<globalDir>/skills|scripts|rails`, а Node разрешает
 * импорты от настоящего пути файла, то есть внутри globalDir. Код оттуда
 * импортирует соседей по дереву `src/` (`../lib/…`, `../global-dir.mjs`,
 * `../init.mjs`) и сам пакет по имени (`workflow-ai/lib/…`). Пока копировались
 * только skills/scripts/rails, установка из npm падала ERR_MODULE_NOT_FOUND на
 * первом же хуке rails и скрипте скила (проверено установкой 1.7.3 во временный
 * каталог); работало лишь там, где globalDir — ссылки на рабочую копию пакета.
 * Поэтому копируется `src/` целиком, а package.json с именем и `exports` пакета
 * даёт импорту `workflow-ai/…` разрешиться внутри копии (self-reference Node).
 */
function copyPackageRuntime(packageRoot) {
  const globalDir = getGlobalDir();
  const srcRoot = join(packageRoot, 'src');
  if (fs.existsSync(srcRoot)) {
    for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
      if (entry.name === 'tests' || isTemporaryTestEntry(entry.name)) {
        continue;
      }
      const from = join(srcRoot, entry.name);
      const to = join(globalDir, entry.name);
      if (entry.isDirectory()) {
        copyDirectory(from, to);
      } else if (entry.isFile() && !isJunctionOrSymlink(to)) {
        fs.copyFileSync(from, to);
      }
    }
  }
  copyDirectory(join(packageRoot, 'configs'), join(globalDir, 'configs'));
  writeRuntimePackageJson(packageRoot, globalDir);
}

/** package.json копии: имя, тип модулей и `exports` пакета с путями без `src/`. */
function writeRuntimePackageJson(packageRoot, globalDir) {
  const pkg = JSON.parse(fs.readFileSync(join(packageRoot, 'package.json'), 'utf-8'));
  const exportsMap = {};
  for (const [key, target] of Object.entries(pkg.exports || {})) {
    if (typeof target === 'string' && target.startsWith('./src/')) {
      exportsMap[key] = `./${target.slice('./src/'.length)}`;
    }
  }
  const runtime = { name: pkg.name, version: pkg.version, private: true, type: pkg.type, exports: exportsMap };
  replaceFileAtomicSync(join(globalDir, 'package.json'), `${JSON.stringify(runtime, null, 2)}\n`);
}

export function isGlobalDirStale(packageRoot) {
  const globalDir = getGlobalDir();
  if (!fs.existsSync(globalDir)) {
    return true;
  }
  const globalVersion = getGlobalVersion();
  if (globalVersion === null) {
    return true;
  }
  const packageVersion = getPackageVersion(packageRoot);
  if (packageVersion !== globalVersion) {
    return true;
  }
  // rails/README.md §11: версия совпадает, но `<globalDir>/rails` отсутствует,
  // хотя пакет несёт `src/rails` — так бывает у глобальных установок,
  // созданных версией пакета до появления rails (версия при этом могла не
  // меняться). Без этой проверки ensureGlobalDir молча ничего не копирует, а
  // createRailsJunction в init.mjs — молча ничего не линкует.
  if (fs.existsSync(join(packageRoot, 'src', 'rails')) && !fs.existsSync(join(globalDir, 'rails'))) {
    return true;
  }
  // Установки до 1.7.4 копировали только skills/scripts/rails/configs и
  // package.json не писали — без полной копии код в них не запускается.
  if (!fs.existsSync(join(globalDir, 'package.json'))) {
    return true;
  }
  return false;
}

/**
 * Кладёт версию в общий каталог так, чтобы читателю был виден либо прежний
 * файл целиком, либо новый целиком.
 *
 * Прямой writeFileSync этого не даёт: он раскрывается в open(файл, 'w') и
 * запись вторым шагом, то есть усекает файл сразу, а содержимое отдаёт позже.
 * Пяти байт содержимого мало, чтобы окно было незаметным: читатель, повторяющий
 * getGlobalVersion, за 5 секунд получил 671 пустое чтение из 1590 (проверено
 * запуском на NTFS).
 *
 * Чем это платится. `.version` — файл общий для ВСЕХ проектов на машине, а
 * getGlobalVersion делает readFileSync(...).trim(): на пустом файле выходит не
 * null, а пустая строка, поэтому isGlobalDirStale сравнивает '' с версией
 * пакета и объявляет установку устаревшей. Init или update соседнего проекта в
 * этот момент зря повторяет copyPackageRuntime, а два таких копирования
 * разом лезут в один каталог, где каждое начинается с rmSync(dest). Тикеты и
 * планы не страдают — цена в избыточной работе и в риске, что один прогон сносит
 * каталог, пока другой в него копирует.
 *
 * Операция — rename поверх (внутри replaceFileAtomicSync), а не link: файл
 * версии перезаписывается на месте штатно, это и есть смысл `workflow update`,
 * а link падал бы EEXIST на каждом обновлении.
 */
function writeGlobalVersion(globalDir, version) {
  replaceFileAtomicSync(join(globalDir, '.version'), version);
}

export function ensureGlobalDir(packageRoot) {
  const globalDir = getGlobalDir();
  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true });
    copyPackageRuntime(packageRoot);
    const version = getPackageVersion(packageRoot);
    writeGlobalVersion(globalDir, version);
    return;
  }
  if (isGlobalDirStale(packageRoot)) {
    const version = getPackageVersion(packageRoot);
    writeGlobalVersion(globalDir, version);
    copyPackageRuntime(packageRoot);
  }
}

export function refreshGlobalDir(packageRoot) {
  const globalDir = getGlobalDir();
  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true });
  }
  const version = getPackageVersion(packageRoot);
  writeGlobalVersion(globalDir, version);
  copyPackageRuntime(packageRoot);
}