import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, appendFileSync, symlinkSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Возвращает абсолютный путь к корню npm-пакета через import.meta.url.
 *
 * @returns {string} Абсолютный путь к корню пакета
 */
function getPackageRoot() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // result/src → result
  return resolve(__dirname, '../');
}

/**
 * Создаёт директорию если она не существует.
 *
 * @param {string} dirPath - Путь к директории
 */
function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Копирует файл из источника в назначение.
 *
 * @param {string} src - Исходный путь
 * @param {string} dest - Путь назначения
 */
function copyFile(src, dest) {
  const destDir = dirname(dest);
  ensureDir(destDir);
  copyFileSync(src, dest);
}

/**
 * Рекурсивно копирует директорию.
 *
 * @param {string} srcDir - Исходная директория
 * @param {string} destDir - Директория назначения
 */
function copyDirRecursive(srcDir, destDir) {
  ensureDir(destDir);
  
  const entries = [];
  try {
    const dirEntries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      entries.push(entry);
    }
  } catch (e) {
    // Directory doesn't exist, skip
    return;
  }
  
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

/**
 * Генерирует таблицу skills из директории .workflow/src/skills/.
 *
 * @param {string} workflowRoot - Путь к корню .workflow
 * @returns {string} Markdown-таблица с навыками
 */
function generateSkillsTable(workflowRoot) {
  const skillsDir = join(workflowRoot, 'src', 'skills');
  
  if (!existsSync(skillsDir)) {
    return '| Задача | Инструкция |\n|--------|------------|\n';
  }
  
  const skillsMap = {
    'create-plan': 'Создание плана',
    'analyze-report': 'Анализ отчёта',
    'decompose-plan': 'Декомпозиция плана',
    'check-conditions': 'Проверка готовности',
    'create-report': 'Создание отчёта',
    'execute-task': 'Выполнение задачи',
    'move-ticket': 'Перемещение тикета',
    'pick-next-task': 'Выбор следующей задачи',
    'decompose-gaps': 'Декомпозиция пробелов',
    'review-result': 'Ревью результата'
  };
  
  let table = '| Задача | Инструкция |\n|--------|------------|\n';
  
  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  
  for (const skillDir of skillDirs) {
    const description = skillsMap[skillDir] || skillDir;
    const instruction = `.workflow/src/skills/${skillDir}/SKILL.md`;
    table += `| ${description} | \`${instruction}\` |\n`;
  }
  
  return table;
}

/**
 * Генерирует CLAUDE.md из шаблона.
 *
 * @param {string} workflowRoot - Путь к корню .workflow
 * @param {string} projectRoot - Путь к корню проекта
 */
function generateClaudeMd(workflowRoot, projectRoot) {
  const templatePath = join(workflowRoot, 'templates', 'agent-templates', 'CLAUDE.md.tpl');
  const destPath = join(projectRoot, 'CLAUDE.md');
  
  let content;
  if (existsSync(templatePath)) {
    content = readFileSync(templatePath, 'utf-8');
  } else {
    // Default template
    content = `# Инструкции для Claude Code

Этот проект использует систему координации AI-агентов через файловую канбан-доску.

## Структура проекта

- \`.workflow/\` — канбан-доска с тикетами
- \`.workflow/src/skills/\` — инструкции для выполнения задач

## Доступные Skills

{{SKILLS_TABLE}}

## Workflow

1. **Планирование**: Создай план в \`.workflow/plans/current/\`
2. **Декомпозиция**: Разбей план на тикеты в \`.workflow/tickets/backlog/\`
3. **Выполнение**: Бери задачи из \`ready/\`, выполняй, перемещай в \`done/\`
4. **Отчётность**: Создавай отчёты в \`.workflow/reports/\`

## Шаблоны

- \`.workflow/templates/ticket-template.md\` — шаблон тикета
- \`.workflow/templates/plan-template.md\` — шаблон плана
- \`.workflow/templates/report-template.md\` — шаблон отчёта

## Конфигурация

Настройки в \`.workflow/config/config.yaml\`

## Правила написания кода
При написании кода использовать методологии TDD, SOLID, DRY
`;
  }
  
  const skillsTable = generateSkillsTable(workflowRoot);
  content = content.replace('{{SKILLS_TABLE}}', skillsTable);
  
  writeFileSync(destPath, content, 'utf-8');
}

/**
 * Генерирует QWEN.md из шаблона.
 *
 * @param {string} workflowRoot - Путь к корню .workflow
 * @param {string} projectRoot - Путь к корню проекта
 */
