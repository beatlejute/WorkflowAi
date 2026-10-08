import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../rails/graph.mjs';
import { pinnedRuntime } from '../rails/runtime-snapshot.mjs';
import { WritePolicyError } from '../rails/write-policy.mjs';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rails-snapshot-'));
  mkdirSync(join(root, '.workflow'), { recursive: true });
  const state = {
    session: 'test-session', skill: 'coach', run: 'run-1', started: '2026-10-05T00:00:00Z',
    node: 'P0R3', history: [{ from: 'P0E1', to: 'P0R3' }], counters: { actions: 7 }, denials: { P0R3: 2 },
  };
  const live = (label = 'original') => ({
    config: { entry: 'P0E1', write_scope: [label] },
    graph: new Graph([{ id: 'P0R3', shape: 'rect', label, order: 0, source: 'workflows/main.md' }], [], ['workflows/main.md'], []),
  });
  const snapshotPath = () => join(root, '.workflow', 'state', 'rails-runtime', `${state.runtime.id}.json`);
  try { fn({ root, state, live, snapshotPath }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('snapshot pins config and graph without changing execution state', () => fixture(({ root, state, live }) => {
  const before = structuredClone(state);
  pinnedRuntime(root, state, () => live());
  const runtime = pinnedRuntime(root, state, () => { throw new Error('must not reload sources'); });
  assert.equal(runtime.graph.node('P0R3').label, 'original');
  assert.deepEqual(runtime.config.write_scope, ['original']);
  const { runtime: binding, ...after } = state;
  assert.deepEqual(after, before);
  assert.equal(binding.version, 1);
}));

test('returned runtime cannot mutate the stored snapshot', () => fixture(({ root, state, live }) => {
  const first = pinnedRuntime(root, state, () => live());
  first.config.write_scope.push('changed');
  first.graph._occurrences[0].label = 'changed';
  const next = pinnedRuntime(root, state, () => live('new sources'));
  assert.deepEqual(next.config.write_scope, ['original']);
  assert.equal(next.graph.node('P0R3').label, 'original');
}));

test('missing or corrupted bound snapshot fails closed without reloading', () => fixture(({ root, state, live, snapshotPath }) => {
  pinnedRuntime(root, state, () => live());
  const path = snapshotPath();
  writeFileSync(path, '{');
  assert.throws(() => pinnedRuntime(root, state, () => live('unsafe')), WritePolicyError);
  unlinkSync(path);
  assert.throws(() => pinnedRuntime(root, state, () => live('unsafe')), WritePolicyError);
}));

test('different run cannot reuse a prior runtime binding', () => fixture(({ root, state, live }) => {
  pinnedRuntime(root, state, () => live());
  state.run = 'other-run';
  assert.throws(() => pinnedRuntime(root, state, () => live()), WritePolicyError);
}));

test('handoff policy is checked when pinning and reading runtime', () => fixture(({ root, state, live }) => {
  const source = live();
  source.config.handoff = { nodes: ['P0S9'], requires: ['REQUEST:'], forbids: ['verdict='] };
  assert.throws(() => pinnedRuntime(root, state, () => source), WritePolicyError);
  source.config.handoff.nodes = ['P0R3'];
  source.config.handoff.requires = ['['];
  assert.throws(() => pinnedRuntime(root, state, () => source), WritePolicyError);
}));

test('new run without a prior binding captures its own sources', () => fixture(({ root, state, live }) => {
  pinnedRuntime(root, state, () => live());
  const next = { ...state, run: 'run-2', runtime: undefined };
  assert.equal(pinnedRuntime(root, next, () => live('new')).graph.node('P0R3').label, 'new');
  assert.notEqual(next.runtime.id, state.runtime.id);
}));
