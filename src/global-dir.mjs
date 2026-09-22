import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, lstatSync } from 'node:fs';
import { execSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function isJunctionOrSymlink(path) {
  if (!existsSync(path)) {
    return false;
  }
  try {
    if (lstatSync(path).isSymbolicLink()) {
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
  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in ${packageRoot}`);
  }
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  return pkg.version;
}

function getGlobalVersion() {
  const globalDir = getGlobalDir();
  const versionFile = join(globalDir, '.version');
  if (!existsSync(versionFile)) {
    return null;
  }
  return readFileSync(versionFile, 'utf-8').trim();
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
  if (!existsSync(src)) {
    return;
  }
  if (isJunctionOrSymlink(dest)) {
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, filter: (from) => !isTemporaryTestEntry(from) });
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

  if (existsSync(srcSkills)) {
    copyDirectory(srcSkills, destSkills);
  }
  if (existsSync(srcScripts)) {
    copyDirectory(srcScripts, destScripts);
  }
  if (existsSync(srcConfigs)) {
    copyDirectory(srcConfigs, destConfigs);
  }
  // rails/README.md §11: ядро rails копируется в глобальную установку тем же
  // путём, что skills/scripts/configs — проектная junction (createRailsJunction)
  // указывает именно сюда.
  if (existsSync(srcRails)) {
    copyDirectory(srcRails, destRails);
  }
}

export function isGlobalDirStale(packageRoot) {
  const globalDir = getGlobalDir();
  if (!existsSync(globalDir)) {
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
  if (existsSync(join(packageRoot, 'src', 'rails')) && !existsSync(join(globalDir, 'rails'))) {
    return true;
  }
  return false;
}

export function ensureGlobalDir(packageRoot) {
  const globalDir = getGlobalDir();
  if (!existsSync(globalDir)) {
    mkdirSync(globalDir, { recursive: true });
    copySkillsScriptsAndConfigs(packageRoot);
    const version = getPackageVersion(packageRoot);
    writeFileSync(join(globalDir, '.version'), version);
    return;
  }
  if (isGlobalDirStale(packageRoot)) {
    const version = getPackageVersion(packageRoot);
    writeFileSync(join(globalDir, '.version'), version);
    copySkillsScriptsAndConfigs(packageRoot);
  }
}

export function refreshGlobalDir(packageRoot) {
  const globalDir = getGlobalDir();
  if (!existsSync(globalDir)) {
    mkdirSync(globalDir, { recursive: true });
  }
  const version = getPackageVersion(packageRoot);
  writeFileSync(join(globalDir, '.version'), version);
  copySkillsScriptsAndConfigs(packageRoot);
}