function generateQwenMd(workflowRoot, projectRoot) {
  const templatePath = join(workflowRoot, 'templates', 'agent-templates', 'QWEN.md.tpl');
  const destPath = join(projectRoot, 'QWEN.md');
  
  let content;
  if (existsSync(templatePath)) {
    content = readFileSync(templatePath, 'utf-8');
  } else {
    // Default template
    content = `# Инструкции для qwen Code

Этот проект использует систему координации AI-агентов через файловую канбан-доску.

## Структура проекта

- \`.workflow/\` — канбан-доска с тикетами
- \`.workflow/src/skills/\` — инструкции для выполнения задач

## Доступные Skills

{{SKILLS_TABLE}}

## Workflow

1. **Планирование**: Создай план в \`.workflow/plans/current/\`
2. **Декомпозиция**: Разбей план на тикеты в \`.workflow/tickets/backlog/\`
3. **Выполнение**: Бери задачи из \`ready/\`, выполняй, перемещай в \`done/\`
4. **Отчётность**: Создавай отчёты в \`.workflow/reports/\`

## Шаблоны

- \`.workflow/templates/ticket-template.md\` — шаблон тикета
- \`.workflow/templates/plan-template.md\` — шаблон плана
- \`.workflow/templates/report-template.md\` — шаблон отчёта

## Конфигурация

Настройки в \`.workflow/config/config.yaml\`

## Правила написания кода
При написании кода использовать методологии TDD, SOLID, DRY
`;
  }
  
  const skillsTable = generateSkillsTable(workflowRoot);
  content = content.replace('{{SKILLS_TABLE}}', skillsTable);
  
  writeFileSync(destPath, content, 'utf-8');
}

/**
 * Обновляет .gitignore, добавляя указанные строки.
 *
 * @param {string} projectRoot - Путь к корню проекта
 */
function updateGitignore(projectRoot) {
  const gitignorePath = join(projectRoot, '.gitignore');
  const linesToAdd = ['.workflow/logs/'];
  
  let currentContent = '';
  if (existsSync(gitignorePath)) {
    currentContent = readFileSync(gitignorePath, 'utf-8');
  }
  
  const existingLines = currentContent.split('\n').map(line => line.trim());
  
  for (const line of linesToAdd) {
    if (!existingLines.includes(line)) {
      appendFileSync(gitignorePath, line + '\n');
    }
  }
}

/**
 * Создаёт симлинки .kilocode.
 *
 * @param {string} projectRoot - Путь к корню проекта
 * @param {boolean} force - Принудительное создание
 * @returns {{ success: boolean, warning?: string }} Результат операции
 */
function createKilocodeSymlinks(projectRoot, force = false) {
  const kilocodeDir = join(projectRoot, '.kilocode');
  const skillsTarget = join(projectRoot, '.workflow', 'src', 'skills');
  const skillsLink = join(kilocodeDir, 'skills');
  
  ensureDir(kilocodeDir);
  
  const isWindows = process.platform === 'win32';
  
  try {
    // Remove existing link if exists
    if (existsSync(skillsLink)) {
      const stats = statSync(skillsLink);
      if (stats.isSymbolicLink() || stats.isDirectory()) {
        try {
          if (isWindows) {
            execSync(`rmdir "${skillsLink}"`);
          } else {
            unlinkSync(skillsLink);
          }
        } catch (e) {
          // Ignore errors
        }
      }
    }
    
    if (isWindows) {
      // Windows: use Junction Point
      try {
        execSync(`mklink /J "${skillsLink}" "${skillsTarget}"`);
        return { success: true };
      } catch (e) {
        // Fallback: copy directory
        copyDirRecursive(skillsTarget, skillsLink);
        return { 
          success: true, 
          warning: 'Junction Point creation failed, copied files instead' 
        };
      }
    } else {
      // Linux/macOS: use symlink
      symlinkSync(skillsTarget, skillsLink);
      return { success: true };
    }
  } catch (e) {
    return { 
      success: false, 
      warning: `Failed to create symlink: ${e.message}` 
    };
  }
}

/**
 * Инициализирует проект, создавая структуру .workflow/ и копируя файлы.
 *
 * @param {string} targetPath - Путь к целевому проекту (по умолчанию process.cwd())
 * @param {object} options - Опции инициализации
 * @param {boolean} options.force - Принудительная перезапись файлов
 * @returns {object} Результат инициализации
 */
