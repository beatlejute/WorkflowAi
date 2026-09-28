/**
 * Стадия check-decompose-result (src/scripts/check-created-tickets.js) после decompose-gaps.
 *
 * Без новых тикетов круг check-conditions → create-report → analyze-report повторял отчёт
 * и разбор на той же доске: 2026-09-28 PulseProxy, пробел вне плана отклонён с
 * `created_tickets: []`, и отчёт с разбором написаны ещё раз. Охраняется:
 *  - созданным считается id из поля `created_tickets` с файлом тикета на доске — одной
 *    строкой, списком YAML, без упомянутых в тексте, но не записанных id и номера плана;
 *  - скрипт по промпту стадии печатает `status: created` или `status: none`;
 *  - в действующем configs/pipeline.yaml decompose-gaps передаёт поле в стадию проверки,
 *    `none` ведёт в end, `created` — в check-conditions.
 *
 * Запуск: node --test src/tests/check-created-tickets.test.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import yaml from '../lib/js-yaml.mjs';
import { createdTicketsField, ticketsOnBoard } from '../scripts/check-created-tickets.js';

const SCRIPT = fileURLToPath(new URL('../scripts/check-created-tickets.js', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../configs/pipeline.yaml', import.meta.url));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-created-tickets-'));
const ticketsDir = path.join(root, '.workflow', 'tickets');
for (const [column, id] of [['backlog', 'FIX-032'], ['ready', 'QA-7'], ['done', 'DOCS-10']]) {
  fs.mkdirSync(path.join(ticketsDir, column), { recursive: true });
  fs.writeFileSync(path.join(ticketsDir, column, `${id}.md`), `---\nid: ${id}\n---\n`, 'utf8');
}
after(() => fs.rmSync(root, { recursive: true, force: true }));

const prompt = (...contextLines) => ['check-decompose-result', '', '', 'Context:', ...contextLines, '  ticket_id: DOCS-10'].join('\n');

function run(text) {
  const res = spawnSync(process.execPath, [SCRIPT, text], { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const block = res.stdout.split('---RESULT---')[1] ?? '';
  return Object.fromEntries(block.split(/\r?\n/).map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
}

test('поле created_tickets: одна строка, список YAML, пустое и отсутствующее', () => {
  assert.equal(createdTicketsField(prompt('  created_tickets: FIX-032, QA-7')), 'FIX-032, QA-7');
  assert.equal(createdTicketsField(prompt('  created_tickets: []')), '[]');
  assert.equal(createdTicketsField(prompt('  created_tickets:   - FIX-032', '  - QA-7')), '- FIX-032\n  - QA-7');
  assert.equal(createdTicketsField(prompt()), '', 'поле не задано');
  assert.doesNotMatch(createdTicketsField(prompt('  created_tickets: []')), /DOCS-10/, 'следующее поле контекста не входит в значение');
});

test('созданные — id с файлом на доске, без повторов; номер плана и незаписанный id — нет', () => {
  assert.deepEqual(ticketsOnBoard('FIX-032, QA-7, FIX-032', ticketsDir), ['FIX-032', 'QA-7']);
  assert.deepEqual(ticketsOnBoard('[] — пробел вне PLAN-017, FIX-999 не записан', ticketsDir), []);
  assert.deepEqual(ticketsOnBoard('FIX-032', path.join(root, 'нет-доски')), []);
});

test('скрипт по промпту стадии: created со списком, none без тикетов', () => {
  assert.deepEqual(run(prompt('  created_tickets: FIX-032')), { status: 'created', created_tickets: 'FIX-032' });
  assert.deepEqual(run(prompt('  created_tickets:   - FIX-032', '  - QA-7')), { status: 'created', created_tickets: 'FIX-032, QA-7' });
  assert.deepEqual(run(prompt('  created_tickets: []')), { status: 'none', created_tickets: '' });
  assert.deepEqual(run(prompt()), { status: 'none', created_tickets: '' });
});

test('действующий конфиг: decompose-gaps → check-decompose-result, none → end, created → check-conditions', () => {
  const { stages, agents } = yaml.load(fs.readFileSync(CONFIG, 'utf8')).pipeline;
  assert.deepEqual(stages['decompose-gaps'].goto.default, {
    stage: 'check-decompose-result',
    params: { created_tickets: '$result.created_tickets' },
  });
  const check = stages['check-decompose-result'];
  assert.equal(check.goto.none, 'end');
  assert.equal(check.goto.created, 'check-conditions');
  assert.equal(check.goto.default, 'check-conditions');
  assert.deepEqual(agents[check.agent].args, ['.workflow/src/scripts/check-created-tickets.js']);
});
