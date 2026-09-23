// Канарейка живости (узел P0S1) и потолки возвратов из гейтов (H5 rails.yaml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, atNode, ctx, claude, decide, loadSkillRuntime, loadState, SKILL } from './_project.mjs';
import { applyGoto, saveState } from '../../../../rails/state.mjs';

test('канарейка: echo RAILS_CANARY отклоняется, в том числе внутри составной команды', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P0S1');
    for (const command of ['echo RAILS_CANARY', 'echo RAILS_CANARY | tail -1', 'cd .workflow && echo RAILS_CANARY']) {
      const r = decide({ action: claude('Bash', { command }), ctx: ctx(root, s) });
      assert.equal(r.decision, 'deny', command);
      assert.match(r.reason, /RAILS_CANARY/, command);
    }
  });
});

test('роль исполнителя: молчание для role executor', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P3S1');
    const r = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, s, { role: 'executor' }) });
    assert.equal(r.decision, 'allow');
  });
});

test('потолок: четвёртый возврат гейта П6 к выполнению — отказ', () => {
  withProject(({ root }) => {
    const { graph, config } = loadSkillRuntime(root, SKILL);
    const sessionId = atNode(root, 'P6G1');
    let state = loadState(root, sessionId);
    const quote = 'Выполнить работу и фиксировать результат инкрементально';
    let last = null;
    for (let i = 0; i < 4; i += 1) {
      state.node = 'P6G1';
      last = applyGoto(state, graph, config, { node: 'P3E1', quote });
      saveState(root, state);
      if (i < 3) assert.equal(last.ok, true, `круг ${i + 1}: ${JSON.stringify(last)}`);
    }
    assert.equal(last.ok, false, 'четвёртый круг обязан упереться в потолок');
    assert.match(String(last.reason ?? ''), /status blocked|потолок|limit/i);
  });
});
