import { parseFrontmatter } from '../utils.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

/**
 * List all plans in plans/current and plans/archive directories.
 * @param {string} projectRoot - Absolute path to project root
 * @param {{ status?: string }} [options] - Filter options
 * @returns {Promise<Array<{id: string, title: string, status: string, path: string}>>}
 */
export async function listPlans(projectRoot, { status } = {}) {
  const plansDirs = [
    path.join(projectRoot, 'plans', 'current'),
    path.join(projectRoot, 'plans', 'archive')
  ];

  const allPlans = [];

  for (const plansDir of plansDirs) {
    try {
      const files = await fs.readdir(plansDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(plansDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        if (status && frontmatter.status !== status) continue;
        allPlans.push({
          id: frontmatter.id || file.replace('.md', ''),
          title: frontmatter.title || '',
          status: frontmatter.status || 'unknown',
          path: filePath
        });
      }
    } catch (err) {
      // If directory doesn't exist, just skip it
      if (err.code !== 'ENOENT') throw err;
    }
  }

  return allPlans;
}

/**
 * Get a specific plan by ID.
 * @param {string} projectRoot - Absolute path to project root
 * @param {string} planId - Plan ID (e.g., 'PLAN-001')
 * @returns {Promise<{frontmatter: object, body: string, path: string}>}
 * @throws {Error} With code 'PLAN_NOT_FOUND' if plan not found
 */
export async function getPlan(projectRoot, planId) {
  const plansDirs = [
    path.join(projectRoot, 'plans', 'current'),
    path.join(projectRoot, 'plans', 'archive')
  ];

  for (const plansDir of plansDirs) {
    try {
      const files = await fs.readdir(plansDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        // Normalize file name to plan ID format for comparison
        const fileId = file.replace('.md', '');
        if (fileId === planId || fileId.toUpperCase() === planId.toUpperCase()) {
          const filePath = path.join(plansDir, file);
          const content = await fs.readFile(filePath, 'utf8');
          const { frontmatter, body } = parseFrontmatter(content);
          return {
            frontmatter,
            body,
            path: filePath
          };
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  const error = new Error(`Plan not found: ${planId}`);
  error.code = 'PLAN_NOT_FOUND';
  error.planId = planId;
  throw error;
}