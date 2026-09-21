import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Версия пакета workflow-ai из его package.json.
 *
 * Единый источник для CLI (`workflow version`) и для поля `pipeline_version`
 * в `.workflow/logs/.pipeline.lock`. Путь разрешается от самого модуля, поэтому
 * работает и при установке пакета симлинком (`npm link`).
 *
 * @returns {string} версия либо '' — если package.json недоступен
 */
export function packageVersion() {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '';
  } catch {
    return '';
  }
}
