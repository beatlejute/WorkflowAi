import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRailsConfig, validateRailsConfig } from '../rails/rails-config.mjs';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'rails', 'config');

function codes(result) {
  return result.errors.map((e) => e.code);
}
function fields(result) {
  return result.errors.map((e) => e.field);
}

// --- loadRailsConfig -------------------------------------------------------

test('loadRailsConfig: полный rails.yaml читается как есть (никакие поля не теряются)', () => {
  const cfg = loadRailsConfig(join(FIXTURES, 'valid-skill'));
  assert.equal(cfg.version, 1);
  assert.equal(cfg.skill, 'coach');
  assert.equal(cfg.entry, 'P0E1');
  assert.deepEqual(cfg.terminal, ['P8S3']);
  assert.deepEqual(cfg.pause_nodes, ['P3Q1', 'P7S2']);
  assert.deepEqual(cfg.fragments, ['workflows/*.md']);
  assert.equal(cfg.quote_min, 25);
  assert.equal(cfg.canary, 'echo RAILS_CANARY');
  assert.equal(cfg.allow_temp, true);
  assert.deepEqual(cfg.write_scope, ['.workflow/src/skills/**', '.workflow/coach-backlog.yaml']);
  assert.deepEqual(cfg.write_deny, ['.workflow/src/skills/coach/rails.yaml', '.workflow/src/rails/**']);
  assert.equal(cfg.deny_shell.length, 1);
  assert.equal(cfg.deny_shell[0].reason, 'Коуч не выполняет git-операции — коммит делает исключительно пользователь');
  assert.deepEqual(cfg.deny_mcp, ['git_commit', 'git_create_branch', 'git_open_pr']);
  assert.ok(cfg.stage_actions.run_tests);
  assert.equal(cfg.stage_actions.run_tests.max_per_session, 3);
  assert.equal(cfg.cycles.length, 1);
  assert.equal(cfg.cycles[0].max, 3);
  assert.deepEqual(cfg.output.final_requires, ['RAILS:\\s*P\\d+[ERSGQ]\\d+', 'verdict\\s*=', 'Файлы:']);
  assert.equal(cfg.output.max_stop_blocks, 2);

  const check = validateRailsConfig(cfg);
  assert.deepEqual(check.errors, []);
});

test('loadRailsConfig: минимальный rails.yaml дополняется дефолтами §4', () => {
  const cfg = loadRailsConfig(join(FIXTURES, 'minimal-skill'));
  assert.equal(cfg.skill, 'minimal');
  assert.equal(cfg.entry, 'P0E1');
  assert.deepEqual(cfg.terminal, []);
  assert.deepEqual(cfg.pause_nodes, []);
  assert.deepEqual(cfg.fragments, ['workflows/*.md']);
  assert.equal(cfg.quote_min, 25);
  assert.equal(cfg.canary, null);
  assert.equal(cfg.allow_temp, false);
  assert.deepEqual(cfg.write_scope, []);
  assert.deepEqual(cfg.write_deny, []);
  assert.deepEqual(cfg.deny_shell, []);
  assert.deepEqual(cfg.deny_mcp, []);
  assert.deepEqual(cfg.stage_actions, {});
  assert.deepEqual(cfg.cycles, []);
  assert.deepEqual(cfg.output, { final_requires: [], final_forbids: [], max_stop_blocks: 2 });

  const check = validateRailsConfig(cfg);
  assert.deepEqual(check.errors, []);
});

test('loadRailsConfig: несуществующий rails.yaml — ошибка чтения не глотается', () => {
  assert.throws(() => loadRailsConfig(join(FIXTURES, 'nonexistent-skill')));
});

test('loadRailsConfig: синтаксически битый YAML — throws, не глотается', () => {
  assert.throws(() => loadRailsConfig(join(FIXTURES, 'broken-yaml-skill')));
});

test('loadRailsConfig: корень YAML — список, не объект — не расползается по числовым ключам spread', () => {
  const cfg = loadRailsConfig(join(FIXTURES, 'list-root-skill'));
  assert.ok(Array.isArray(cfg));
  const check = validateRailsConfig(cfg);
  assert.equal(check.errors.length, 1);
  assert.equal(check.errors[0].code, 'bad-type');
  assert.equal(check.errors[0].field, '$');
});

test('loadRailsConfig: корень YAML — скаляр, не объект — тоже bad-type, а не молчаливые дефолты', () => {
  const cfg = loadRailsConfig(join(FIXTURES, 'scalar-root-skill'));
  const check = validateRailsConfig(cfg);
  assert.equal(check.errors.length, 1);
  assert.equal(check.errors[0].code, 'bad-type');
});

test('loadRailsConfig: output — скаляр (число) не растворяется в дефолтах, validate ловит bad-type', () => {
  const cfg = loadRailsConfig(join(FIXTURES, 'output-scalar-skill'));
  assert.equal(cfg.output, 5);
  const check = validateRailsConfig(cfg);
  const err = check.errors.find((e) => e.field === 'output');
  assert.ok(err, 'output: 5 должен дать bad-type, а не пройти молча');
  assert.equal(err.code, 'bad-type');
});

