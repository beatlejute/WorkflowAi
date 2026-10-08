import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { check } from '../rails/output-check.mjs';
import { validateRailsConfig } from '../rails/rails-config.mjs';
import { Graph } from '../rails/graph.mjs';

const handoff = {
  nodes: ['P0S2'],
  requires: ['^REQUEST: .+', '^REASON: .+', '^DONE: .+', '^REMAINING: .+'],
  forbids: ['verdict\\s*=', '^status:'],
};
const config = {
  skill: 'example', entry: 'P0E1', terminal: ['P1S1'], handoff,
  output: { final_requires: ['verdict=pass'] },
};
const answer = 'RAILS_OUTCOME: out_of_scope\nREQUEST: original request\nREASON: outside competence\nDONE: scope checked\nREMAINING: implementation';

test('handoff policy: separate outcome at declared node preserves state', () => {
  const state = { node: 'P0S2', counters: { actions: 3 }, history: [] };
  const before = structuredClone(state);
  assert.deepEqual(check(answer, config, state), { ok: true, missing: [], outcome: 'out_of_scope' });
  assert.deepEqual(state, before);
});

test('handoff policy: undeclared node and absent policy refuse even at success terminal', () => {
  assert.equal(check(answer, config, { node: 'P1S1' }).ok, false);
  assert.equal(check(answer, { ...config, handoff: undefined, output: {} }, { node: 'P1S1' }).ok, false);
});

test('handoff policy: required fields and forbidden success are checked independently', () => {
  assert.equal(check(answer.replace('REASON: outside competence', ''), config, { node: 'P0S2' }).ok, false);
  assert.equal(check(answer + '\nverdict=pass', config, { node: 'P0S2' }).ok, false);
  assert.equal(check(answer + '\nstatus: pass', config, { node: 'P0S2' }).ok, false);
});

test('handoff policy: graph checks references and permits a handoff-only leaf', () => {
  const graph = new Graph([
    { id: 'P0E1', shape: 'rect', label: 'entry', source: 'test' },
    { id: 'P0S2', shape: 'rect', label: 'handoff scope decision with evidence', source: 'test' },
  ], [{ from: 'P0E1', to: 'P0S2', source: 'test' }], [], []);
  const valid = { ...config, terminal: [] };
  assert.deepEqual(graph.validate(valid).errors, []);
  const invalid = { ...valid, handoff: { ...handoff, nodes: ['P0S9'] } };
  assert.ok(graph.validate(invalid).errors.some((e) => e.code === 'unknown-handoff'));
});

test('handoff policy: malformed schema and invalid expressions refuse validation', () => {
  assert.deepEqual(validateRailsConfig(config).errors, []);
  for (const policy of [null, [], { nodes: [] }, { ...handoff, nodes: ['bad'] },
    { ...handoff, requires: ['['] }, { ...handoff, forbids: 'pass' }]) {
    assert.ok(validateRailsConfig({ ...config, handoff: policy }).errors.length > 0);
  }
});
