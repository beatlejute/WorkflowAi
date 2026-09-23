// Общая фикстура тестов гардов decompose-gaps: временный проект, в котором
// `.workflow/src/skills/decompose-gaps` — junction на канонический каталог скила
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

export const SKILL = 'decompose-gaps';
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
  const base = mkdtempSync(join(tmpdir(), 'decompose-gaps-rails-'));
  const root = join(base, 'root');
  const skillsDir = join(root, '.workflow', 'src', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const d of ['plans/current', 'plans/archive', 'reports', 'logs', 'src/rails', 'config', 'templates',
    'tickets/backlog', 'tickets/ready', 'tickets/in-progress', 'tickets/review', 'tickets/done']) {
    mkdirSync(join(root, '.workflow', d), { recursive: true });
  }
  // Тикет в backlog, чужой тикет в ready, план и конфиг типов — цели проверок H1 и H2.
  writeFileSync(join(root, '.workflow', 'tickets', 'backlog', 'IMPL-001.md'), '# IMPL-001\n', 'utf8');
  writeFileSync(join(root, '.workflow', 'tickets', 'ready', 'IMPL-002.md'), '# IMPL-002\n', 'utf8');
  writeFileSync(join(root, '.workflow', 'plans', 'current', 'PLAN-001.md'), '# PLAN-001\n', 'utf8');
  writeFileSync(join(root, '.workflow', 'config', 'config.yaml'), 'task_types: {}\n', 'utf8');
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

export const ticket = (root, dir, name = 'IMPL-001.md') => join(root, '.workflow', 'tickets', dir, name);
export const plan = (root, name = 'PLAN-001.md') => join(root, '.workflow', 'plans', 'current', name);
export const report = (root, name = 'REPORT-001.md') => join(root, '.workflow', 'reports', name);

export { decide, loadSkillRuntime, loadState };
