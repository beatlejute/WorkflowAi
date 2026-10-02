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
 *  - тикет не в формате dod_format: 2 с записями проверок в DoD — dod_format_missing,
 *    код выхода 1, проверки не запускаются (PulseProxy 2026-09-28: FIX-032 и QA-163
 *    записаны с проверками без поля, и их ревью ушло модели); без записей проверок и
 *    тикет type: human — ok без запуска проверок;
 *  - файл тикета остаётся байт в байт прежним, тикет — в своей колонке;
 *  - тикет, которого нет на доске, — код выхода 1 с его id в выводе;
 *  - ошибка записи пункта DoD тикета dod_format: 2, которую гейт move-to-ready не называет
 *    (он смотрит только пункты check): пункт с двумя записями, без записи, prose без
 *    причины — `dod_record_invalid: пункт N (<ошибка>)` и код 1, в том числе у тикета
 *    type: human; ошибка записи check — по-прежнему check_malformed (ListeningGlass
 *    PLAN-001 2026-09-29: пункт с 2–3 записями скрипт пропускал, verify-atomicity провалил
 *    17 тикетов из 25); гейт move-to-ready на тех же тикетах — как раньше;
 *  - путь поиска `git grep` под .gitignore — строка [WARN], код выхода 0.
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
import { spawnSync, execFileSync } from 'node:child_process';
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

