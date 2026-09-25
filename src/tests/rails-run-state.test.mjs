#!/usr/bin/env node
/**
 * Зацепились ли рельсы за запуск агента в тесте скила (lib/rails-run-state.mjs).
 *
 * 2026-09-23 и 2026-09-25 Kilo-агенты тестов работали в настоящем проекте
 * (унаследованный PWD, см. lib/agent-env.mjs): состояние их сессий рельс легло
 * туда, а раннер искал его в песочнице и молча не запускал output-check.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findRailsStateByRun,
  railsEngagement,
  railsNotEngagedMessage,
  railsCounters,
  describeRailsEngagement
} from '../lib/rails-run-state.mjs';

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.workflow', 'state', 'rails'), { recursive: true });
  return root;
}

function writeState(root, name, state) {
  fs.writeFileSync(path.join(root, '.workflow', 'state', 'rails', name), JSON.stringify(state), 'utf8');
}

function withRoots(fn) {
  return () => {
    const sandbox = makeRoot('rails-run-sandbox-');
    const project = makeRoot('rails-run-project-');
    try {
      fn({ sandbox, project });
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  };
}

describe('findRailsStateByRun', () => {
  test('находит состояние по run, пропуская чужие, скрытые и битые файлы', withRoots(({ sandbox }) => {
    writeState(sandbox, 'a.json', { run: 'other', node: 'P0E1' });
    writeState(sandbox, '.hidden.json', { run: 'r1', node: 'X' });
    fs.writeFileSync(path.join(sandbox, '.workflow', 'state', 'rails', 'broken.json'), '{', 'utf8');
    writeState(sandbox, 'b.json', { run: 'r1', node: 'P3S1' });
    assert.equal(findRailsStateByRun(sandbox, 'r1').node, 'P3S1');
  }));

  test('нет run, нет каталога состояния — null', withRoots(({ sandbox }) => {
    assert.equal(findRailsStateByRun(sandbox, null), null);
    assert.equal(findRailsStateByRun(path.join(sandbox, 'nope'), 'r1'), null);
  }));
});

describe('railsEngagement', () => {
  test('состояние в песочнице — рельсы зацепились', withRoots(({ sandbox, project }) => {
    writeState(sandbox, 's.json', { run: 'r1', node: 'P0S1' });
    const r = railsEngagement({ sandboxRoot: sandbox, projectRoot: project, run: 'r1' });
    assert.equal(r.engaged, true);
    assert.equal(r.escaped, false);
    assert.equal(r.state.node, 'P0S1');
  }));

  test('состояния нет нигде — не зацепились, но и не ушли из песочницы', withRoots(({ sandbox, project }) => {
    assert.deepEqual(railsEngagement({ sandboxRoot: sandbox, projectRoot: project, run: 'r1' }),
      { state: null, engaged: false, escaped: false });
  }));

  test('состояние только в настоящем проекте — агент работал мимо песочницы', withRoots(({ sandbox, project }) => {
    writeState(project, 'ses_x.json', { run: 'r1', node: 'P0E1' });
    writeState(project, 'ses_y.json', { run: 'other', node: 'P0E1' });
    assert.deepEqual(railsEngagement({ sandboxRoot: sandbox, projectRoot: project, run: 'r1' }),
      { state: null, engaged: false, escaped: true });
  }));

  test('чужой run в настоящем проекте — не побег', withRoots(({ sandbox, project }) => {
    writeState(project, 'ses_y.json', { run: 'other', node: 'P0E1' });
    assert.equal(railsEngagement({ sandboxRoot: sandbox, projectRoot: project, run: 'r1' }).escaped, false);
  }));

  test('без projectRoot — только песочница', withRoots(({ sandbox }) => {
    assert.deepEqual(railsEngagement({ sandboxRoot: sandbox, run: 'r1' }), { state: null, engaged: false, escaped: false });
  }));
});

describe('railsNotEngagedMessage', () => {
  test('побег — называет каталог, где нашлось состояние', () => {
    const m = railsNotEngagedMessage({ who: 'TC-1-kilo-t1', escaped: true, projectRoot: 'D:/Dev/p' });
    assert.ok(m.startsWith('[Runner] ⚠ rails: TC-1-kilo-t1 — состояние сессии этого запуска найдено в D:/Dev/p, а не в песочнице'), m);
    assert.match(m, /output-check не выполнен/);
  });

  test('состояния нет нигде — факт и варианты причин, а не одна причина', () => {
    const m = railsNotEngagedMessage({ who: 'TC-1-a-t1', escaped: false, projectRoot: 'D:/Dev/p' });
    assert.ok(m.includes('состояния сессии этого запуска нет ни в песочнице, ни в D:/Dev/p'), m);
    assert.match(m, /Возможные причины: агент не вызывал инструментов; хуков рельс в песочнице нет/);
  });
});

describe('railsCounters', () => {
  test('считает попытки без состояния и побеги', () => {
    assert.deepEqual(railsCounters([
      { rails: { engaged: false, escaped: true } },
      { rails: { engaged: false, escaped: false } },
      { rails: { engaged: true, escaped: false } },
      { errored: true }
    ]), { rails_not_engaged: 2, rails_escaped: 1 });
  });

  test('попыток с отметкой rails нет — null (скил не на рельсах)', () => {
    assert.equal(railsCounters([{ score: 5 }, { errored: true }]), null);
    assert.equal(railsCounters(undefined), null);
  });
});

describe('describeRailsEngagement', () => {
  test('строка на модель с попытками без состояния; побег — суффиксом', () => {
    assert.deepEqual(describeRailsEngagement('TC', { per_model: {
      a: { total: 3, rails_not_engaged: 2, rails_escaped: 1 },
      b: { total: 3, rails_not_engaged: 1, rails_escaped: 0 },
      c: { total: 3, rails_not_engaged: 0, rails_escaped: 0 },
      d: { total: 3 }
    } }), [
      'TC a: рельсы не зацепились 2/3, вне песочницы 1',
      'TC b: рельсы не зацепились 1/3'
    ]);
  });
});
