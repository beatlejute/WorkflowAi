/**
 * Повтор по вердикту рельс в StageExecutor.callAgent (rails/README.md §8, §11).
 *
 * Прогон PulseProxy 2026-09-27: при нарушении output-check раннер запускал агента заново —
 * новый процесс, новая сессия claude, новый `WORKFLOW_RAILS_RUN` — с вердиктом «Числишься
 * в <узел>. Переходы оттуда: goto …». Рельсы новой сессии стояли в `entry`, и `goto` в узел
 * прошлой сессии они отклоняли («нет ребра из P0E1 в P7S2»); два повтора claude-haiku
 * ответили за два хода без единого вызова инструмента, напечатав команду goto текстом, и
 * такой ответ принимался без output-check.
 *
 * Что охраняется:
 *  - хост по команде умеет продолжение (claude — `--resume <id>`, kilo — `run --session <id>`)
 *    и у запуска одно состояние рельс → повтор в той же сессии: тот же `WORKFLOW_RAILS_RUN`,
 *    промпт — только вердикт «Сессия та же. Числишься в <узел>» с командами переходов,
 *    новое состояние рельс не появляется;
 *  - вердикт той же сессии — всегда через stdin, даже однострочный (ответ в терминале, переходов
 *    нет) у записи без `prompt_stdin`: иначе на Windows он шёл в командную строку cmd.exe, и
 *    шаблон rails.yaml с `|` ломал запуск повтора;
 *  - продолжить нельзя (флаг сессии в записи агента, две сессии у запуска, хост не по
 *    команде) → новая сессия с новым `run`, вердикт без «Числишься»: старт графа заново
 *    командой `start`, сделанное — в файлах, затем исходный промпт;
 *  - ответ повтора проходит output-check (`railsRetryVerdict`): нарушение и повтор без
 *    единого вызова инструмента — предупреждение в лог, ответ отдаётся стадии, третьего
 *    запуска нет.
 *
 * Фейковый хост — один скрипт за обёртками `claude`/`kilo` (имя команды задаёт хост,
 * railsHost) и за `node`: на каждом вызове берёт строку плана, выбирает сессию (из
 * `--resume` / `--session` или новую) и пишет её состояние рельс так, как хук: `run` —
 * только при создании файла. Имена моделей и агентов — нейтральные.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/runner-rails-retry.test.mjs
 */

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StageExecutor } from '../runner.mjs';
import { setKiloDbPathCache } from '../lib/kilo-models.mjs';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-rails-retry-'));
after(() => {
  setKiloDbPathCache();
  fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
// База kilo не нужна: без пути опрос моделей молчит и `kilo db path` не запускается.
beforeEach(() => setKiloDbPathCache(null));

const SKILL = 'demo-skill';
const ORIGINAL_PROMPT = 'do the task';
const BIN = path.join(BASE, 'bin');
fs.mkdirSync(BIN, { recursive: true });

const STUB = path.join(BIN, 'host-stub.mjs');
fs.writeFileSync(STUB, `
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const ctl = process.env.FAKE_HOST_CTL;
const plan = JSON.parse(fs.readFileSync(path.join(ctl, 'plan.json'), 'utf8'));
const counterFile = path.join(ctl, 'counter');
const n = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1;
fs.writeFileSync(counterFile, String(n));
const step = plan.calls[Math.min(n, plan.calls.length) - 1];
const args = process.argv.slice(2);
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const prompt = fs.readFileSync(0, 'utf8');
const resumed = after('--resume') || after('--session');
const session = resumed || (plan.kind === 'kilo' ? 'ses_' + n : crypto.randomUUID());
const run = process.env.WORKFLOW_RAILS_RUN || null;
const dir = path.join(process.cwd(), '.workflow', 'state', 'rails');
fs.mkdirSync(dir, { recursive: true });
const write = (id, node) => {
  const file = path.join(dir, id + '.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  fs.writeFileSync(file, JSON.stringify({ version: 1, session: id, run: prev ? prev.run : run, skill: process.env.WORKFLOW_RAILS_SKILL, node }));
};
if (!step.noState) write(session, step.node);
if (step.extraSession) write(session + '-sub', 'P1E1');
fs.writeFileSync(path.join(ctl, 'call-' + n + '.json'), JSON.stringify({ args, prompt, run, session }));
process.stdout.write((step.marker ? 'RAILS: P1S1\\n' : (step.text || '')) + '---RESULT---\\nstatus: passed\\n---RESULT---\\n');
`);

function wrapper(name) {
  if (process.platform === 'win32') {
    const cmd = path.join(BIN, `${name}.cmd`);
    fs.writeFileSync(cmd, `@node "%~dp0host-stub.mjs" %*\r\n`);
    return cmd;
  }
  const sh = path.join(BIN, name);
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "$(dirname "$0")/host-stub.mjs" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

const CLAUDE = wrapper('claude');
const KILO = wrapper('kilo');
const CLAUDE_ARGS = ['--model', 'model-a', '--permission-mode', 'bypassPermissions', '-p'];
const KILO_ARGS = ['-m', 'prov/model-a', '--agent', 'code', 'run', '--auto'];

let seq = 0;

/**
 * Проект со скилом на рельсах (граф P1E1 → P1S1, терминал P1S1, по умолчанию — маркер в
 * ответе) и планом фейкового хоста. `finalRequires` — строка `output.final_requires` в
 * записи YAML (как в файле, с экранированием).
 */
function makeProject({ kind, calls, finalRequires = '"RAILS:\\\\s*P1S1"' }) {
  seq += 1;
  const root = path.join(BASE, `p${seq}`);
  const skillDir = path.join(root, '.workflow', 'src', 'skills', SKILL);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'rails.yaml'), [
    'version: 1',
    `skill: ${SKILL}`,
    'entry: P1E1',
    'terminal: [P1S1]',
    'quote_min: 25',
    'output:',
    '  final_requires:',
    `    - ${finalRequires}`,
    '  max_stop_blocks: 2',
  ].join('\n'));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '```mermaid',
    'graph TD',
    '    P1E1["П1 ВХОД: начало этапа проверки повтора раннера по вердикту"]',
    '    P1S1["П1 ШАГ: выдать результат проверки и остановиться на этом шаге"]',
    '    P1E1 --> P1S1',
    '```',
    '',
  ].join('\n'));
  const ctl = path.join(BASE, `p${seq}-ctl`);
  fs.mkdirSync(ctl, { recursive: true });
  fs.writeFileSync(path.join(ctl, 'plan.json'), JSON.stringify({ kind, calls }));
  return { root, ctl };
}

