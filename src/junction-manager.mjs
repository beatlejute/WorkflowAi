import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  lstatSync,
  symlinkSync,
  linkSync,
  cpSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  rmdirSync
} from 'node:fs';
import { join, basename } from 'node:path';

const isWindows = process.platform === 'win32';

export function createJunction(target, linkPath) {
  if (!existsSync(target)) {
    throw new Error(`Target does not exist: ${target}`);
  }
  const linkDir = join(linkPath, '..');
  if (!existsSync(linkDir)) {
    mkdirSync(linkDir, { recursive: true });
  }
  rmSync(linkPath, { recursive: true, force: true });

  if (isWindows) {
    execSync(`mklink /J "${linkPath}" "${target}"`, { stdio: 'pipe' });
  } else {
    symlinkSync(target, linkPath, 'dir');
  }
}

export function removeJunction(linkPath) {
  if (existsSync(linkPath)) {
    rmSync(linkPath, { recursive: true, force: true });
  }
}

export function isJunction(path) {
  if (!existsSync(path)) {
    return false;
  }
  try {
    const stats = lstatSync(path);
    return stats.isSymbolicLink();
  } catch {
    if (isWindows) {
      try {
        const output = execSync(`fsutil reparsepoint query "${path}"`, { encoding: 'utf-8', stdio: 'pipe' });
        return output.includes('Symbolic Link') || output.includes('Mount Point');
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function createHardlink(target, linkPath) {
  if (!existsSync(target)) {
    throw new Error(`Target does not exist: ${target}`);
  }
  const linkDir = join(linkPath, '..');
  if (!existsSync(linkDir)) {
    mkdirSync(linkDir, { recursive: true });
  }
  rmSync(linkPath, { force: true });

  try {
    if (isWindows) {
      execSync(`mklink /H "${linkPath}" "${target}"`, { stdio: 'pipe' });
    } else {
      linkSync(target, linkPath);
    }
  } catch {
    cpSync(target, linkPath);
  }
}

export function removeHardlink(linkPath) {
  if (existsSync(linkPath)) {
    unlinkSync(linkPath);
  }
}

export function createSkillJunctions(globalDir, projectSkillsDir) {
  const globalSkillsDir = join(globalDir, 'skills');
  if (!existsSync(globalSkillsDir)) {
    return;
  }
  if (!existsSync(projectSkillsDir)) {
    mkdirSync(projectSkillsDir, { recursive: true });
  }

  const skills = readdirSync(globalSkillsDir, { withFileTypes: true });
  for (const skill of skills) {
    if (skill.isDirectory()) {
      const skillName = skill.name;
      const targetPath = join(globalSkillsDir, skillName);
      const linkPath = join(projectSkillsDir, skillName);
      if (existsSync(linkPath) && !isJunction(linkPath)) {
        continue;
      }
      createJunction(targetPath, linkPath);
    }
  }
}

// Shared knowledge проекта живёт в .workflow/shared/, вне каталога скилов:
// каталог скилов — ссылки на общую копию канона, и исполнителям запись в него
// закрыта гардами, а shared обновляют задачи продукта. До 1.22.0 shared лежал в
// .workflow/src/skills/shared/ — update и init переносят его. Файлы нового
// места не перезаписываются: при совпадении имён старая копия остаётся на
// месте, её имя попадает в `kept`, и каталог старого места не удаляется.
// Без старого каталога создаётся пустой .workflow/shared/: гарды rails
// раскрывают паттерн write_scope по существующим каталогам, и без него
// коуч не смог бы записать в проект первый модуль shared.
export function migrateProjectSharedDir(workflowRoot) {
  const oldDir = join(workflowRoot, 'src', 'skills', 'shared');
  const newDir = join(workflowRoot, 'shared');
  let oldStats;
  try {
    oldStats = lstatSync(oldDir);
  } catch {
    mkdirSync(newDir, { recursive: true });
    return { status: 'none', moved: [], kept: [] };
  }
  if (oldStats.isSymbolicLink() || !oldStats.isDirectory()) {
    return { status: 'skipped', reason: `${oldDir} is not a plain directory`, moved: [], kept: [] };
  }
  if (!existsSync(newDir)) {
    renameSync(oldDir, newDir);
    return { status: 'moved', moved: readdirSync(newDir), kept: [] };
  }
  if (!lstatSync(newDir).isDirectory()) {
    return { status: 'skipped', reason: `${newDir} exists and is not a directory`, moved: [], kept: [] };
  }
  const moved = [];
  const kept = [];
  for (const name of readdirSync(oldDir)) {
    if (existsSync(join(newDir, name))) {
      kept.push(name);
      continue;
    }
    renameSync(join(oldDir, name), join(newDir, name));
    moved.push(name);
  }
  if (kept.length === 0) {
    rmdirSync(oldDir);
    return { status: 'merged', moved, kept };
  }
  return { status: 'partial', moved, kept };
}

export function createScriptJunction(globalDir, projectScriptsDir) {
  const globalScriptsDir = join(globalDir, 'scripts');
  if (!existsSync(globalScriptsDir)) {
    return;
  }

  // If local (ejected) scripts dir exists, don't overwrite
  if (existsSync(projectScriptsDir) && !isJunction(projectScriptsDir)) {
    return;
  }

  createJunction(globalScriptsDir, projectScriptsDir);
}

export function createConfigJunction(globalDir, projectConfigDir) {
  const globalConfigDir = join(globalDir, 'configs');
  if (!existsSync(globalConfigDir)) {
    return;
  }

  // If local (ejected) config dir exists, don't overwrite
  if (existsSync(projectConfigDir) && !isJunction(projectConfigDir)) {
    return;
  }

  createJunction(globalConfigDir, projectConfigDir);
}

/**
 * Junction на ядро rails (rails/README.md §11): `<globalDir>/rails` →
 * `projectRailsDir` (обычно `<root>/.workflow/src/rails`). Тот же контракт,
 * что у createScriptJunction/createConfigJunction: нет источника в глобальной
 * установке — тихо выходим; локальный (не-junction) каталог в проекте не
 * трогаем (ejected-режим).
 *
 * @param {string} globalDir
 * @param {string} projectRailsDir
 */
export function createRailsJunction(globalDir, projectRailsDir) {
  const globalRailsDir = join(globalDir, 'rails');
  if (!existsSync(globalRailsDir)) {
    return;
  }

  if (existsSync(projectRailsDir) && !isJunction(projectRailsDir)) {
    return;
  }

  createJunction(globalRailsDir, projectRailsDir);
}

export function ejectConfigs(globalDir, projectConfigDir) {
  const globalConfigDir = join(globalDir, 'configs');

  if (!existsSync(globalConfigDir)) {
    throw new Error('Configs do not exist in global dir');
  }

  removeJunction(projectConfigDir);
  cpSync(globalConfigDir, projectConfigDir, { recursive: true });
}

export function ejectScripts(globalDir, projectScriptsDir) {
  const globalScriptsDir = join(globalDir, 'scripts');

  if (!existsSync(globalScriptsDir)) {
    throw new Error('Scripts do not exist in global dir');
  }

  removeJunction(projectScriptsDir);
  cpSync(globalScriptsDir, projectScriptsDir, { recursive: true });
}

/** @deprecated Use createScriptJunction instead */
export function createScriptHardlinks(globalDir, projectScriptsDir) {
  createScriptJunction(globalDir, projectScriptsDir);
}

export function ejectSkill(skillName, globalDir, projectSkillsDir) {
  const globalSkillPath = join(globalDir, 'skills', skillName);
  const projectSkillPath = join(projectSkillsDir, skillName);

  if (!existsSync(globalSkillPath)) {
    throw new Error(`Skill does not exist in global dir: ${skillName}`);
  }

  removeJunction(projectSkillPath);
  cpSync(globalSkillPath, projectSkillPath, { recursive: true });
}

export function listSkillsWithStatus(globalDir, projectSkillsDir) {
  const result = [];
  const globalSkillsDir = join(globalDir, 'skills');
  const projectSkillsDirFull = projectSkillsDir;

  if (!existsSync(globalSkillsDir)) {
    if (existsSync(projectSkillsDirFull)) {
      const projectSkills = readdirSync(projectSkillsDirFull, { withFileTypes: true });
      for (const skill of projectSkills) {
        if (skill.isDirectory()) {
          result.push({ name: skill.name, status: 'project-only' });
        }
      }
    }
    return result;
  }

  const globalSkills = readdirSync(globalSkillsDir, { withFileTypes: true });
  const projectSkills = existsSync(projectSkillsDirFull)
    ? readdirSync(projectSkillsDirFull, { withFileTypes: true })
    : [];

  const projectSkillNames = new Set(projectSkills.map(s => s.name));

  for (const skill of globalSkills) {
    if (skill.isDirectory()) {
      const skillName = skill.name;
      const projectSkillPath = join(projectSkillsDirFull, skillName);
      let status = 'shared';

      if (projectSkillNames.has(skillName)) {
        if (!isJunction(projectSkillPath)) {
          status = 'ejected';
        }
      }

      result.push({ name: skillName, status });
    }
  }

  for (const skill of projectSkills) {
    if (skill.isDirectory() && !globalSkills.some(s => s.name === skill.name)) {
      result.push({ name: skill.name, status: 'project-only' });
    }
  }

  return result;
}