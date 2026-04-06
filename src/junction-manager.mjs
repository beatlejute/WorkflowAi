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
  unlinkSync
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