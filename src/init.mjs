import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, appendFileSync, symlinkSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getGlobalDir, ensureGlobalDir } from './global-dir.mjs';
import { createSkillJunctions, createScriptJunction, createConfigJunction, createRailsJunction } from './junction-manager.mjs';

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
    'review-result': 'Ревью результата',
    'coach': 'Коуч скилов',
    'deep-research': 'Глубокий ресерч'
  };
  
  let table = '| Задача | Инструкция |\n|--------|------------|\n';
  
  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
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
 * @param {string} packageRoot - Путь к корню пакета
 */
function generateClaudeMd(workflowRoot, projectRoot, packageRoot) {
  const templatePath = join(packageRoot, 'agent-templates', 'CLAUDE.md.tpl');
  const destPath = join(projectRoot, 'CLAUDE.md');
  
  let content;
  if (existsSync(templatePath)) {
    content = readFileSync(templatePath, 'utf-8');
  } else {
    // Default template
    content = `# Инструкции для Claude Code

Проект ведёт workflow-ai: канбан, планы и отчёты — в \`.workflow/\`, настройки — \`.workflow/config/config.yaml\`.

## Доступные Skills

{{SKILLS_TABLE}}

## Тикеты

Декомпозицию, выполнение и перенос тикетов между колонками делает пайплайн (\`workflow run\`); вне его стадий — только составлять планы в \`.workflow/plans/current/\`. Тикет, выполненный человеком, — в \`review/\`, не в \`done/\`: ревью делает пайплайн.

## Код

Код — по TDD, SOLID, DRY.
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
 * @param {string} packageRoot - Путь к корню пакета
 */
function generateQwenMd(workflowRoot, projectRoot, packageRoot) {
  const templatePath = join(packageRoot, 'agent-templates', 'QWEN.md.tpl');
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
 * Генерирует .kilocodemodes из шаблона agent-templates/kilocodemodes.tpl.
 *
 * @param {string} projectRoot - Путь к корню проекта
 * @param {string} packageRoot - Путь к корню пакета
 */
function generateKilocodemodes(projectRoot, packageRoot) {
  const templatePath = join(packageRoot, 'agent-templates', 'kilocodemodes.tpl');
  const destPath = join(projectRoot, '.kilocodemodes');

  if (existsSync(templatePath)) {
    copyFileSync(templatePath, destPath);
  }
}

/**
 * Обновляет .gitignore, добавляя указанные строки.
 *
 * @param {string} projectRoot - Путь к корню проекта
 */
function updateGitignore(projectRoot) {
  const gitignorePath = join(projectRoot, '.gitignore');
  const linesToAdd = [
    '',
    '# Workflow AI specific',
    '.workflow-state/',
    '.cache/',
    '.workflow/',
    '.workflow/state/',
    '',
    '# AI',
    'QWEN.md',
    'CLAUDE.md',
    '.kilocode/',
    '.kilocodemodes',
  ];
  
  let currentContent = '';
  if (existsSync(gitignorePath)) {
    currentContent = readFileSync(gitignorePath, 'utf-8');
  }
  
  const existingLines = currentContent.split('\n').map(line => line.trim());
  
  const newLines = linesToAdd.filter(line => line === '' || !existingLines.includes(line));
  if (newLines.some(line => line !== '')) {
    appendFileSync(gitignorePath, newLines.join('\n') + '\n');
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Убирает из массива matcher-групп `hooks[event]` записи, добавленные rails
 * (`_workflow_rails: true`), не трогая чужие. Группа, целиком состоявшая из
 * наших записей, удаляется полностью; группа с чужими записями сохраняется
 * без наших. Так повторный `writeClaudeHooks` идемпотентен и не накапливает
 * дубликаты (rails/README.md §11: «повторный init заменяет только их»).
 *
 * @param {Array<object>} groups
 * @returns {Array<object>}
 */
function stripRailsHookGroups(groups) {
  const out = [];
  for (const group of groups) {
    if (!isPlainObject(group)) {
      out.push(group);
      continue;
    }
    const list = Array.isArray(group.hooks) ? group.hooks : [];
    const wasOnlyOurs = list.length > 0 && list.every((h) => isPlainObject(h) && h._workflow_rails === true);
    if (wasOnlyOurs) {
      continue;
    }
    const filtered = list.filter((h) => !(isPlainObject(h) && h._workflow_rails === true));
    out.push(filtered.length === list.length ? group : { ...group, hooks: filtered });
  }
  return out;
}

/**
 * Регистрирует хуки rails в `<projectRoot>/.claude/settings.local.json`
 * (rails/README.md §9.1, §11). Сливает ключ `hooks`: свои записи помечает
 * `_workflow_rails: true` и на повторном вызове заменяет только их — чужие
 * хуки и остальные ключи settings не трогает. Путь к хуку — абсолютный,
 * `node "<projectRoot>/.workflow/src/rails/claude-hook.mjs"`.
 *
 * Идемпотентна: повторный вызов с тем же `projectRoot` даёт тот же результат.
 *
 * @param {string} projectRoot
 * @returns {string} путь к обновлённому settings.local.json
 */
export function writeClaudeHooks(projectRoot, { hookScript: hookScriptOverride = null, settingsPath: settingsPathOverride = null } = {}) {
  // settingsPath по умолчанию — проектный settings.local.json; override — пользовательский
  // `~/.claude/settings.json` (одна регистрация на машину, register-rails.js --user).
  const settingsPath = settingsPathOverride || join(projectRoot, '.claude', 'settings.local.json');
  ensureDir(dirname(settingsPath));

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (isPlainObject(parsed)) settings = parsed;
    } catch {
      // Битый JSON — не наш файл. §11 запрещает трогать чужие ключи, а начать
      // с пустого объекта значит их стереть (перезаписать поверх невалидного
      // содержимого своим). Ничего не пишем и возвращаем null — вызывающий
      // код (initProject) обязан не считать шаг успешным и не звать
      // writeKiloPluginLoader молча следом.
      return null;
    }
  }

  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    // Чужой settings.hooks не объект (массив/строка/число) — та же защита,
    // что для битого JSON: подменить его пустым объектом значит стереть
    // чужое значение (§11 «чужие ключи не трогать»). Ничего не пишем.
    return null;
  }

  // hookScript по умолчанию — ядро rails проекта через junction; override — для
  // регистрации на уровне каталога-зонтика над проектами (путь к ~/.workflow/rails).
  const hookScript = hookScriptOverride || join(projectRoot, '.workflow', 'src', 'rails', 'claude-hook.mjs');
  const command = `node "${hookScript}"`;
  // PreToolUse/PostToolUse — matcher это имя инструмента (Bash, Edit, …), '*'
  // документированно означает «все». Для Stop/UserPromptSubmit/SessionStart
  // matcher — не имя инструмента (для SessionStart это source: startup|resume|
  // clear), приём '*' там канарейкой не проверен (rails/README.md §9.1) —
  // группа пишется без поля matcher вовсе.
  const matcherEvents = new Set(['PreToolUse', 'PostToolUse']);
  const events = ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart'];

  const hooks = isPlainObject(settings.hooks) ? { ...settings.hooks } : {};
  for (const event of events) {
    const existingValue = hooks[event];
    if (existingValue !== undefined && !Array.isArray(existingValue)) {
      // Чужой формат этого события (не массив matcher-групп) — не трогаем,
      // пропускаем событие целиком, значение остаётся как было.
      continue;
    }
    const kept = stripRailsHookGroups(existingValue || []);
    const ourHooks = [{ type: 'command', command, _workflow_rails: true }];
    kept.push(matcherEvents.has(event) ? { matcher: '*', hooks: ourHooks } : { hooks: ourHooks });
    hooks[event] = kept;
  }

  settings.hooks = hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return settingsPath;
}

/**
 * Есть ли уже хуки rails в пользовательском `~/.claude/settings.json` (одна регистрация
 * на машину, `register-rails.js --user`). Тогда проектные/workdir-хуки лишние: тот же вызов
 * пришёл бы дважды (core дедуплицирует по tool_use_id, но процесс хука всё равно платится).
 *
 * @param {string} [settingsPath]
 * @returns {boolean}
 */
export function userHasRailsHooks(settingsPath = join(homedir(), '.claude', 'settings.json')) {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hooks = isPlainObject(parsed) && isPlainObject(parsed.hooks) ? parsed.hooks : {};
    return Object.values(hooks).some((groups) => Array.isArray(groups)
      && groups.some((g) => isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isPlainObject(h) && h._workflow_rails === true)));
  } catch {
    return false;
  }
}

/**
 * Снимает записи rails (`_workflow_rails: true`) из settings; чужие хуки и ключи не трогает.
 * Событие без оставшихся групп удаляется, пустой `hooks` — тоже. Возвращает путь или null
 * (файла нет, битый JSON, чужой формат `hooks` — ничего не пишем).
 *
 * @param {string} projectRoot
 * @param {{settingsPath?: string}} [options]
 * @returns {string|null}
 */
export function removeClaudeHooks(projectRoot, { settingsPath: settingsPathOverride = null } = {}) {
  const settingsPath = settingsPathOverride || join(projectRoot, '.claude', 'settings.local.json');
  if (!existsSync(settingsPath)) return null;
  let settings;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!isPlainObject(parsed)) return null;
    settings = parsed;
  } catch {
    return null;
  }
  if (!isPlainObject(settings.hooks)) return null;
  const hooks = { ...settings.hooks };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = stripRailsHookGroups(groups);
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return settingsPath;
}

/**
 * Пишет загрузчик Kilo-плагина rails: `<projectRoot>/.kilo/plugin/workflow-rails.js`
 * (rails/README.md §9.2, §11). Содержимое фиксированное — повторный вызов
 * идемпотентен (перезаписывает тем же текстом).
 *
 * @param {string} projectRoot
 * @returns {string} путь к загрузчику
 */
export function writeKiloPluginLoader(projectRoot) {
  const pluginDir = join(projectRoot, '.kilo', 'plugin');
  ensureDir(pluginDir);
  const loaderPath = join(pluginDir, 'workflow-rails.js');
  const content = 'export { WorkflowRails } from "../../.workflow/src/rails/kilo-plugin.mjs";\n';
  writeFileSync(loaderPath, content, 'utf-8');
  return loaderPath;
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
  
  // Step 1: Create .workflow/ structure (directories)
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
    'src/skills',
    'tests/skills',
    'state'
  ];

  for (const dir of directories) {
    ensureDir(join(workflowRoot, dir));
  }
  result.steps.push(`Created .workflow/ directory structure (${directories.length} directories)`);

   // Create .gitkeep in .workflow/tests/skills/
   // FIX-9: Ensure .gitkeep exists for tests/skills directory
   const testsSkillsGitkeep = join(workflowRoot, 'tests', 'skills', '.gitkeep');
   if (!existsSync(testsSkillsGitkeep)) {
     writeFileSync(testsSkillsGitkeep, '');
   }

  // Step 2: Ensure global dir and create skill junctions
  const globalDir = getGlobalDir();
  ensureGlobalDir(packageRoot);
  const srcSkillsDest = join(workflowRoot, 'src', 'skills');
  createSkillJunctions(globalDir, srcSkillsDest);
  result.steps.push('Created skill junctions from global dir → .workflow/src/skills/');

  // Step 3: Create script junction
  const srcScriptsDest = join(workflowRoot, 'src', 'scripts');
  createScriptJunction(globalDir, srcScriptsDest);
  result.steps.push('Created script junction from global dir → .workflow/src/scripts/');

  // Step 4: rails (rails/README.md §11) — junction ядра + регистрация хуков.
  // Регистрацию хуков выполняет только человек командой `workflow init`
  // (принцип 17 концепции «Рельсы для агента») — initProject() сам по себе
  // ничего не запускает и не отправляет, только пишет конфиги на диск.
  const srcRailsDest = join(workflowRoot, 'src', 'rails');
  createRailsJunction(globalDir, srcRailsDest);
  // Хуки регистрируем только когда ядро rails реально доступно по этому
  // пути (через junction на globalDir/rails, эжектнутую копию или уже
  // существующий каталог) — иначе settings.local.json получит команду на
  // несуществующий адаптер (claude-hook.mjs ещё не реализован в этом WP —
  // README §1), и каждый tool-call начнёт падать. Проверяем не конкретный
  // файл, а что каталог вообще не пуст — createRailsJunction молча выходит
  // без источника (пустой ~/.workflow/rails или его отсутствие).
  let railsCoreAvailable = false;
  try {
    railsCoreAvailable = existsSync(srcRailsDest) && readdirSync(srcRailsDest).length > 0;
  } catch {
    railsCoreAvailable = false;
  }
  if (railsCoreAvailable) {
    result.steps.push('Created rails junction from global dir → .workflow/src/rails/');
    const hooksPath = writeClaudeHooks(projectRoot);
    if (hooksPath) {
      result.steps.push('Registered rails hooks in .claude/settings.local.json');
    } else {
      result.errors.push('.claude/settings.local.json не изменён (невалидный JSON либо settings.hooks не объект) — хуки rails не зарегистрированы');
    }
    writeKiloPluginLoader(projectRoot);
    result.steps.push('Wrote rails plugin loader → .kilo/plugin/workflow-rails.js');
  } else {
    result.steps.push('Skipped rails hooks: ядро rails недоступно в .workflow/src/rails/ (нет в глобальной установке ~/.workflow/rails — обновите пакет/глобальную установку и повторите workflow init)');
  }

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
  
  // Step 6: Create config junction
  const configDest = join(workflowRoot, 'config');
  createConfigJunction(globalDir, configDest);
  result.steps.push('Created config junction from global dir → .workflow/config/');

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
  
  // Step 8: Generate CLAUDE.md, QWEN.md and .kilocodemodes
  generateClaudeMd(workflowRoot, projectRoot, packageRoot);
  generateQwenMd(workflowRoot, projectRoot, packageRoot);
  generateKilocodemodes(projectRoot, packageRoot);
  result.steps.push('Generated CLAUDE.md, QWEN.md and .kilocodemodes from agent-templates');
  
  // Step 9: Update .gitignore
  updateGitignore(projectRoot);
  result.steps.push('Updated .gitignore with .workflow/logs/');

  // Step 10: Copy agent-health-rules.yaml to .workflow/config/
  const agentHealthRulesSrc = join(packageRoot, 'configs', 'agent-health-rules.yaml');
  const agentHealthRulesDest = join(workflowRoot, 'config', 'agent-health-rules.yaml');
  if (existsSync(agentHealthRulesSrc)) {
    ensureDir(dirname(agentHealthRulesDest));
    copyFileSync(agentHealthRulesSrc, agentHealthRulesDest);
    result.steps.push('Copied agent-health-rules.yaml → .workflow/config/');
  }

  return result;
}

export default initProject;
