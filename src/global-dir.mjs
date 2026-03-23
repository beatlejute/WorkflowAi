import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';

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

function copyDirectory(src, dest) {
  if (!existsSync(src)) {
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}

function copySkillsAndScripts(packageRoot) {
  const globalDir = getGlobalDir();
  const srcSkills = join(packageRoot, 'src', 'skills');
  const srcScripts = join(packageRoot, 'src', 'scripts');
  const destSkills = join(globalDir, 'skills');
  const destScripts = join(globalDir, 'scripts');

  if (existsSync(srcSkills)) {
    copyDirectory(srcSkills, destSkills);
  }
  if (existsSync(srcScripts)) {
    copyDirectory(srcScripts, destScripts);
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
  return packageVersion !== globalVersion;
}

export function ensureGlobalDir(packageRoot) {
  const globalDir = getGlobalDir();
  if (!existsSync(globalDir)) {
    mkdirSync(globalDir, { recursive: true });
    copySkillsAndScripts(packageRoot);
    const version = getPackageVersion(packageRoot);
    writeFileSync(join(globalDir, '.version'), version);
    return;
  }
  if (isGlobalDirStale(packageRoot)) {
    const version = getPackageVersion(packageRoot);
    writeFileSync(join(globalDir, '.version'), version);
    copySkillsAndScripts(packageRoot);
  }
}

export function refreshGlobalDir(packageRoot) {
  const globalDir = getGlobalDir();
  if (!existsSync(globalDir)) {
    mkdirSync(globalDir, { recursive: true });
  }
  const version = getPackageVersion(packageRoot);
  writeFileSync(join(globalDir, '.version'), version);
  copySkillsAndScripts(packageRoot);
}