function putTicket(id, dod, { dodFormat = 2, type = 'fix' } = {}) {
  const text = [
    '---',
    `id: "${id}"`,
    'title: "Задача"',
    `type: ${type}`,
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

test('тикет с проверками без dod_format 2 — dod_format_missing и код 1, проверки не запускаются', () => {
  const marker = path.join(root, 'ran.txt');
  const file = putTicket('FIX-903', [
    '- [ ] Пункт',
    check(`node -e "require('fs').writeFileSync('ran.txt', '')"`),
  ], { dodFormat: null });
  const before = fs.readFileSync(file, 'utf8');

  const { code, out } = run('FIX-903');

  assert.equal(code, 1, out);
  assert.match(out, /FIX-903: dod_format_missing: проверки DoD есть, а dod_format: 2 во frontmatter нет/);
  assert.match(out, /status: problems/);
  assert.equal(fs.existsSync(marker), false, 'проверки тикета без dod_format 2 не исполняются');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'скрипт только читает тикет');
});

test('строка `- check:` вне пункта или рядом с prose без dod_format 2 — тоже dod_format_missing', () => {
  // До первого пункта parseDodChecks строку не читает; check и prose в одном пункте —
  // multiple_forms, kind null. Проверки автор всё равно писал.
  putTicket('FIX-906', [
    check(RED),
    '- [ ] Пункт',
  ], { dodFormat: null });
  putTicket('FIX-907', [
    '- [ ] Пункт',
    `${check(RED)}, prose: \`руками\``,
  ], { dodFormat: 1 });

  const { code, out } = run('FIX-906', 'FIX-907');

  assert.equal(code, 1, out);
  assert.match(out, /FIX-906: dod_format_missing/);
  assert.match(out, /FIX-907: dod_format_missing/);
  assert.match(out, /with_problems: 2/);
});

test('тикет без проверок и не в dod_format 2 — ok, гейт не применяется', () => {
  putTicket('FIX-904', [
    '- [ ] Пункт без проверки',
    '  - prose: `проверяется ревью`',
    '  - заметка: check: не запись проверки',
  ], { dodFormat: null });

  const { code, out } = run('FIX-904');

  assert.equal(code, 0, out);
  assert.match(out, /FIX-904: ok \(гейт не применяется: не dod_format 2\)/);
});

test('тикет type human с проверками без dod_format 2 — ok', () => {
  const file = path.join(backlog, 'HUMAN-905.md');
  fs.writeFileSync(file, [
    '---',
    'id: "HUMAN-905"',
    'type: human',
    '---',
    '',
    '## Критерии готовности (Definition of Done)',
    '',
    '- [ ] Пункт',
    check(RED),
    '',
  ].join('\n'), 'utf8');

  const { code, out } = run('HUMAN-905');

  assert.equal(code, 0, out);
  assert.match(out, /HUMAN-905: ok \(гейт не применяется: type human\)/);
});

test('тикета нет на доске — код 1 и его id в выводе', () => {
  const { code, out } = run('FIX-999');

  assert.equal(code, 1, out);
  assert.match(out, /FIX-999: тикет не найден/);
});

// ---------------------------------------------------------------------------
// Запись пункта DoD, которую гейт перед ready/ не разбирает
// ---------------------------------------------------------------------------

const MOVE_TO_READY = fileURLToPath(new URL('../scripts/move-to-ready.js', import.meta.url));
// Проверка, оставляющая след: файл в корне появится, только если её запускали.
const trace = (name) => `node -e "require('fs').writeFileSync('${name}', '')"`;

test('пункт с двумя записями, без записи, prose без причины, visual без пути, expect без check — dod_record_invalid и код 1; ошибка записи check — check_malformed', () => {
  putTicket('FIX-911', [
    '- [ ] Две записи',
    `${check(RED)}, prose: \`руками\``,
    '- [ ] Без записи',
    '- [ ] Причины нет',
    '  - prose: ``',
    '- [ ] Без expect',
    `  - check: \`${RED}\``,
    '- [ ] Пути нет',
    '  - visual: ``',
    '- [ ] expect у prose',
    '  - prose: `руками`, expect: `exit 0`',
    '- [ ] Правильная запись',
    check(RED),
  ]);

  const { code, out } = run('FIX-911');

  assert.equal(code, 1, out);
  assert.match(out, new RegExp([
    'FIX-911: dod_record_invalid: пункт 1 \\(multiple_forms\\)',
    'dod_record_invalid: пункт 2 \\(no_form\\)',
    'dod_record_invalid: пункт 3 \\(prose_without_reason\\)',
    'check_malformed: пункт 4 \\(check_without_expect\\)',
    'dod_record_invalid: пункт 5 \\(visual_without_path\\)',
    'dod_record_invalid: пункт 6 \\(keys_without_check\\)$',
  ].join('; '), 'm'));
  assert.match(out, /with_problems: 1/);
});

test('тикет type human с dod_format 2: ошибки записи — dod_record_invalid и check_malformed, проверки не запускаются', () => {
  putTicket('HUMAN-912', [
    '- [ ] Две записи',
    `${check(RED)}, prose: \`руками\``,
    '- [ ] Без expect',
    `  - check: \`${RED}\``,
    '- [ ] Зелёная проверка человека',
    check(trace('human-912-ran')),
  ], { type: 'human' });
  putTicket('HUMAN-913', ['- [ ] Результат записан', check(trace('human-913-ran'))], { type: 'human' });

  const { code, out } = run('HUMAN-912', 'HUMAN-913');

  assert.equal(code, 1, out);
  assert.match(out, /HUMAN-912: dod_record_invalid: пункт 1 \(multiple_forms\); check_malformed: пункт 2 \(check_without_expect\)$/m);
  assert.match(out, /HUMAN-913: ok \(type human: записи разобраны, проверки не запускаются\)/);
  assert.match(out, /with_problems: 1/);
  assert.equal(fs.existsSync(path.join(root, 'human-912-ran')), false, 'проверка тикета человека запускалась');
  assert.equal(fs.existsSync(path.join(root, 'human-913-ran')), false, 'проверка тикета человека запускалась');
});

test('гейт move-to-ready на тех же тикетах — как раньше: только check_malformed, пункты без формы check его не останавливают', () => {
  putTicket('FIX-914', [
    '- [ ] Две записи',
    `${check(RED)}, prose: \`руками\``,
    '- [ ] Без expect',
    `  - check: \`${RED}\``,
  ]);
  putTicket('FIX-915', ['- [ ] Две записи', `${check(RED)}, prose: \`руками\``, '- [ ] Без записи']);
  assert.match(run('FIX-914', 'FIX-915').out, /FIX-915: dod_record_invalid: пункт 1 \(multiple_forms\); dod_record_invalid: пункт 2 \(no_form\)/);

  const prompt = 'move-to-ready\n\nContext:\n  ready_tickets: FIX-914, FIX-915\n';
  const moved = spawnSync(process.execPath, [MOVE_TO_READY, prompt], { cwd: root, encoding: 'utf8' });

  assert.equal(moved.status, 0, moved.stderr);
  const blocked = fs.readFileSync(path.join(root, '.workflow', 'tickets', 'blocked', 'FIX-914.md'), 'utf8');
  assert.match(blocked, /^blocked_reason: "?check_malformed: пункт 2 \(check_without_expect\)"?$/m);
  assert.ok(fs.existsSync(path.join(root, '.workflow', 'tickets', 'ready', 'FIX-915.md')), moved.stdout);
});

test('путь git grep под .gitignore — строка [WARN] с номером пункта, код 0', () => {
  execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, '.gitignore'), 'research/\n', 'utf8');
  fs.mkdirSync(path.join(root, 'research'), { recursive: true });
  fs.writeFileSync(path.join(root, 'research', 'notes.md'), 'needle\n', 'utf8');
  putTicket('FIX-916', [
    '- [ ] Заметка записана',
    check('git grep -q --untracked "needle" -- research/notes.md'),
    '- [ ] Та же заметка, поиск видит игнорируемые файлы',
    check('git grep -q --untracked --no-exclude-standard "absent" -- research/notes.md'),
  ]);

  const { code, out } = run('FIX-916');

  assert.equal(code, 0, out);
  assert.match(out, /^FIX-916: ok$/m);
  assert.match(out, /^\[WARN\] FIX-916: check_path_ignored: пункт 1 \(research\/notes\.md — под \.gitignore/m);
  assert.doesNotMatch(out, /пункт 2/);
  assert.match(out, /status: ok/);
});