function makeLogger() {
  const lines = [];
  const push = (level) => (msg) => lines.push(`${level} ${msg}`);
  return {
    lines,
    info: push('INFO'), warn: push('WARN'), error: push('ERROR'),
    stageStart() {}, stageComplete() {}, cliCall() {}, timeout() {},
  };
}

/**
 * `promptStdin: true` (по умолчанию) — запись агента с `prompt_stdin: true`: фейковый хост
 * читает промпт из stdin на любой ОС. `false` — запись как у claude/kilo в configs/pipeline.yaml,
 * без `prompt_stdin`: однострочный промпт раннер кладёт в командную строку.
 */
async function callAgent(project, agent, { promptStdin = true } = {}) {
  const logger = makeLogger();
  const config = { pipeline: { name: 'rails-retry', version: '1.0', agents: {}, stages: {}, execution: { timeout_per_stage: 30 } } };
  const executor = new StageExecutor(config, {}, {}, {}, null, logger, project.root);
  const saved = process.env.FAKE_HOST_CTL;
  process.env.FAKE_HOST_CTL = project.ctl;
  try {
    const record = { workdir: '.', ...(promptStdin ? { prompt_stdin: true } : {}), ...agent };
    const result = await executor.callAgent(record, ORIGINAL_PROMPT, 'stage-1', SKILL, 'agent-a');
    return { result, logger };
  } finally {
    if (saved === undefined) delete process.env.FAKE_HOST_CTL; else process.env.FAKE_HOST_CTL = saved;
  }
}

const calls = (project) => Number(fs.readFileSync(path.join(project.ctl, 'counter'), 'utf8'));
const call = (project, n) => JSON.parse(fs.readFileSync(path.join(project.ctl, `call-${n}.json`), 'utf8'));
const stateFiles = (project) => fs.readdirSync(path.join(project.root, '.workflow', 'state', 'rails')).filter((f) => f.endsWith('.json'));
const warns = (logger) => logger.lines.filter((l) => l.startsWith('WARN '));
const logText = (logger) => logger.lines.join('\n');

/** Первый ответ — в не терминальном узле без маркера, повтор — терминал и маркер. */
const VIOLATE_THEN_FIX = [{ node: 'P1E1', marker: false }, { node: 'P1S1', marker: true }];

