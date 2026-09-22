#!/usr/bin/env node
/**
 * Регистрация rails в проекте — только руками человека (rails/README.md §11,
 * принцип 17 концепции: агент хуки себе не регистрирует).
 *
 * Делает ровно три вещи, без остального `workflow init`:
 *   1. junction `<root>/.workflow/src/rails` → `<globalDir>/rails`;
 *   2. хуки Claude Code в `<root>/.claude/settings.local.json` (слияние, метка `_workflow_rails`);
 *   3. загрузчик Kilo-плагина `<root>/.kilo/plugin/workflow-rails.js`;
 * плюс `.workflow/state/` в `.gitignore`.
 *
 * Использование: node src/scripts/register-rails.js [<projectRoot>]
 * Глобальный каталог — WORKFLOW_HOME или ~/.workflow; `<globalDir>/rails` должен существовать
 * (копия из пакета через `workflow update`, либо junction на канон: mklink /J).
 */
import { existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGlobalDir } from '../global-dir.mjs';
import { createRailsJunction } from '../junction-manager.mjs';
import { writeClaudeHooks, writeKiloPluginLoader, removeClaudeHooks } from '../init.mjs';
import { realpathDeep } from '../rails/paths.mjs';

/** Пользовательский settings Claude Code — одна регистрация на машину. */
export function userSettingsPath() {
  return join(homedir(), '.claude', 'settings.json');
}

/** Снять хуки rails: с проекта (settings.local.json) или с пользователя (`--user`). */
export function unregisterRails(projectRoot, { user = false } = {}) {
  const root = user ? homedir() : resolve(projectRoot);
  const settingsPath = user ? userSettingsPath() : null;
  return removeClaudeHooks(root, settingsPath ? { settingsPath } : {});
}

export function registerRails(projectRoot, { umbrella = false, user = false } = {}) {
  const root = user ? homedir() : resolve(projectRoot);
  const globalDir = getGlobalDir();
  const globalRails = join(globalDir, 'rails');
  if (!existsSync(globalRails) || readdirSync(globalRails).length === 0) {
    throw new Error(`${globalRails} отсутствует или пуст — обнови глобальную установку (workflow update) или создай junction на канон`);
  }
  if (user) {
    // ~/.claude/settings.json действует на все сессии машины; хук молчит вне проектов
    // с .workflow/ и для делегатов. Путь — глобальное ядро.
    const settings = writeClaudeHooks(root, { hookScript: join(globalRails, 'claude-hook.mjs'), settingsPath: userSettingsPath() });
    if (!settings) throw new Error(`${userSettingsPath()}: не удалось слить hooks (битый JSON или чужой формат hooks)`);
    return { root, railsDir: null, settings, loader: null, umbrella: true, user: true };
  }
  if (umbrella) {
    // Каталог-зонтик над проектами (сессия Claude Code стартует из него): только хуки
    // Claude с путём к глобальному ядру; скоуп по каталогу и корень от пути цели
    // (core.decide) ограничат действие проектами с .workflow/. Kilo читает конфиг проекта.
    const settings = writeClaudeHooks(root, { hookScript: join(globalRails, 'claude-hook.mjs') });
    if (!settings) throw new Error(`${root}: .claude/settings.local.json не удалось слить (битый JSON или чужой формат hooks)`);
    return { root, railsDir: null, settings, loader: null, umbrella: true };
  }
  if (!existsSync(join(root, '.workflow'))) {
    throw new Error(`${root}: нет .workflow/ — сначала workflow init (или --umbrella для каталога над проектами)`);
  }
  const railsDir = join(root, '.workflow', 'src', 'rails');
  createRailsJunction(globalDir, railsDir);
  if (!existsSync(join(railsDir, 'claude-hook.mjs'))) {
    throw new Error(`${railsDir}: ядро rails недоступно после junction`);
  }
  const settings = writeClaudeHooks(root);
  const loader = writeKiloPluginLoader(root);

  const gitignore = join(root, '.gitignore');
  const line = '.workflow/state/';
  const has = existsSync(gitignore) && readFileSync(gitignore, 'utf8').split(/\r?\n/).some((l) => l.trim() === line);
  if (!has) appendFileSync(gitignore, `${line}\n`);

  return { root, railsDir, settings, loader };
}

// realpath обеих сторон: в проектах src/scripts подключён junction'ом, а Node реалпасит
// import.meta.url главного модуля и оставляет argv[1] как передан (см. cli.mjs).
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    const self = realpathDeep(fileURLToPath(import.meta.url));
    const entry = realpathDeep(process.argv[1]);
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}
const isMain = isDirectRun();
if (isMain) {
  try {
    const args = process.argv.slice(2);
    const umbrella = args.includes('--umbrella');
    const user = args.includes('--user');
    const unregister = args.includes('--unregister');
    const target = args.find((a) => !a.startsWith('--')) || process.cwd();
    if (unregister) {
      const p = unregisterRails(target, { user });
      console.log(p ? `хуки rails сняты: ${p}` : `хуки rails не найдены или файл не наш формат — ничего не менял (${user ? userSettingsPath() : target})`);
    } else {
      const r = registerRails(target, { umbrella, user });
      console.log(r.umbrella
        ? `rails зарегистрированы на уровне ${r.user ? 'пользователя' : 'зонтика ' + r.root}:\n  claude:   ${r.settings}\nПерезапусти сессию Claude Code, чтобы хуки загрузились.`
        : `rails зарегистрированы:\n  junction: ${r.railsDir}\n  claude:   ${r.settings}\n  kilo:     ${r.loader}\nПерезапусти сессию Claude Code, чтобы хуки загрузились.`);
    }
  } catch (e) {
    console.error(`register-rails: ${e.message}`);
    process.exit(1);
  }
}
