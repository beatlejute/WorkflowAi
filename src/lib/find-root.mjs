import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getGlobalDir } from '../global-dir.mjs';

/** Windows сравнивает пути без учёта регистра, POSIX — с учётом. */
function samePath(a, b) {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * Finds the project root by searching for `.workflow/` directory
 * walking up from the given start directory.
 *
 * Глобальная директория (`~/.workflow`, она же `WORKFLOW_HOME`) проектом не
 * считается: это установочный каталог с junction'ами на скилы, скрипты и
 * конфиги. Иначе любая команда, запущенная где угодно под домашней папкой —
 * включая песочницы в os.tmpdir() — молча резолвила корень в неё и писала туда
 * тикеты, логи и метрики вместо того, чтобы честно упасть.
 *
 * @param {string} [startDir=process.cwd()] - Starting directory path
 * @returns {string} Absolute path to project root
 * @throws {Error} If `.workflow/` directory is not found within 20 levels
 */
export function findProjectRoot(startDir = process.cwd()) {
  let current = resolve(startDir);
  let iterations = 0;
  const MAX_DEPTH = 20;
  const globalDir = resolve(getGlobalDir());

  while (iterations < MAX_DEPTH) {
    const candidate = resolve(current, '.workflow');
    if (existsSync(candidate) && !samePath(candidate, globalDir)) {
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
