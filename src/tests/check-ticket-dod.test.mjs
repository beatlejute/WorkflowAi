/**
 * Гейт dod_format: 2 для автора тикета (src/scripts/check-ticket-dod.js).
 *
 * Скрипт разбирает проверки DoD так же, как гейт move-to-ready.js перед ready/
 * (dodStartProblems, lib/check-runner.mjs), но тикет не двигает и не правит: автор тикета
 * (скил, который пишет тикеты доработок) видит причины до того, как гейт отправит тикет в
 * blocked/. 2026-09-28 тикет PulseProxy FIX-031 был записан с проверками через `|` и с
 * проверкой, зелёной до начала работы, и встал в blocked/ сразу после создания.
 *
 * Что охраняется:
 *  - проверка с оператором оболочки — check_denied, проверка, зелёная до работы, —
 *    check_green_before_start, код выхода 1;
 *  - красная проверка и зелёная с `regression: true` — ok, код выхода 0;
 *  - тикет не в формате dod_format: 2 — ok без запуска проверок;
 *  - файл тикета остаётся байт в байт прежним, тикет — в своей колонке;
 *  - тикет, которого нет на доске, — код выхода 1 с его id в выводе.
 *
 * Временный корень проекта — в каталоге ОС, удаляется в after.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/check-ticket-dod.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-ticket-dod.js', import.meta.url));

let root;
let backlog;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-ticket-dod-'));
  backlog = path.join(root, '.workflow', 'tickets', 'backlog');
  fs.mkdirSync(backlog, { recursive: true });
  fs.mkdirSync(path.join(root, '.workflow', 'tickets', 'blocked'), { recursive: true });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const GREEN = 'node -e "process.exit(0)"';
const RED = 'node -e "process.exit(1)"';

function putTicket(id, dod, { dodFormat = 2 } = {}) {
  const text = [
    '---',
    `id: "${id}"`,
    'title: "Задача"',
    'type: fix',
    ...(dodFormat === null ? [] : [`dod_format: ${dodFormat}`]),
    '---',
    '',
    '## Критерии готовности (Definition of Done)',
    '',
    ...dod,
    '',
    '## Результат выполнения',
    '',
  ].join('\n');
  const file = path.join(backlog, `${id}.md`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

const check = (command, extra = '') => `  - check: \`${command}\`, expect: \`exit 0\`${extra}`;

function run(...refs) {
  const r = spawnSync(process.execPath, [SCRIPT, ...refs], { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('проверка с | и проверка, зелёная до работы, — причины и код 1; тикет не тронут', () => {
  const file = putTicket('FIX-901', [
    '- [ ] Ветка вызывает обновление',
    check('git grep -A6 "pool" src/index.ts | grep -q "update"'),
    '- [ ] Новый тест',
    check(GREEN),
  ]);
  const before = fs.readFileSync(file, 'utf8');

  const { code, out } = run('FIX-901');

  assert.equal(code, 1, out);
  assert.match(out, /FIX-901: check_denied: пункт 1 \(shell_operator: \|\); check_green_before_start: пункт 2/);
  assert.match(out, /status: problems/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'скрипт только читает тикет');
  assert.ok(fs.existsSync(file), 'тикет остаётся в своей колонке');
});

test('красная проверка и зелёная с regression — ok, код 0', () => {
  putTicket('FIX-902', [
    '- [ ] Новое поведение',
    check(RED),
    '- [ ] Прежние тесты не сломаны',
    check(GREEN, ', regression: `true`'),
  ]);

  const { code, out } = run('FIX-902');

  assert.equal(code, 0, out);
  assert.match(out, /FIX-902: ok/);
  assert.match(out, /status: ok/);
});

test('тикет не в dod_format 2 — ok без запуска проверок', () => {
  const marker = path.join(root, 'ran.txt');
  putTicket('FIX-903', [
    '- [ ] Пункт',
    check(`node -e "require('fs').writeFileSync('ran.txt', '')"`),
  ], { dodFormat: null });

  const { code, out } = run('FIX-903');

  assert.equal(code, 0, out);
  assert.match(out, /FIX-903: ok \(гейт не применяется/);
  assert.equal(fs.existsSync(marker), false, 'проверки старого формата не исполняются');
});

test('тикета нет на доске — код 1 и его id в выводе', () => {
  const { code, out } = run('FIX-999');

  assert.equal(code, 1, out);
  assert.match(out, /FIX-999: тикет не найден/);
});