test('loadRailsConfig: output — список не растворяется в дефолтах через spread числовых ключей', () => {
  const cfg = loadRailsConfig(join(FIXTURES, 'output-list-skill'));
  assert.deepEqual(cfg.output, [1, 2]);
  const check = validateRailsConfig(cfg);
  const err = check.errors.find((e) => e.field === 'output');
  assert.ok(err, 'output: [1,2] должен дать bad-type, а не пройти молча');
  assert.equal(err.code, 'bad-type');
});

// --- validateRailsConfig ----------------------------------------------------

test('validateRailsConfig: объект с дефолтами — ошибок нет', () => {
  const result = validateRailsConfig({ version: 1, skill: 'x', entry: 'P0E1' });
  assert.deepEqual(result.errors, []);
});

test('validateRailsConfig: не объект', () => {
  const result = validateRailsConfig(null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'bad-type');
});

test('validateRailsConfig: обязательные поля skill/entry отсутствуют', () => {
  const result = validateRailsConfig({ version: 1 });
  assert.ok(fields(result).includes('skill'));
  assert.ok(fields(result).includes('entry'));
  assert.ok(codes(result).every((c) => c === 'missing-field'));
});

test('validateRailsConfig: невалидный rails.yaml (фикстура invalid-skill) — каждая проблема поймана', () => {
  const cfg = loadRailsConfig(join(FIXTURES, 'invalid-skill'));
  const result = validateRailsConfig(cfg);
  const f = fields(result);

  assert.ok(f.includes('skill'), 'skill отсутствует');
  assert.ok(f.includes('version'), 'version: 2 не поддерживается');
  assert.ok(f.includes('entry'), 'entry: 42 — не строка');
  assert.ok(f.includes('terminal'), 'terminal — строка, а не массив');
  assert.ok(f.includes('quote_min'), 'quote_min отрицательный');
  assert.ok(f.includes('allow_temp'), 'allow_temp — строка, а не булево');
  assert.ok(f.includes('deny_shell[0].pattern') || f.some((x) => x.startsWith('deny_shell[0]')), 'невалидный regex в deny_shell');
  assert.ok(f.some((x) => x.startsWith('deny_shell[0]') && x.endsWith('.reason')), 'reason должен быть строкой');
  assert.ok(f.includes('stage_actions.edit_skill.kind'), 'kind пустой массив');
  assert.ok(f.includes('stage_actions.edit_skill.match'), 'match — число, а не строка');
  assert.ok(f.includes('stage_actions.edit_skill.stages'), 'stages содержит строку, а не число');
  assert.ok(f.includes('stage_actions.edit_skill.max_per_session'), 'max_per_session отрицательный');
  assert.ok(f.includes('cycles[0].from'), 'cycles[0].from — строка, а не число');
  assert.ok(f.includes('cycles[0].max'), 'cycles[0].max отрицательный');
  assert.ok(f.includes('output.final_requires[0]'), 'невалидный regex в output.final_requires');
  assert.ok(f.includes('output.max_stop_blocks'), 'max_stop_blocks отрицательный');
});

test('validateRailsConfig: deny_shell с валидным regex — без ошибок по этому полю', () => {
  const result = validateRailsConfig({
    version: 1,
    skill: 'x',
    entry: 'P0E1',
    deny_shell: [{ pattern: '\\bgit\\s+commit\\b', reason: 'нет коммитов' }],
  });
  assert.deepEqual(result.errors, []);
});

test('validateRailsConfig: version отличный от 1 — ошибка', () => {
  const result = validateRailsConfig({ version: 2, skill: 'x', entry: 'P0E1' });
  assert.ok(fields(result).includes('version'));
});

test('validateRailsConfig: kind вне перечисления §6 — bad-value, не молчит', () => {
  const result = validateRailsConfig({
    version: 1,
    skill: 'x',
    entry: 'P0E1',
    stage_actions: {
      edit_skill: { kind: ['bogus'], match: '.workflow/**', stages: [4] },
    },
  });
  const err = result.errors.find((e) => e.field === 'stage_actions.edit_skill.kind[0]');
  assert.ok(err);
  assert.equal(err.code, 'bad-value');
});

test('validateRailsConfig: kind: shell с невалидным regex в match — bad-regex, не тонет до первого действия', () => {
  const result = validateRailsConfig({
    version: 1,
    skill: 'x',
    entry: 'P0E1',
    stage_actions: {
      a: { kind: ['shell'], match: '[', stages: [1] },
    },
  });
  const err = result.errors.find((e) => e.field === 'stage_actions.a.match');
  assert.ok(err);
  assert.equal(err.code, 'bad-regex');
});

