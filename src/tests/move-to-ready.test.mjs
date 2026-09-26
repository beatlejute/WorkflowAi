/**
 * Перенос тикетов из backlog/ в ready/ (src/scripts/move-to-ready.js) с гейтом
 * «проверки падают до начала работы» (PLAN-002, задачи 18–19).
 *
 * Тикет с `dod_format: 2` перед переносом исполняет проверки `check` своего DoD без
 * пометки `regression`. Зелёная проверка до работы значит пустой критерий или уже
 * сделанную задачу — тикет уходит в blocked/ с причиной. Покрыты: зелёная
 * проверка, зелёная с `regression: true`, красная, `denied`, неполная запись,
 * пункты prose и visual, тикет без `dod_format` и human-тикет.
 *
 * Скрипт вычисляет каталоги доски от корня проекта при импорте, поэтому он
 * запускается дочерним процессом с cwd во временном корне и промптом раннера —
 * как в FIX-70-002 (src/tests/regression-human-ticket-ready-loop.test.mjs).
 * Временный корень создаётся в before и удаляется в after.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/move-to-ready.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/move-to-ready.js', import.meta.url));

let root;
let tickets;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-to-ready-'));
  tickets = path.join(root, '.workflow', 'tickets');
  for (const dir of ['backlog', 'ready', 'blocked']) {
    fs.mkdirSync(path.join(tickets, dir), { recursive: true });
  }
  // Файл в корне проекта: проверка на него зелёная, только если её cwd — корень.
  fs.writeFileSync(path.join(root, 'root-marker.txt'), 'x', 'utf8');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const GREEN = 'node -e "process.exit(0)"';
const RED = 'node -e "process.exit(1)"';
// Зелёная проверка, оставляющая след: файл в корне появится, только если её запускали.
const trace = name => `node -e "require('fs').writeFileSync('${name}', '')"`;
const ran = name => fs.existsSync(path.join(root, name));

/**
 * Тикет в backlog/. dod — строки секции DoD как есть (пункты и вложенные проверки).
 */
function putTicket(id, { dodFormat = 2, type = 'impl', dod }) {
  const frontmatter = [
    '---',
    `id: "${id}"`,
    'title: "Задача"',
    `type: ${type}`,
    ...(dodFormat === null ? [] : [`dod_format: ${dodFormat}`]),
    'updated_at: "2026-09-26T08:00:00.000Z"',
    '---'
  ];
  const text = [
    ...frontmatter,
    '',
    `# ${id}`,
    '',
    '## Критерии готовности (Definition of Done)',
    '',
    ...dod,
    '',
    '## Результат выполнения',
    '',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(tickets, 'backlog', `${id}.md`), text, 'utf8');
}

function checkLine(command, extra = '') {
  return `  - check: \`${command}\`, expect: \`exit 0\`${extra}`;
}

function moveToReady(ids) {
  const prompt = `move-to-ready\n\nContext:\n  ready_tickets: ${ids.join(', ')}\n`;
  const run = spawnSync('node', [SCRIPT, prompt], { cwd: root, encoding: 'utf8' });
  const output = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 0, `move-to-ready завершился с ${run.status}:\n${output}`);
  const block = run.stdout.split('---RESULT---')[1] ?? '';
  const result = Object.fromEntries(
    block.split(/\r?\n/).map(line => /^(\w+):\s*(.*)$/.exec(line)).filter(Boolean).map(m => [m[1], m[2].trim()])
  );
  return { output, result };
}

function columnOf(id) {
  return ['backlog', 'ready', 'blocked'].find(dir => fs.existsSync(path.join(tickets, dir, `${id}.md`))) ?? null;
}

function frontmatterOf(id) {
  const dir = columnOf(id);
  return parseFrontmatter(fs.readFileSync(path.join(tickets, dir, `${id}.md`), 'utf8')).frontmatter;
}

// ---------------------------------------------------------------------------
// Критерий приёмки задачи 18
// ---------------------------------------------------------------------------

test('зелёная проверка до работы — тикет в blocked/ с check_green_before_start', () => {
  putTicket('IMPL-GREEN', { dod: ['- [ ] Критерий', checkLine(GREEN)] });

  const { output, result } = moveToReady(['IMPL-GREEN']);

  assert.equal(columnOf('IMPL-GREEN'), 'blocked', output);
  assert.match(output, /check_green_before_start: пункт 1/);
  assert.equal(frontmatterOf('IMPL-GREEN').blocked_reason, 'check_green_before_start: пункт 1');
  assert.deepEqual(
    { status: result.status, moved: result.moved, blocked: result.blocked, skipped: result.skipped },
    { status: 'default', moved: '0', blocked: '1', skipped: '0' }
  );
});

test('та же зелёная проверка с regression: true не запускается — тикет в ready/', () => {
  putTicket('IMPL-REGRESSION', {
    dod: [
      '- [ ] Прежние тесты зелёные',
      checkLine(GREEN, ', regression: `true`'),
      '- [ ] Прежний набор зелёный',
      checkLine(trace('regression-ran'), ', regression: `true`'),
      '- [ ] Новое поведение',
      checkLine(RED)
    ]
  });

  const { output, result } = moveToReady(['IMPL-REGRESSION']);

  assert.equal(columnOf('IMPL-REGRESSION'), 'ready', output);
  assert.doesNotMatch(output, /check_green_before_start/);
  assert.equal(ran('regression-ran'), false, 'регрессионная проверка запускалась');
  assert.equal(frontmatterOf('IMPL-REGRESSION').blocked_reason, undefined);
  assert.equal(result.status, 'moved');
  assert.equal(result.moved, '1');
  assert.equal(result.blocked, '0');
});