function assertSameSessionVerdict(prompt) {
  assert.match(prompt, /^RAILS: предыдущий ответ отклонён output-check — отсутствует: /);
  assert.match(prompt, /Сессия та же\. Числишься в P1E1\. Переходы оттуда:\n {2}P1S1: .* → node \.workflow\/src\/rails\/cli\.mjs goto P1S1 --quote '/);
  assert.doesNotMatch(prompt, new RegExp(ORIGINAL_PROMPT), 'исходный промпт сессия помнит — повтор шлёт только вердикт');
}

function assertNewSessionVerdict(prompt) {
  assert.match(prompt, /^RAILS: предыдущий ответ отклонён output-check — отсутствует: /);
  assert.doesNotMatch(prompt, /Числишься/, 'новой сессии не говорят, что она числится в узле прошлой');
  assert.match(prompt, /Прошлая сессия остановилась в P1E1, но это новая сессия/);
  assert.match(prompt, new RegExp(`\`node \\.workflow/src/rails/cli\\.mjs start ${SKILL}\``));
  assert.match(prompt, /Сделанное прошлой сессией осталось только в файлах проекта/);
  assert.ok(prompt.endsWith(ORIGINAL_PROMPT), 'исходный промпт — после вердикта');
}

describe('StageExecutor.callAgent — повтор по вердикту рельс', () => {
  test('claude: повтор в той же сессии — --resume <id>, тот же run, промпт — только вердикт', async () => {
    const project = makeProject({ kind: 'claude', calls: VIOLATE_THEN_FIX });
    const { result, logger } = await callAgent(project, { command: CLAUDE, args: CLAUDE_ARGS });

    assert.equal(calls(project), 2, 'первый запуск и один повтор');
    const [first, retry] = [call(project, 1), call(project, 2)];
    assert.deepEqual(retry.args, ['--resume', first.session, ...CLAUDE_ARGS]);
    assert.equal(retry.session, first.session);
    assert.equal(retry.run, first.run, 'WORKFLOW_RAILS_RUN прежний — состояние сессии хранит run первого запуска');
    assertSameSessionVerdict(retry.prompt);
    assert.deepEqual(stateFiles(project), [`${first.session}.json`], 'новой сессии рельс нет');

    assert.equal(result.railsRetried, true);
    assert.equal(result.railsRetrySession, 'same');
    assert.equal(result.railsRetryVerdict.ok, true, 'ответ повтора прошёл output-check');
    assert.match(result.output, /RAILS: P1S1/);
    assert.ok(warns(logger).some((l) => l.includes(`сессия та же (${first.session})`)), logText(logger));
    assert.ok(!warns(logger).some((l) => l.includes('повтор тоже') || l.includes('повтор без')), logText(logger));
  });

  test('kilo: повтор в той же сессии — run --session <id> с прежней меткой --title', async () => {
    const project = makeProject({ kind: 'kilo', calls: VIOLATE_THEN_FIX });
    const { result, logger } = await callAgent(project, { command: KILO, args: KILO_ARGS });

    assert.equal(calls(project), 2);
    const [first, retry] = [call(project, 1), call(project, 2)];
    assert.equal(first.session, 'ses_1');
    const title = first.args[first.args.indexOf('--title') + 1];
    assert.ok(title, `у запуска kilo есть метка: ${first.args.join(' ')}`);
    const sessionAt = retry.args.indexOf('--session');
    assert.ok(sessionAt > retry.args.indexOf('run'), `--session — опция подкоманды run: ${retry.args.join(' ')}`);
    assert.equal(retry.args[sessionAt + 1], 'ses_1');
    assert.equal(retry.args[retry.args.indexOf('--title') + 1], title, 'метка прежняя — по ней раннер находит модели сессии');
    assert.equal(retry.run, first.run);
    assert.equal(retry.session, 'ses_1');
    assertSameSessionVerdict(retry.prompt);
    assert.deepEqual(stateFiles(project), ['ses_1.json']);

    assert.equal(result.railsRetrySession, 'same');
    assert.equal(result.railsRetryVerdict.ok, true);
    assert.ok(warns(logger).some((l) => l.includes('сессия та же (ses_1)')), logText(logger));
  });

  test('та же сессия, агент без prompt_stdin, ответ в терминале: однострочный вердикт с `|` — через stdin, не в командную строку', async () => {
    // Ревью 2026-09-27: в терминальном узле переходов нет, вердикт — одна строка, а у записей
    // claude/kilo в configs/pipeline.yaml нет prompt_stdin. Однострочный промпт раннер кладёт
    // в командную строку, на Windows — через cmd.exe без кавычек, и шаблон rails.yaml с `|`
    // cmd.exe принимал за конвейер: повтор падал с кодом 255, хост не запускался.
    const project = makeProject({
      kind: 'claude',
      finalRequires: '"status:\\\\s*(default|blocked)"',
      calls: [{ node: 'P1S1', marker: false }, { node: 'P1S1', marker: false, text: 'status: default\n' }],
    });
    const { result, logger } = await callAgent(project, { command: CLAUDE, args: CLAUDE_ARGS }, { promptStdin: false });

    assert.equal(calls(project), 2, `фейковый хост запущен и повтором: ${logText(logger)}`);
    const [first, retry] = [call(project, 1), call(project, 2)];
    assert.deepEqual(retry.args, ['--resume', first.session, ...CLAUDE_ARGS], 'вердикта в командной строке нет');
    assert.match(retry.prompt, /^RAILS: предыдущий ответ отклонён output-check — отсутствует: status:\\s\*\(default\|blocked\)\./);
    assert.match(retry.prompt, /Сессия та же\. Числишься в P1S1\. /);
    assert.doesNotMatch(retry.prompt, /Переходы оттуда/, 'из терминала переходов нет — вердикт однострочный');
    assert.equal(result.railsRetrySession, 'same');
    assert.equal(result.railsRetryVerdict.ok, true, JSON.stringify(result.railsRetryVerdict));
    assert.match(result.output, /status: default/);
  });

  test('флаг сессии в записи агента — повтор в новой сессии: новый run, правдивый вердикт и исходный промпт', async () => {
    const project = makeProject({ kind: 'claude', calls: VIOLATE_THEN_FIX });
    const args = ['--no-session-persistence', ...CLAUDE_ARGS];
    const { result, logger } = await callAgent(project, { command: CLAUDE, args });

    assert.equal(calls(project), 2);
    const [first, retry] = [call(project, 1), call(project, 2)];
    assert.deepEqual(retry.args, args, 'без --resume');
    assert.notEqual(retry.session, first.session);
    assert.notEqual(retry.run, first.run, 'новая сессия — новый run');
    assertNewSessionVerdict(retry.prompt);

    assert.equal(result.railsRetrySession, 'new');
    assert.equal(result.railsRetryVerdict.ok, true, 'ответ повтора проверен по состоянию новой сессии');
    assert.ok(warns(logger).some((l) => l.includes('сессия новая — хост агента сессию не продолжает')), logText(logger));
  });

  test('две сессии рельс у запуска — id сессии не однозначен: повтор в новой сессии', async () => {
    const project = makeProject({ kind: 'kilo', calls: [{ node: 'P1E1', marker: false, extraSession: true }, { node: 'P1S1', marker: true }] });
    const { result, logger } = await callAgent(project, { command: KILO, args: KILO_ARGS });

    assert.equal(calls(project), 2);
    const [first, retry] = [call(project, 1), call(project, 2)];
    assert.ok(!retry.args.includes('--session'), retry.args.join(' '));
    assert.notEqual(retry.run, first.run);
    assert.match(retry.prompt, /это новая сессия/);
    assert.equal(result.railsRetrySession, 'new');
    assert.ok(warns(logger).some((l) => l.includes('сессия новая — сессий рельс у запуска: 2')), logText(logger));
  });

  test('повтор тоже нарушил output-check — предупреждение, ответ отдан стадии, третьего запуска нет', async () => {
    const project = makeProject({ kind: 'claude', calls: [{ node: 'P1E1', marker: false }, { node: 'P1E1', marker: false }] });
    const { result, logger } = await callAgent(project, { command: CLAUDE, args: CLAUDE_ARGS });

    assert.equal(calls(project), 2, 'повтор один');
    assert.equal(result.status, 'passed', 'статус ответа не подменяется — маршрут по переходам стадии');
    assert.equal(result.railsRetried, true);
    assert.equal(result.railsRetryVerdict.ok, false);
    assert.ok(result.railsRetryVerdict.missing.some((m) => m.startsWith('position:P1E1')), JSON.stringify(result.railsRetryVerdict));
    const warn = warns(logger).find((l) => l.includes('повтор тоже нарушил output-check'));
    assert.ok(warn, logText(logger));
    assert.match(warn, /отсутствует: .*position:P1E1/);
    assert.match(warn, /ответ принят без процедуры скила, дальше — по переходам стадии/);
  });

  test('повтор в новой сессии без единого вызова инструмента (команда goto текстом) — предупреждение, а не молчаливый приём', async () => {
    const project = makeProject({
      kind: 'node',
      calls: [
        { node: 'P1E1', marker: false },
        { noState: true, text: 'node .workflow/src/rails/cli.mjs goto P1S1\n' },
      ],
    });
    // Хост не по команде — продолжить нельзя, повтор в новой сессии.
    const { result, logger } = await callAgent(project, { command: 'node', args: [STUB] });

    assert.equal(calls(project), 2);
    assertNewSessionVerdict(call(project, 2).prompt);
    assert.equal(result.railsRetrySession, 'new');
    assert.deepEqual(result.railsRetryVerdict, { ok: false, missing: ['ни одного вызова инструмента под рельсами'] });
    assert.ok(warns(logger).some((l) => l.includes('повтор без единого вызова инструмента под рельсами — ответ принят без процедуры скила')), logText(logger));
  });
});
