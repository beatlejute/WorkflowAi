import { findProjectRoot } from '../find-root.mjs';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lists all available skills, distinguishing between shared and ejected ones.
 * 
 * @param {string} [projectRoot] - Project root directory. If not provided, will be auto-detected.
 * @returns {Promise<Array<{name: string, path: string, source: 'shared' | 'ejected'}>>}
 */
export async function listSkills(projectRoot) {
  // Auto-detect project root if not provided
  if (!projectRoot) {
    projectRoot = findProjectRoot();
  }

  // Get global skills directory (from where this module is located)
  // Assuming this file is in src/lib/operations/skills.mjs
  // Global root is two levels up from src (since src is in project root)
  const globalRoot = join(projectRoot, '..');
  const globalSkillsDir = join(globalRoot, 'src', 'skills');
  
  // Project skills directory
  const projectSkillsDir = join(projectRoot, '.workflow', 'src', 'skills');

  const result = [];

  // Check if global skills directory exists
  if (!existsSync(globalSkillsDir)) {
    return result;
  }

  // Read global skills
  const globalSkills = readdirSync(globalSkillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  // Check if project skills directory exists
  if (existsSync(projectSkillsDir)) {
    // Check if it's a junction/symlink
    let isJunctionLink = false;
    try {
      const stats = lstatSync(projectSkillsDir);
      isJunctionLink = stats.isSymbolicLink();
    } catch (error) {
      // If lstat fails, treat as not a junction
      isJunctionLink = false;
    }

    if (isJunctionLink) {
      // If it's a junction, all skills in it are considered shared
      const projectSkills = readdirSync(projectSkillsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);

      // Add all skills as shared (from junction)
      for (const skillName of [...new Set([...globalSkills, ...projectSkills])]) {
        result.push({
          name: skillName,
          path: join(globalSkillsDir, skillName),
          source: 'shared'
        });
      }
    } else {
      // Not a junction - handle ejected skills
      const projectSkills = readdirSync(projectSkillsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);

      // First, add all global skills as shared
      for (const skillName of globalSkills) {
        result.push({
          name: skillName,
          path: join(globalSkillsDir, skillName),
          source: 'shared'
        });
      }

      // Then, override with ejected skills where applicable
      const ejectedSkillsMap = new Map();
      for (const skillName of projectSkills) {
        ejectedSkillsMap.set(skillName, join(projectSkillsDir, skillName));
      }

      // Build final result: ejected overrides shared
      const finalResult = [];
      const processedSkills = new Set();

      // Add ejected skills first
      for (const [skillName, skillPath] of ejectedSkillsMap) {
        finalResult.push({
          name: skillName,
          path: skillPath,
          source: 'ejected'
        });
        processedSkills.add(skillName);
      }

      // Add global skills that weren't overridden
      for (const skillName of globalSkills) {
        if (!processedSkills.has(skillName)) {
          finalResult.push({
            name: skillName,
            path: join(globalSkillsDir, skillName),
            source: 'shared'
          });
        }
      }

      return finalResult;
    }
  } else {
    // No project skills directory - return all global skills as shared
    for (const skillName of globalSkills) {
      result.push({
        name: skillName,
        path: join(globalSkillsDir, skillName),
        source: 'shared'
      });
    }
  }

  return result;
}