export function initProject(targetPath = process.cwd(), options = {}) {
  const { force = false } = options;
  const projectRoot = resolve(targetPath);
  const workflowRoot = join(projectRoot, '.workflow');
  const packageRoot = getPackageRoot();
  
  const result = {
    steps: [],
    warnings: [],
    errors: []
  };
  
  // Step 1: Create .workflow/ structure (17 directories)
  const directories = [
    'tickets/backlog',
    'tickets/ready',
    'tickets/in-progress',
    'tickets/blocked',
    'tickets/review',
    'tickets/done',
    'plans/current',
    'plans/archive',
    'reports',
    'logs',
    'templates',
    'config',
    'src/skills',
    'src/scripts',
    'src/lib'
  ];
  
  for (const dir of directories) {
    ensureDir(join(workflowRoot, dir));
  }
  result.steps.push('Created .workflow/ directory structure (17 directories)');
  
  // Step 2: Copy skills recursively
  const srcSkillsSrc = join(packageRoot, 'src', 'skills');
  const srcSkillsDest = join(workflowRoot, 'src', 'skills');
  copyDirRecursive(srcSkillsSrc, srcSkillsDest);
  result.steps.push('Copied skills from getPackageRoot()/src/skills/ → .workflow/src/skills/');
  
  // Step 3: Copy scripts
  const srcScriptsSrc = join(packageRoot, 'src', 'scripts');
  const srcScriptsDest = join(workflowRoot, 'src', 'scripts');
  copyDirRecursive(srcScriptsSrc, srcScriptsDest);
  result.steps.push('Copied scripts from getPackageRoot()/src/scripts/ → .workflow/src/scripts/');
  
  // Step 4: Copy lib (utils.mjs + find-root.mjs)
  const libSrc = join(packageRoot, 'src', 'lib');
  const libDest = join(workflowRoot, 'src', 'lib');
  ensureDir(libDest);
  
  const utilsSrc = join(libSrc, 'utils.mjs');
  const findRootSrc = join(libSrc, 'find-root.mjs');
  
  if (existsSync(utilsSrc)) {
    copyFile(utilsSrc, join(libDest, 'utils.mjs'));
  }
  if (existsSync(findRootSrc)) {
    copyFile(findRootSrc, join(libDest, 'find-root.mjs'));
  }
  result.steps.push('Copied lib files (utils.mjs, find-root.mjs) → .workflow/src/lib/');
  
  // Step 5: Copy templates (3 templates)
  const templatesSrc = join(packageRoot, 'templates');
  const templatesDest = join(workflowRoot, 'templates');
  ensureDir(templatesDest);
  
  const templateFiles = ['ticket-template.md', 'plan-template.md', 'report-template.md'];
  for (const template of templateFiles) {
    const srcPath = join(templatesSrc, template);
    const destPath = join(templatesDest, template);
    if (existsSync(srcPath)) {
      copyFile(srcPath, destPath);
    }
  }
  result.steps.push('Copied 3 templates → .workflow/templates/');
  
  // Step 6: Generate config files
  const configDest = join(workflowRoot, 'config');
  ensureDir(configDest);
  
  // config.yaml — only if not exists (fresh only)
  const configYamlDest = join(configDest, 'config.yaml');
  if (!existsSync(configYamlDest) || force) {
    const configYamlSrc = join(packageRoot, 'configs', 'config.yaml');
    if (existsSync(configYamlSrc)) {
      copyFile(configYamlSrc, configYamlDest);
      result.steps.push('Generated config.yaml (fresh)');
    }
  } else {
    result.warnings.push('config.yaml already exists, skipped (use --force to overwrite)');
  }
  
  // pipeline.yaml — always
  const pipelineSrc = join(packageRoot, 'configs', 'pipeline.yaml');
  if (existsSync(pipelineSrc)) {
    copyFile(pipelineSrc, join(configDest, 'pipeline.yaml'));
    result.steps.push('Generated pipeline.yaml (overwritten)');
  }
  
  // Step 7: Create .kilocode symlinks
  const symlinkResult = createKilocodeSymlinks(projectRoot, force);
  if (symlinkResult.success) {
    result.steps.push('Created .kilocode symlinks (Junction Point on Windows)');
    if (symlinkResult.warning) {
      result.warnings.push(symlinkResult.warning);
    }
  } else {
    result.errors.push(symlinkResult.warning || 'Failed to create .kilocode symlinks');
  }
  
  // Step 8: Generate CLAUDE.md and QWEN.md
  generateClaudeMd(workflowRoot, projectRoot);
  generateQwenMd(workflowRoot, projectRoot);
  result.steps.push('Generated CLAUDE.md and QWEN.md from agent-templates');
  
  // Step 9: Update .gitignore
  updateGitignore(projectRoot);
  result.steps.push('Updated .gitignore with .workflow/logs/');

  return result;
}

export default initProject;