test('красная проверка — тикет в ready/', () => {
  putTicket('IMPL-RED', { dod: ['- [ ] Критерий', checkLine(RED)] });

  const { output, result } = moveToReady(['IMPL-RED']);

  assert.equal(columnOf('IMPL-RED'), 'ready', output);
  assert.equal(result.moved, '1');
});

// ---------------------------------------------------------------------------
// Прочие исходы гейта
// ---------------------------------------------------------------------------

test('проверки исполняются в корне проекта, пункт называется своим номером', () => {
  putTicket('IMPL-CWD', {
    dod: [
      '- [ ] Файла ещё нет',
      checkLine(`node -e "process.exit(require('fs').existsSync('missing.txt') ? 0 : 1)"`),
      '- [ ] Файл в корне уже есть',
      checkLine(`node -e "process.exit(require('fs').existsSync('root-marker.txt') ? 0 : 1)"`)
    ]
  });

  const { output } = moveToReady(['IMPL-CWD']);

  assert.equal(columnOf('IMPL-CWD'), 'blocked', output);
  assert.equal(frontmatterOf('IMPL-CWD').blocked_reason, 'check_green_before_start: пункт 2');
});

test('denied — тикет в blocked/ с причиной отказа', () => {
  putTicket('IMPL-DENIED', { dod: ['- [ ] Сервис отвечает', checkLine('curl https://example.com')] });

  const { output, result } = moveToReady(['IMPL-DENIED']);

  assert.equal(columnOf('IMPL-DENIED'), 'blocked', output);
  assert.equal(frontmatterOf('IMPL-DENIED').blocked_reason, 'check_denied: пункт 1 (executable_not_allowed: curl)');
  assert.equal(result.blocked, '1');
});

test('неполная запись проверки — тикет в blocked/ с check_malformed', () => {
  putTicket('IMPL-MALFORMED', { dod: ['- [ ] Критерий', `  - check: \`${RED}\``] });

  const { output } = moveToReady(['IMPL-MALFORMED']);

  assert.equal(columnOf('IMPL-MALFORMED'), 'blocked', output);
  assert.equal(frontmatterOf('IMPL-MALFORMED').blocked_reason, 'check_malformed: пункт 1 (check_without_expect)');
});

test('пункты prose и visual гейт не проверяет — тикет в ready/', () => {
  putTicket('IMPL-PROSE', {
    dod: [
      '- [ ] Текст понятен',
      '  - prose: `понятность командой не проверить`',
      '- [ ] Кнопка на месте',
      '  - visual: `.workflow/evidence/screens/IMPL-PROSE-*.png`',
      '- [ ] Критерий',
      checkLine(RED)
    ]
  });

  const { output } = moveToReady(['IMPL-PROSE']);

  assert.equal(columnOf('IMPL-PROSE'), 'ready', output);
});

test('несколько тикетов: счётчики moved, blocked и skipped в ---RESULT---', () => {
  putTicket('IMPL-MIX-READY', { dod: ['- [ ] Критерий', checkLine(RED)] });
  putTicket('IMPL-MIX-BLOCKED', { dod: ['- [ ] Критерий', checkLine(trace('mix-ran'))] });

  const { output, result } = moveToReady(['IMPL-MIX-READY', 'IMPL-MIX-BLOCKED', 'IMPL-MIX-ABSENT']);

  assert.equal(columnOf('IMPL-MIX-READY'), 'ready', output);
  assert.equal(columnOf('IMPL-MIX-BLOCKED'), 'blocked', output);
  // След запущенной проверки виден — значит его отсутствие в тестах ниже что-то значит.
  assert.equal(ran('mix-ran'), true);
  assert.deepEqual(
    { status: result.status, moved: result.moved, blocked: result.blocked, skipped: result.skipped },
    { status: 'moved', moved: '1', blocked: '1', skipped: '1' }
  );
});

// ---------------------------------------------------------------------------
// Тикеты, к которым гейт не применяется
// ---------------------------------------------------------------------------

test('тикет без dod_format — как раньше: в ready/ без запуска проверок', () => {
  putTicket('IMPL-LEGACY', { dodFormat: null, dod: ['- [ ] Критерий', checkLine(trace('legacy-ran'))] });

  const { output, result } = moveToReady(['IMPL-LEGACY']);

  assert.equal(columnOf('IMPL-LEGACY'), 'ready', output);
  assert.doesNotMatch(output, /check_green_before_start/);
  assert.equal(ran('legacy-ran'), false, 'проверка тикета без dod_format запускалась');
  assert.equal(frontmatterOf('IMPL-LEGACY').blocked_reason, undefined);
  assert.equal(result.moved, '1');
});

test('human-тикет с dod_format: 2 — как раньше: в ready/ без запуска проверок', () => {
  putTicket('HUMAN-GATE', { type: 'human', dod: ['- [ ] Критерий', checkLine(trace('human-ran'))] });

  const { output } = moveToReady(['HUMAN-GATE']);

  assert.equal(columnOf('HUMAN-GATE'), 'ready', output);
  assert.doesNotMatch(output, /check_green_before_start/);
  assert.equal(ran('human-ran'), false, 'проверка human-тикета запускалась');
});
