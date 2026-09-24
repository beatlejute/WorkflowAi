/**
 * Ручной сброс здоровья агентов (src/scripts/reset-agent-health.js) — инструмент
 * человека, когда раннер пометил агента нездоровым (квота, недоступность), а причина уже
 * устранена. До этого файла скрипт не имел ни одного теста: покрытие 0% (база
 * храповика, коммит 1156f42).
 *
 * Скрипт — тонкая оболочка над src/lib/agent-health-registry.mjs, поэтому проверяется
 * целиком, запуском как у человека: в каталоге проекта (он берёт корень из cwd), с
 * разбором аргументов и кодом выхода. Цена ошибок:
 *  - сброс не того агента или неполный сброс --all — агент остаётся выключенным, и
 *    стадии, которые он обслуживает, блокируются no_capable_agent;
 *  - неизвестный флаг, принятый молча, — человек думает, что сбросил, а ничего не
 *    произошло. Поэтому неверный вызов обязан выходить с кодом 1 и справкой.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/reset-agent-health.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { markUnhealthy, isHealthy, loadHealth } from '../lib/agent-health-registry.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'reset-agent-health.js');

function withProject(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-health-'));
  fs.mkdirSync(path.join(root, '.workflow', 'state'), { recursive: true });
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(root, ...args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}`, err: `${res.stderr}` };
}

function sick(root, agentId) {
  markUnhealthy(root, agentId, { class: 'unavailable', rule_id: 'test-quota', ttl: '1h', reason: 'квота исчерпана' });
}

test('без аргументов: показывает состояние реестра блоком результата', () => {
  withProject((root) => {
    sick(root, 'qwen-code');
    const r = run(root);
    assert.equal(r.code, 0, r.err);
    const block = r.out.split('---RESULT---')[1];
    const state = JSON.parse(block);
    assert.ok(state.agents['qwen-code'], 'нездоровый агент виден в выводе');
  });
});

test('--agent: сбрасывается ровно указанный агент', () => {
  withProject((root) => {
    sick(root, 'qwen-code');
    sick(root, 'kilo-glm');

    const r = run(root, '--agent', 'qwen-code');

    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Reset health status for agent "qwen-code"/);
    assert.equal(isHealthy(root, 'qwen-code'), true);
    assert.equal(isHealthy(root, 'kilo-glm'), false, 'соседний агент не тронут');
  });
});

test('--agent с неизвестным агентом: сообщение, реестр не меняется', () => {
  withProject((root) => {
    sick(root, 'kilo-glm');
    const before = JSON.stringify(loadHealth(root).agents);

    const r = run(root, '--agent', 'nobody');

    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Agent "nobody" not found in health registry/);
    assert.equal(JSON.stringify(loadHealth(root).agents), before);
  });
});

test('--all: сбрасываются все нездоровые агенты', () => {
  withProject((root) => {
    sick(root, 'qwen-code');
    sick(root, 'kilo-glm');

    const r = run(root, '--all');

    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Reset 2 agent\(s\):/);
    assert.equal(isHealthy(root, 'qwen-code'), true);
    assert.equal(isHealthy(root, 'kilo-glm'), true);
  });
});

test('--all при здоровом реестре: сообщение, без ошибки', () => {
  withProject((root) => {
    const r = run(root, '--all');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /No unhealthy agents to reset/);
  });
});

test('неверный вызов: справка и код выхода 1, а не молчаливый успех', () => {
  withProject((root) => {
    for (const args of [['--agent'], ['--reset'], ['qwen-code']]) {
      const r = run(root, ...args);
      assert.equal(r.code, 1, `аргументы ${args.join(' ')}`);
      assert.match(r.out, /Usage:/);
    }
  });
});
