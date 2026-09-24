// Общая фикстура тестов гардов manual-testing: временный проект, в котором
// `.workflow/src/skills/manual-testing` — junction на канонический каталог скила
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

export const SKILL = 'manual-testing';
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
  const base = mkdtempSync(join(tmpdir(), 'manual-testing-rails-'));
  const root = join(base, 'root');
  const skillsDir = join(root, '.workflow', 'src', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const d of ['plans/current', 'reports', 'logs', 'src/rails', 'config', 'templates',
    'tickets/backlog', 'tickets/ready', 'tickets/in-progress', 'tickets/review', 'tickets/done']) {
    mkdirSync(join(root, '.workflow', d), { recursive: true });
  }
  // Свой QA-тикет в in-progress, чужие тикеты в других колонках, план, отчёт и конфиг —
  // цели проверок H1 и H2.
  writeFileSync(join(root, '.workflow', 'tickets', 'in-progress', 'QA-001.md'), '# QA-001\n', 'utf8');
  writeFileSync(join(root, '.workflow', 'tickets', 'backlog', 'QA-002.md'), '# QA-002\n', 'utf8');
  writeFileSync(join(root, '.workflow', 'tickets', 'ready', 'QA-003.md'), '# QA-003\n', 'utf8');
  writeFileSync(join(root, '.workflow', 'plans', 'current', 'PLAN-001.md'), '# PLAN-001\n', 'utf8');
  writeFileSync(join(root, '.workflow', 'reports', 'REPORT-001.md'), '# REPORT-001\n', 'utf8');
  writeFileSync(join(root, '.workflow', 'config', 'config.yaml'), 'task_types: {}\n', 'utf8');
  // Артефакты evidence и тесты проекта — за пределами .workflow/.
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'state.test.mjs'), 'export const a = 1;\n', 'utf8');
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

export const ticket = (root, dir, name = 'QA-001.md') => join(root, '.workflow', 'tickets', dir, name);
export const plan = (root, name = 'PLAN-001.md') => join(root, '.workflow', 'plans', 'current', name);
export const report = (root, name = 'REPORT-001.md') => join(root, '.workflow', 'reports', name);
export const evidence = (root, name = 'qa001-screenshot-01.png') => join(root, 'reports', name);

export { decide, loadSkillRuntime, loadState };
