import YAML from 'js-yaml';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Парсит YAML frontmatter из markdown-файла.
 *
 * @param {string} content - Содержимое markdown-файла
 * @returns {{ frontmatter: object, body: string }} Объект с frontmatter и телом документа
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterStr = match[1];
  const body = match[2];

  try {
    const frontmatter = YAML.load(frontmatterStr);
    return { frontmatter, body };
  } catch (e) {
    throw new Error(`Failed to parse frontmatter: ${e.message}`);
  }
}

/**
 * Сериализует объект frontmatter обратно в YAML-строку.
 *
 * @param {object} frontmatter - Объект frontmatter
 * @returns {string} YAML-строка с обрамлением ---
 */
export function serializeFrontmatter(frontmatter) {
  const yamlStr = YAML.dump(frontmatter, {
    lineWidth: -1, // Не переносить длинные строки
    quotingType: '"',
    forceQuotes: false
  });
  return `---\n${yamlStr}---\n`;
}

/**
 * Форматирует и выводит объект результата в stdout.
 *
 * @param {object} result - Объект результата для вывода
 */
export function printResult(result) {
  console.log('---RESULT---');
  for (const [key, value] of Object.entries(result)) {
    console.log(`${key}: ${value}`);
  }
  console.log('---RESULT---');
}

/**
 * Возвращает абсолютный путь к корню npm-пакета через import.meta.url.
 *
 * @returns {string} Абсолютный путь к корню пакета
 */
export function getPackageRoot() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // result/src/lib → result
  return path.resolve(__dirname, '../../');
}
