#!/usr/bin/env node
/**
 * Нормализация статуса из блока RESULT (ResultParser.normalizeStatus, src/runner.mjs).
 *
 * Значение строки `status:` может нести пояснение после ключа (`blocked — причина`,
 * `blocked: причина`). Целиком оно не совпадает ни с синонимом, ни с ключом перехода
 * стадии, а переход ищется точным сравнением (`resolveNextStage`, `goto[status]`):
 * пояснение не отделено — стадия молча уходит по ветке `default`, и отказ исполнителя
 * читается как успех. Регресс — ключ с дефисом: шаблон разбора не признавал дефис частью
 * первого слова и возвращал `needs-review — причина` целиком, тогда как `blocked — причина`
 * разбирался.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/runner-status-normalization.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StageExecutor } from '../runner.mjs';

function makeConfig() {
  return {
    pipeline: {
      name: 'test-status-normalization',
      version: '1.0',
      agents: { 'claude-sonnet': { command: 'claudesonnet', args: ['-p'], capabilities: ['text'] } },
      stages: {},
      entry: 'none',
      context: {},
      execution: { timeout_per_stage: 30, snapshot_paths: [] },
      default_agents: ['claude-sonnet'],
    },
  };
}

// Разбор статуса доступен только через исполнитель стадии: ResultParser не экспортируется.
const parser = new StageExecutor(makeConfig(), {}, {}, {}, null, null, process.cwd()).resultParser;

// Логи парсера в тестах не нужны — нужен только возвращённый статус.
function normalize(status) {
  const log = console.log;
  console.log = () => {};
  try {
    return parser.normalizeStatus(status);
  } finally {
    console.log = log;
  }
}

test('синоним с пояснением приводится к каноническому значению', () => {
  assert.equal(normalize('ok — всё сходится'), 'passed');
  assert.equal(normalize('rejected: не прошло'), 'failed');
});

test('ключ с дефисом: пояснение отделяется, ключ сохраняется целиком', () => {
  assert.equal(normalize('needs-review — причина'), 'needs-review');
  assert.equal(normalize('needs-review: причина'), 'needs-review');
  assert.equal(normalize('needs-review—причина'), 'needs-review');
});

test('пояснение отделяется по тире, двоеточию и пробелу', () => {
  assert.equal(normalize('blocked — причина'), 'blocked');
  assert.equal(normalize('blocked: причина'), 'blocked');
  assert.equal(normalize('blocked - причина'), 'blocked');
  assert.equal(normalize('has_gaps — 3'), 'has_gaps');
});

test('значение без пояснения возвращается как есть, с исходным регистром', () => {
  assert.equal(normalize('needs-review'), 'needs-review');
  assert.equal(normalize('CustomStatus'), 'CustomStatus');
  assert.equal(normalize('passed'), 'passed');
});

test('регистр неизвестного ключа сохраняется и с пояснением: стадия ищет свой ключ точно', () => {
  assert.equal(normalize('BLOCKED — причина'), 'BLOCKED');
  assert.equal(normalize('CustomStatus — причина'), 'CustomStatus');
});

test('пустое значение и пробелы дают пустую строку', () => {
  assert.equal(normalize(''), '');
  assert.equal(normalize('   '), '');
  assert.equal(normalize(undefined), '');
});
