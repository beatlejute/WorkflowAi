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
  describeRailsEngagement,
  railsHost,
  railsHooksPresent,
  railsNotEngagedVerdict,
  outputCheckVerdict
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
  test('считает попытки без состояния, побеги и проваленные без рельс', () => {
    assert.deepEqual(railsCounters([
      { rails: { engaged: false, escaped: true } },
      { rails: { engaged: false, escaped: false, failed: true } },
      { rails: { engaged: true, escaped: false } },
      { errored: true }
    ]), { rails_not_engaged: 2, rails_escaped: 1, rails_failed: 1 });
  });

  test('попыток с отметкой rails нет — null (скил не на рельсах)', () => {
    assert.equal(railsCounters([{ score: 5 }, { errored: true }]), null);
    assert.equal(railsCounters(undefined), null);
  });
});

describe('railsHost', () => {
  test('kilo run, claude по имени команды, явный rails_host; прочее — null', () => {
    assert.equal(railsHost({ command: 'kilo', args: ['run', '--auto'] }), 'kilo');
    assert.equal(railsHost({ command: 'kilo', args: ['db', 'path'] }), null, 'kilo без run — не агент');
    assert.equal(railsHost({ command: 'C:\\nvm4w\\nodejs\\claude.cmd', args: ['-p'] }), 'claude');
    assert.equal(railsHost({ command: '/usr/local/bin/claude', args: [] }), 'claude');
    assert.equal(railsHost({ command: 'node', args: ['stub.mjs'], rails_host: 'kilo' }), 'kilo');
    assert.equal(railsHost({ command: 'node', args: ['stub.mjs'] }), null);
    assert.equal(railsHost({ command: 'qwen', args: [], rails_host: 'other' }), null);
  });
});

describe('railsHooksPresent', () => {
  test('kilo — загрузчик плагина в каталоге агента и ядро, на которое он ссылается', withRoots(({ sandbox }) => {
    assert.equal(railsHooksPresent('kilo', sandbox), false);
    fs.mkdirSync(path.join(sandbox, '.kilo', 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, '.kilo', 'plugin', 'workflow-rails.js'), '', 'utf8');
    assert.equal(railsHooksPresent('kilo', sandbox), false, 'загрузчик без ядра — плагин не грузится');
    fs.mkdirSync(path.join(sandbox, '.workflow', 'src', 'rails'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, '.workflow', 'src', 'rails', 'kilo-plugin.mjs'), '', 'utf8');
    assert.equal(railsHooksPresent('kilo', sandbox), true);
  }));

  test('claude — запись _workflow_rails в настройках пользователя или проекта, скрипт хука существует', withRoots(({ sandbox, project }) => {
    const script = path.join(project, 'claude-hook.mjs');
    const hooks = (s) => JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node "${s}"`, _workflow_rails: true }] }] } });
    const user = path.join(project, 'user-settings.json');
    assert.equal(railsHooksPresent('claude', sandbox, { userSettingsPath: user }), false, 'файла нет');
    fs.writeFileSync(user, hooks(script), 'utf8');
    assert.equal(railsHooksPresent('claude', sandbox, { userSettingsPath: user }), false, 'скрипта хука нет — хук упадёт');
    fs.writeFileSync(script, '', 'utf8');
    assert.equal(railsHooksPresent('claude', sandbox, { userSettingsPath: user }), true);
    fs.mkdirSync(path.join(sandbox, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, '.claude', 'settings.local.json'), hooks(script), 'utf8');
    assert.equal(railsHooksPresent('claude', sandbox, { userSettingsPath: path.join(project, 'none.json') }), true);
  }));

  test('хост неизвестен — false', withRoots(({ sandbox }) => {
    assert.equal(railsHooksPresent(null, sandbox), false);
  }));
});

describe('вердикты повтора', () => {
  test('без единого вызова инструмента — команда start и терминальный узел', () => {
    const v = railsNotEngagedVerdict({ skill: 'deep-research', config: { terminal: ['P9S1'] } });
    assert.ok(v.startsWith('RAILS: предыдущий ответ отклонён — скил «deep-research» идёт по рельсам'), v);
    assert.match(v, /`node \.workflow\/src\/rails\/cli\.mjs start deep-research`/);
    assert.match(v, /Финальный ответ — только в P9S1\.\n\n$/);
    assert.match(railsNotEngagedVerdict({ skill: 'x', config: {} }), /только в терминальном узле графа/);
  });

  test('output-check — что отсутствует, где числится и команды переходов оттуда', withRoots(({ sandbox }) => {
    const skillDir = path.join(sandbox, 'skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '```mermaid',
      'graph TD',
      '    P1E1["П1 ВХОД: начало этапа проверки вердикта повтора раннера"]',
      '    P1S1["П1 ШАГ: выдать результат проверки и остановиться на этом шаге"]',
      '    P1E1 --> P1S1',
      '```',
      ''
    ].join('\n'), 'utf8');
    const config = { skill: 'skill', entry: 'P1E1', terminal: ['P1S1'], quote_min: 25 };
    const v = outputCheckVerdict({ verdict: { ok: false, missing: ['position:P1E1 не входит в terminal/pause_nodes'] }, state: { node: 'P1E1' }, config, skillDir });
    assert.match(v, /^RAILS: предыдущий ответ отклонён output-check — отсутствует: position:P1E1/);
    assert.match(v, /Числишься в P1E1\. Переходы оттуда:\n {2}P1S1: .* → node \.workflow\/src\/rails\/cli\.mjs goto P1S1 --quote '/);
    assert.match(v, /Финальный ответ — только в P1S1\. Исправь и ответь заново\.\n\n$/);

    const noGraph = outputCheckVerdict({ verdict: { ok: false, missing: ['x'] }, state: { node: 'P1E1' }, config, skillDir: path.join(sandbox, 'nope') });
    assert.match(noGraph, /Числишься в P1E1\. Финальный ответ/, 'граф не читается — без переходов');
  }));
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
