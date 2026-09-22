// Общая фикстура тестов гардов analyze-report: временный проект, в котором
// `.workflow/src/skills/analyze-report` — junction на канонический каталог скила
// (как в реальной раскладке, §2 спецификации rails). Состояние сессии ставится
// в нужный узел графа напрямую.
import { mkdtempSync, rmSync, mkdirSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createJunction } from '../../../../junction-manager.mjs';
import { startState, saveState, loadState } from '../../../../rails/state.mjs';
import { decide, loadSkillRuntime } from '../../../../rails/core.mjs';
import { fromClaude } from '../../../../rails/actions.mjs';

export const SKILL = 'analyze-report';
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
  const base = mkdtempSync(join(tmpdir(), 'analyze-report-rails-'));
  const root = join(base, 'root');
  const skillsDir = join(root, '.workflow', 'src', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const d of ['plans', 'reports', 'logs', 'tickets/in-progress', 'tickets/done', 'src/rails']) {
    mkdirSync(join(root, '.workflow', d), { recursive: true });
  }
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

export { decide, loadSkillRuntime, loadState };
