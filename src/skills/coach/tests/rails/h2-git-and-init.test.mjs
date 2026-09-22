// H2: git-операции записи, регистрация хуков (workflow init) и MCP-инструменты
// изменения проекта — отказ; чтение и остальное — молчание. Узел P0R4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCoachProject, atNode, ctx, claude, decide } from './_project.mjs';

const denied = ['git commit -m "x"', 'git add .', 'git push origin main', 'git checkout -b feat', 'git reset --hard HEAD~1', 'git stash', 'workflow init', 'node .workflow/src/init.mjs'];
const allowed = ['git log --oneline -5', 'git status --short', 'git diff HEAD', 'git show HEAD:src/x', 'node .workflow/src/scripts/check-rails-graph.js --skill coach'];

for (const command of denied) {
  test(`H2: отказ — ${command}`, () => {
    withCoachProject(({ root }) => {
      const s = atNode(root, 'P8S1');
      const r = decide({ action: claude('Bash', { command }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'deny', command);
      assert.match(r.reason, /git-операции|workflow init|Отклонено/);
    });
  });
}

for (const command of allowed) {
  test(`H2: молчание — ${command}`, () => {
    withCoachProject(({ root }) => {
      const s = atNode(root, 'P8S1');
      const r = decide({ action: claude('Bash', { command }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'allow', command);
    });
  });
}

test('H2: MCP git_commit и create_ticket — отказ, get_ticket — молчание', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P2S5');
    for (const tool of ['mcp__workflow__git_commit', 'mcp__workflow__create_ticket', 'mcp__workflow__move_ticket']) {
      const r = decide({ action: claude(tool, { message: 'x' }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'deny', tool);
      assert.match(r.reason, /deny_mcp/);
    }
    const ok = decide({ action: claude('mcp__workflow__get_ticket', { id: 'XXX-001' }), ctx: ctx(root, s) });
    assert.equal(ok.decision, 'allow');
  });
});

test('H2: делегат (executor) с git commit — молчание', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P8S1');
    const r = decide({ action: claude('Bash', { command: 'git commit -m x' }), ctx: ctx(root, s, { role: 'executor' }) });
    assert.deepEqual(r, { decision: 'allow' });
  });
});
