import { findProjectRoot } from '../find-root.mjs';
import { getGlobalDir } from '../../global-dir.mjs';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lists all available skills, distinguishing between shared and ejected ones.
 *
 * Общие скилы лежат в глобальной установке — `<WORKFLOW_HOME>/skills`, по
 * умолчанию `~/.workflow/skills`; проекты ссылаются туда junction'ами. Именно
 * этот каталог берёт `listSkillsWithStatus`, на котором построена команда
 * `workflow list`.
 *
 * Раньше каталог считался как `<projectRoot>/../src/skills`, то есть проект
 * должен был лежать внутри установки workflow-ai. Для обычной раскладки
 * (проекты в одном каталоге, workflow-ai — зависимость) такого пути нет, и
 * функция молча возвращала пустой список — независимо от того, сколько скилов
 * реально подключено к проекту.
 *
 * @param {string} [projectRoot] - Project root directory. If not provided, will be auto-detected.
 * @param {Object} [options]
 * @param {string} [options.globalSkillsDir] - Переопределение каталога общих скилов (для тестов).
 * @returns {Promise<Array<{name: string, path: string, source: 'shared' | 'ejected'}>>}
 */
export async function listSkills(projectRoot, options = {}) {
  // Auto-detect project root if not provided
  if (!projectRoot) {
    projectRoot = findProjectRoot();
  }

  const globalSkillsDir = options.globalSkillsDir ?? join(getGlobalDir(), 'skills');

  // Project skills directory
  const projectSkillsDir = join(projectRoot, '.workflow', 'src', 'skills');

  const result = [];

  /**
   * Скил — каталог со SKILL.md. Без этой проверки скилом считался любой
   * подкаталог: в `.workflow/src/skills` проектов лежит, например, папка
   * `shared` с общими документами, и она попадала в выдачу как `ejected`.
   *
   * @param {string} dir каталог со скилами
   * @returns {string[]} имена скилов
   */
  const readSkillNames = (dir) => readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')))
    .map(entry => entry.name);

  // Каталога общих скилов может не быть вовсе — например, когда workflow-ai
  // стоит зависимостью и `workflow init` не запускался. Скилы, скопированные
  // в проект, от этого никуда не деваются, и раньше они терялись.
  if (!existsSync(globalSkillsDir)) {
    if (existsSync(projectSkillsDir)) {
      for (const skillName of readSkillNames(projectSkillsDir)) {
        result.push({
          name: skillName,
          path: join(projectSkillsDir, skillName),
          source: 'ejected'
        });
      }
    }
    return result;
  }

  // Read global skills
  const globalSkills = readSkillNames(globalSkillsDir);

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
      const projectSkills = readSkillNames(projectSkillsDir);

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
      const projectSkills = readSkillNames(projectSkillsDir);

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