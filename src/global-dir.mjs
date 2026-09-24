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

function copySkillsScriptsAndConfigs(packageRoot) {
  const globalDir = getGlobalDir();
  const srcSkills = join(packageRoot, 'src', 'skills');
  const srcScripts = join(packageRoot, 'src', 'scripts');
  const srcConfigs = join(packageRoot, 'configs');
  const srcRails = join(packageRoot, 'src', 'rails');
  const destSkills = join(globalDir, 'skills');
  const destScripts = join(globalDir, 'scripts');
  const destConfigs = join(globalDir, 'configs');
  const destRails = join(globalDir, 'rails');

  if (fs.existsSync(srcSkills)) {
    copyDirectory(srcSkills, destSkills);
  }
  if (fs.existsSync(srcScripts)) {
    copyDirectory(srcScripts, destScripts);
  }
  if (fs.existsSync(srcConfigs)) {
    copyDirectory(srcConfigs, destConfigs);
  }
  // rails/README.md §11: ядро rails копируется в глобальную установку тем же
  // путём, что skills/scripts/configs — проектная junction (createRailsJunction)
  // указывает именно сюда.
  if (fs.existsSync(srcRails)) {
    copyDirectory(srcRails, destRails);
  }
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
 * этот момент зря повторяет copySkillsScriptsAndConfigs, а два таких копирования
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
    copySkillsScriptsAndConfigs(packageRoot);
    const version = getPackageVersion(packageRoot);
    writeGlobalVersion(globalDir, version);
    return;
  }
  if (isGlobalDirStale(packageRoot)) {
    const version = getPackageVersion(packageRoot);
    writeGlobalVersion(globalDir, version);
    copySkillsScriptsAndConfigs(packageRoot);
  }
}

export function refreshGlobalDir(packageRoot) {
  const globalDir = getGlobalDir();
  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true });
  }
  const version = getPackageVersion(packageRoot);
  writeGlobalVersion(globalDir, version);
  copySkillsScriptsAndConfigs(packageRoot);
}