test('validateRailsConfig: kind: edit|write — match не проверяется как regex (это glob)', () => {
  const result = validateRailsConfig({
    version: 1,
    skill: 'x',
    entry: 'P0E1',
    stage_actions: {
      edit_skill: { kind: ['edit'], match: '[', stages: [4] },
    },
  });
  assert.deepEqual(result.errors, []);
});

test('validateRailsConfig: stage_actions с корректным правилом — без ошибок', () => {
  const result = validateRailsConfig({
    version: 1,
    skill: 'x',
    entry: 'P0E1',
    stage_actions: {
      run_tests: { kind: ['shell'], match: 'run-skill-tests\\.js', stages: [5], max_per_session: 3 },
    },
  });
  assert.deepEqual(result.errors, []);
});

// --- edge_guards: страж ребра (§4) ------------------------------------------

test('validateRailsConfig: edge_guards с корректным стражем — без ошибок', () => {
  const result = validateRailsConfig({
    version: 1,
    skill: 'x',
    entry: 'P0E1',
    edge_guards: [
      { from: 'P0Q1', to: 'P7E1', deny_if_exists: '.workflow/tickets/in-progress/*.md', reason: 'тикет есть', incident: '2026-09-27' },
      { from: 'P2G1', to: 'P7E1', deny_if_exists: 'marker.flag', reason: 'маркер есть' },
    ],
  });
  assert.deepEqual(result.errors, []);
});

test('validateRailsConfig: edge_guards — не массив, не объект, плохие узлы, путь и reason', () => {
  assert.deepEqual(codes(validateRailsConfig({ version: 1, skill: 'x', entry: 'P0E1', edge_guards: {} })), ['bad-type']);
  const result = validateRailsConfig({
    version: 1,
    skill: 'x',
    entry: 'P0E1',
    edge_guards: [
      'P0Q1>P7E1',
      { from: 'Q1', to: 'P7E1', deny_if_exists: 'a/*.md', reason: 'r' },
      { from: 'P0Q1', to: 'P7E1', deny_if_exists: '.workflow/**/x.md', reason: 'r' },
      { from: 'P0Q1', to: 'P7E1', deny_if_exists: '*/x.md', reason: 'r' },
      { from: 'P0Q1', to: 'P7E1', deny_if_exists: '../x.md', reason: 'r' },
      { from: 'P0Q1', to: 'P7E1', deny_if_exists: '/abs/x.md', reason: 'r' },
      { from: 'P0Q1', to: 'P7E1', deny_if_exists: 'a/x.md', reason: ' ' },
      { from: 'P0Q1', to: 'P7E1', deny_if_exists: 'a/x.md', reason: 'r', incident: 5 },
    ],
  });
  assert.deepEqual(fields(result), [
    'edge_guards[0]',
    'edge_guards[1].from',
    'edge_guards[2].deny_if_exists',
    'edge_guards[3].deny_if_exists',
    'edge_guards[4].deny_if_exists',
    'edge_guards[5].deny_if_exists',
    'edge_guards[6].reason',
    'edge_guards[7].incident',
  ]);
});

// `{ticket}` — id тикета запуска (WORKFLOW_RAILS_TICKET): допустим в любом сегменте. Другие
// подстановки рельсы не знают — страж молча смотрел бы на файл `{id}.md`, которого нет.
test('validateRailsConfig: edge_guards — {ticket} в пути допустим, другая подстановка — bad-glob с её именем', () => {
  const guard = (deny_if_exists) => ({ from: 'P0Q1', to: 'P7E1', deny_if_exists, reason: 'r' });
  const ok = validateRailsConfig({
    version: 1,
    skill: 'x',
    entry: 'P0E1',
    edge_guards: [
      guard('.workflow/tickets/in-progress/{ticket}.md'),
      guard('.workflow/work/{ticket}/done.flag'),
      guard('.workflow/tickets/review/{ticket}*.md'),
    ],
  });
  assert.deepEqual(ok.errors, []);

  const bad = validateRailsConfig({
    version: 1,
    skill: 'x',
    entry: 'P0E1',
    edge_guards: [
      guard('.workflow/tickets/in-progress/{id}.md'),
      guard('.workflow/{run}/{ticket}.md'),
      guard('.workflow/tickets/{ticket}{Ticket}.md'),
      guard('.workflow/tickets/in-progress/{ticket.md'),
    ],
  });
  assert.deepEqual(codes(bad), ['bad-glob', 'bad-glob', 'bad-glob', 'bad-glob']);
  assert.deepEqual(fields(bad), [0, 1, 2, 3].map((i) => `edge_guards[${i}].deny_if_exists`));
  assert.match(bad.errors[0].message, /неизвестная подстановка \{id\} — допустима только \{ticket\}/);
  assert.match(bad.errors[1].message, /неизвестная подстановка \{run\} —/);
  assert.match(bad.errors[2].message, /неизвестная подстановка \{Ticket\} —/);
  assert.match(bad.errors[3].message, /из подстановок — только \{ticket\}/, 'непарная скобка — общее правило пути');
});
