// Общая фикстура тестов гардов create-plan: временный проект, в котором
// `.workflow/src/skills/create-plan` — junction на канонический каталог скила
// (как в реальной раскладке, §2 спецификации rails). Состояние сессии ставится
// в нужный узел графа напрямую.
import { mkdtempSync, rmSync, mkdirSync, existsSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createJunction } from '../../../../junction-manager.mjs';
import { startState, saveState, loadState } from '../../../../rails/state.mjs';
import { decide, loadSkillRuntime } from '../../../../rails/core.mjs';
import { fromClaude } from '../../../../rails/actions.mjs';

export const SKILL = 'create-plan';
export const CANON = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Снять ссылку, не заходя в цель: junction — rmdir, symlink — unlink.
function removeLink(link) {
  if (!existsSync(link)) return;
  if (process.platform === 'win32') {
    execSync(`rmdir "${link}"`, { shell: 'cmd.exe', stdio: 'pipe' });
  } else {
    unlinkSync(link);
  }
}

export function withProject(fn) {
  const base = mkdtempSync(join(tmpdir(), 'create-plan-rails-'));
  const root = join(base, 'root');
  const skillsDir = join(root, '.workflow', 'src', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const d of ['plans/current', 'plans/archive', 'reports', 'logs', 'src/rails', 'templates',
    'tickets/backlog', 'tickets/ready', 'tickets/in-progress', 'tickets/review', 'tickets/done']) {
    mkdirSync(join(root, '.workflow', d), { recursive: true });
  }
  writeFileSync(join(root, '.workflow', 'plans', 'archive', 'PLAN-001.md'), '# PLAN-001\n', 'utf8');
  writeFileSync(join(root, '.workflow', 'tickets', 'ready', 'TASK-001.md'), '# TASK-001\n', 'utf8');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 1;\n', 'utf8');
  const link = join(skillsDir, SKILL);
  createJunction(CANON, link);
  try {
    fn({ root, link, base });
  } finally {
    removeLink(link);
    // Страховка: если ссылка почему-то осталась, каталог не трогаем — иначе
    // rmSync ушёл бы по ней в канонический скил.
    if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) {
      rmSync(base, { recursive: true, force: true });
    }
  }
}

export function atNode(root, node) {
  const sessionId = randomUUID();
  const state = startState({ root, sessionId, skill: SKILL, entry: 'P0E1' });
  state.node = node;
  saveState(root, state);
  return sessionId;
}

export const ctx = (root, sessionId, extra = {}) => ({ cwd: root, sessionId, role: 'coordinator', event: 'PreToolUse', ...extra });

export function claude(toolName, toolInput) {
  return fromClaude({ tool_name: toolName, tool_input: toolInput ?? {} });
}

export const plan = (root, dir = 'current', name = 'PLAN-002.md') => join(root, '.workflow', 'plans', dir, name);

export { decide, loadSkillRuntime, loadState };
