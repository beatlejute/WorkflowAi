import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * Finds the project root by searching for `.workflow/` directory
 * walking up from the given start directory.
 *
 * @param {string} [startDir=process.cwd()] - Starting directory path
 * @returns {string} Absolute path to project root
 * @throws {Error} If `.workflow/` directory is not found within 20 levels
 */
export function findProjectRoot(startDir = process.cwd()) {
  let current = resolve(startDir);
  let iterations = 0;
  const MAX_DEPTH = 20;

  while (iterations < MAX_DEPTH) {
    if (existsSync(resolve(current, '.workflow'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root
      break;
    }
    current = parent;
    iterations++;
  }

  throw new Error(
    `Could not find .workflow/ directory. Run "workflow init" first.\nStarted from: ${startDir}`
  );
}
