import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

import yaml from '../lib/js-yaml.mjs';
import { PipelineRunner } from '../runner.mjs';
import { moveTicket } from '../lib/operations/tickets.mjs';
import { parseFrontmatter, serializeFrontmatter } from '../lib/utils.mjs';
import {
  createTicketContext,
  pickNextTicket,
} from '../scripts/pick-next-task-core.js';
import {
  blockHumanTicket,
  readRoutingTicket,
  recoverReviewBackup,
  TICKET_BACKUP_SUFFIX,
} from '../scripts/human-route-core.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const CANON = yaml.load(
  fs.readFileSync(path.join(ROOT, 'configs/pipeline.yaml'), 'utf8'),
).pipeline;

const STATUSES = [
  'backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'archive',
];

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-flow-'));
  for (const status of STATUSES) {
    fs.mkdirSync(
      path.join(root, '.workflow', 'tickets', status),
      { recursive: true },
    );
  }
  fs.mkdirSync(path.join(root, '.workflow', 'approvals'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function ticketPath(root, status, id = 'HUMAN-1') {
  return path.join(root, '.workflow', 'tickets', status, `${id}.md`);
}

const BODY = `
## Критерии готовности (Definition of Done)

- [x] Проверка выполнена
- [x] Решение записано

## Результат

Владелец подтвердил оба пункта. Решение: оставить выбранный вариант.

## Ревью

DoD 1, 2 не пройдены.
`;

function writeTicket(root, status, fields = {}, id = 'HUMAN-1') {
  const frontmatter = {
    id,
    title: 'Human test',
    priority: 1,
    type: 'human',
    executor_type: 'human',
    conditions: [],
    dependencies: [],
    ...fields,
  };
  fs.writeFileSync(
    ticketPath(root, status, id),
    serializeFrontmatter(frontmatter) + BODY,
  );
}

function parseResult(stdout) {
  const block = stdout.match(/---RESULT---\r?\n([\s\S]*?)---RESULT---/);
  assert.ok(block, stdout);
  return Object.fromEntries(
    block[1].trim().split(/\r?\n/).map((line) => {
      const separator = line.indexOf(':');
      assert.ok(separator > 0, line);
      return [
        line.slice(0, separator),
        line.slice(separator + 1).trim(),
      ];
    }),
  );
}

function cli(root, script, id = 'HUMAN-1') {
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'src', 'scripts', script),
      `${script}\n\nContext:\n  ticket_id: ${id}\n`,
    ],
    { cwd: root, encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return parseResult(result.stdout);
}

/**
 * CLI с ручным управлением stdin: env — переменные окружения, onSpawn получает
 * запущенный процесс до закрытия теста (писать в stdin, держать поток открытым).
 */
function spawnCli(root, script, { env, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'src', 'scripts', script)],
      { cwd: root, env: { ...process.env, ...env } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (onSpawn) onSpawn(child);
  });
}

/**
 * Берём рабочие стадии из канона. Заменяются только стадии, требующие
 * живого судьи/дальнейшей обработки плана, на терминальные счётчики.
 */
function runnerConfig(entry, context = {}) {
  const stageIds = [
    'manual-gate-human',
    'human-gate-route',
    'review-failure-route',
    'increment-task-attempts',
    'increment-review-errors',
    'increment-legacy-review-errors',
  ];
  const stages = Object.fromEntries(
    stageIds.map((id) => [id, structuredClone(CANON.stages[id])]),
  );

  stages['manual-gate-human'].poll_interval_ms = 100;
  stages['manual-gate-human'].timeout_seconds = 5;

  for (const id of [
    'pick-first-task',
    'review-result',
    'review-result-legacy',
    'mark-blocked',
    'mark-human-rejected',
    'move-ticket',
  ]) {
    stages[id] = {
      type: 'update-counter',
      counter: `visited_${id}`,
      goto: { default: 'end' },
    };
  }

  const agents = {};
  for (const name of [
    'script-human-gate-route',
    'script-review-failure-route',
  ]) {
    agents[name] = structuredClone(CANON.agents[name]);
    agents[name].command = process.execPath;
    agents[name].args = [
      path.join(ROOT, 'src', 'scripts', path.basename(agents[name].args[0])),
    ];
  }

  return {
    pipeline: {
      name: 'human-flow-routing-test',
      version: '1.0',
      entry,
      agents,
      stages,
      context: { ticket_id: 'HUMAN-1', ...context },
      execution: { max_steps: 20, delay_between_stages: 1 },
    },
  };
}

function makeRunner(root, entry, context) {
  const runner = new PipelineRunner(
    runnerConfig(entry, context),
    { project: root },
    { logFilePath: process.env.HF_LOG || path.join(root, '.workflow', 'test.log') },
  );
  // Убираем только межстадийную задержку. Polling gate остаётся рабочим.
  runner.sleep = async () => {};
  return runner;
}

function startFromReviewVerdict(runner, stageId, status) {
  runner.pipeline.stages[stageId] = structuredClone(CANON.stages[stageId]);
  runner.currentStage = runner.resolveNextStage(stageId, {
    status,
    result: { ticket_id: 'HUMAN-1' },
  });
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Не появился файл ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('failed human-ревью блокирует тикет и сохраняет решение без цикла', async (t) => {
  const root = setup(t);
  writeTicket(root, 'review');

  const before = parseFrontmatter(
    fs.readFileSync(ticketPath(root, 'review'), 'utf8'),
  ).body;

  const runner = makeRunner(root, 'review-failure-route');
  startFromReviewVerdict(runner, 'review-result', 'failed');

  const result = await runner.run();

  assert.ok(fs.existsSync(ticketPath(root, 'blocked')));
  assert.ok(!fs.existsSync(ticketPath(root, 'review')));
  assert.ok(!fs.existsSync(ticketPath(root, 'ready')));

  const blocked = parseFrontmatter(
    fs.readFileSync(ticketPath(root, 'blocked'), 'utf8'),
  );
  assert.equal(blocked.body, before);
  assert.match(blocked.frontmatter.blocked_reason, /human_review_failed/);
  assert.equal(runner.counters.task_attempts || 0, 0);
  assert.equal(result.humanActionRequired, true);
  assert.equal(result.stuck, true);
  assert.equal(result.failed, false);
  assert.ok(result.steps < 20);
  assert.equal(runner.counters['visited_pick-first-task'] || 0, 0);

  const log = fs.readFileSync(runner.logFilePath, 'utf8');
  assert.match(log, /Outcome: Pipeline waiting for human action/);
  assert.doesNotMatch(log, /Pipeline completed successfully!/);
});

test('failed legacy human-ревью использует тот же human-маршрут', async (t) => {
  const root = setup(t);
  writeTicket(root, 'review');

  const runner = makeRunner(root, 'review-failure-route');
  startFromReviewVerdict(runner, 'review-result-legacy', 'failed');
  const result = await runner.run();

  assert.ok(fs.existsSync(ticketPath(root, 'blocked')));
  assert.equal(runner.counters.task_attempts || 0, 0);
  assert.equal(result.humanActionRequired, true);
});

test('старый approved при ready даёт один исход ожидания и не меняет gate', async (t) => {
  const root = setup(t);
  writeTicket(root, 'ready');

  const approvalPath = path.join(
    root, '.workflow', 'approvals', 'HUMAN-1_manual-gate-human_0.json',
  );
  const approval = JSON.stringify({
    step_id: 'HUMAN-1_manual-gate-human_0',
    ticket_id: 'HUMAN-1',
    stage_id: 'manual-gate-human',
    attempt: 0,
    status: 'approved',
    decided_by: 'owner',
    comment: 'Предыдущее решение',
  }, null, 2);
  fs.writeFileSync(approvalPath, approval);

  const runner = makeRunner(root, 'manual-gate-human');
  const result = await runner.run();

  assert.equal(result.humanActionRequired, true);
  assert.equal(result.failed, false);
  assert.equal(result.stuck, true);
  assert.equal(runner.endedBy.data.reason, 'human_result_not_submitted');
  assert.equal(runner.counters['visited_pick-first-task'] || 0, 0);
  assert.ok(result.steps < 20);
  assert.equal(fs.readFileSync(approvalPath, 'utf8'), approval);
  assert.ok(fs.existsSync(ticketPath(root, 'ready')));
});

test('передача результата во время pending-gate открывает путь к приёмке', async (t) => {
  const root = setup(t);
  writeTicket(root, 'ready');

  const runner = makeRunner(root, 'manual-gate-human');
  const running = runner.run();
  const approvalPath = path.join(
    root, '.workflow', 'approvals', 'HUMAN-1_manual-gate-human_0.json',
  );

  try {
    await waitForFile(approvalPath);
    assert.equal(
      JSON.parse(fs.readFileSync(approvalPath, 'utf8')).status,
      'pending',
    );

    await moveTicket(root, 'HUMAN-1', 'review');
    const result = await running;

    assert.equal(
      JSON.parse(fs.readFileSync(approvalPath, 'utf8')).status,
      'approved',
    );
    assert.equal(runner.counters['visited_pick-first-task'], 1);
    assert.equal(result.humanActionRequired, false);

    // Рабочий selector видит переданный результат в очереди приёмки.
    const selected = pickNextTicket(createTicketContext(root));
    assert.equal(selected.status, 'in_review');
    assert.equal(selected.ticket_id, 'HUMAN-1');
  } finally {
    runner.running = false;
    await running;
  }
});

test('ошибка legacy-ревью повторяет legacy и не расходует попытку исполнения', async (t) => {
  const root = setup(t);
  writeTicket(root, 'review');

  const runner = makeRunner(root, 'increment-legacy-review-errors');
  runner.counters.task_attempts = 2;
  startFromReviewVerdict(runner, 'review-result-legacy', 'error');

  // Подменён только повторный вызов живого судьи.
  runner.pipeline.stages['review-result-legacy'] = {
    type: 'update-counter',
    counter: 'visited_legacy_retry',
    goto: { default: 'end' },
  };

  await runner.run();

  assert.equal(runner.counters.task_attempts, 2);
  assert.equal(runner.counters.review_error_attempts, 1);
  assert.equal(runner.counters.visited_legacy_retry, 1);
  assert.equal(runner.counters['visited_review-result'] || 0, 0);
  assert.ok(fs.existsSync(ticketPath(root, 'review')));
  assert.ok(!fs.existsSync(ticketPath(root, 'ready')));
});

test('агентский failed остаётся в существующем маршруте попыток', async (t) => {
  const root = setup(t);
  writeTicket(root, 'review', { type: 'impl', executor_type: 'agent' });

  const runner = makeRunner(root, 'review-failure-route');
  startFromReviewVerdict(runner, 'review-result', 'failed');
  await runner.run();

  assert.equal(runner.counters.task_attempts, 1);
  assert.equal(runner.counters['visited_move-ticket'], 1);
  assert.equal(runner.endedBy.stage, 'move-ticket');
});

test('оба обозначения human работают; противоречие требует человека', (t) => {
  const root = setup(t);
  const variants = [
    [{ type: 'human', executor_type: undefined }, 'human_review_failed'],
    [{ type: 'qa', executor_type: 'human' }, 'human_review_failed'],
    [{ type: 'human', executor_type: 'human' }, 'human_review_failed'],
    [{ type: 'human', executor_type: 'agent' }, 'human_metadata_conflict'],
  ];

  for (const [fields, reason] of variants) {
    for (const status of STATUSES) {
      fs.rmSync(ticketPath(root, status), { force: true });
    }
    writeTicket(root, 'review', fields);

    const result = cli(root, 'review-failure-route.js');
    assert.equal(result.status, 'human_action_required');
    assert.equal(result.reason, reason);

    if (reason === 'human_metadata_conflict') {
      assert.ok(fs.existsSync(ticketPath(root, 'review')));
      assert.ok(!fs.existsSync(ticketPath(root, 'blocked')));
    } else {
      assert.ok(fs.existsSync(ticketPath(root, 'blocked')));
    }
  }
});

test('human в ready после отказа не делает запрещённый ready → blocked', (t) => {
  const root = setup(t);
  writeTicket(root, 'ready');
  const before = fs.readFileSync(ticketPath(root, 'ready'), 'utf8');

  const result = cli(root, 'review-failure-route.js');

  assert.equal(result.status, 'human_action_required');
  assert.equal(result.reason, 'human_review_state_changed');
  assert.equal(fs.readFileSync(ticketPath(root, 'ready'), 'utf8'), before);
  assert.ok(!fs.existsSync(ticketPath(root, 'blocked')));
});

test('gate-маршрут различает актуальные состояния', (t) => {
  const root = setup(t);

  for (const status of STATUSES) {
    for (const previous of STATUSES) {
      fs.rmSync(ticketPath(root, previous), { force: true });
    }
    writeTicket(root, status);

    const result = cli(root, 'human-gate-route.js');

    assert.equal(result.ticket_status, status);
    assert.equal(
      result.status,
      ['review', 'done', 'archive'].includes(status)
        ? 'continue'
        : 'human_action_required',
    );
  }
});

test('исчезнувший тикет завершает ветку диагностической ошибкой', async (t) => {
  const root = setup(t);
  const runner = makeRunner(root, 'human-gate-route');
  const result = await runner.run();

  assert.equal(result.failed, true);
  assert.equal(result.stuck, true);
  assert.equal(result.humanActionRequired, false);
  assert.equal(runner.endedBy.status, 'human_route_error');

  const log = fs.readFileSync(runner.logFilePath, 'utf8');
  assert.match(log, /human routing error/);
  assert.doesNotMatch(log, /Pipeline completed successfully!/);
});

test('исключение стадии с goto.error: end — не успешное завершение', async (t) => {
  const root = setup(t);
  writeTicket(root, 'review');

  const runner = makeRunner(root, 'human-gate-route');
  // Стадия без списка агентов: StageExecutor падает с исключением.
  runner.pipeline.stages['human-gate-route'] = { goto: { error: { stage: 'end' } } };
  const result = await runner.run();

  assert.equal(result.failed, true);
  assert.equal(result.stuck, true);
  assert.equal(result.humanActionRequired, false);
  assert.equal(runner.endedBy.stage, 'human-gate-route');
  assert.equal(runner.endedBy.status, 'error');

  const log = fs.readFileSync(runner.logFilePath, 'utf8');
  // Маршрутная стадия — конкретное сообщение о сбое маршрута, с текстом ошибки.
  assert.match(log, /Outcome: Pipeline stopped: human routing error for HUMAN-1/);
  assert.match(log, /no agents list and no default_agents/);
  assert.doesNotMatch(log, /Pipeline completed successfully!/);
});

test('blockHumanTicket: снимок не совпал или файл исчез — тикет не тронут', (t) => {
  const root = setup(t);
  writeTicket(root, 'review');
  const stale = {
    id: 'HUMAN-1',
    status: 'review',
    filePath: ticketPath(root, 'review'),
    blockedDir: path.join(root, '.workflow', 'tickets', 'blocked'),
    frontmatter: { id: 'HUMAN-1', title: 'Human test' },
    body: '\nстарое тело\n',
    content: '---\nid: HUMAN-1\n---\nстарый снимок\n',
  };

  // Человек поправил файл после чтения маршрутом.
  assert.deepEqual(blockHumanTicket(stale, 'human_review_failed'), { changed: true });
  assert.ok(fs.existsSync(ticketPath(root, 'review')));
  assert.ok(!fs.existsSync(ticketPath(root, 'blocked')));

  // Человек переместил тикет: воссоздания ни в одной колонке быть не должно.
  fs.rmSync(ticketPath(root, 'review'));
  assert.deepEqual(blockHumanTicket(stale, 'human_review_failed'), { changed: true });
  assert.ok(!fs.existsSync(ticketPath(root, 'review')));
  assert.ok(!fs.existsSync(ticketPath(root, 'blocked')));
  assert.equal(
    fs.readdirSync(path.join(root, '.workflow', 'tickets', 'review')).length,
    0,
  );
});

test('blockHumanTicket: совпавший снимок переносит тикет в blocked с причиной', (t) => {  const root = setup(t);
  writeTicket(root, 'review');
  const raw = fs.readFileSync(ticketPath(root, 'review'), 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const result = blockHumanTicket(
    {
      id: 'HUMAN-1',
      status: 'review',
      filePath: ticketPath(root, 'review'),
      blockedDir: path.join(root, '.workflow', 'tickets', 'blocked'),
      frontmatter,
      body,
      content: raw,
    },
    'human_review_failed',
  );

  assert.ok(result.targetPath);
  assert.ok(!fs.existsSync(ticketPath(root, 'review')));
  const blocked = parseFrontmatter(
    fs.readFileSync(ticketPath(root, 'blocked'), 'utf8'),
  );
  assert.match(blocked.frontmatter.blocked_reason, /human_review_failed/);
  assert.equal(blocked.body, body);
});

test('резервная копия после падения блокировки восстанавливается при чтении тикета', (t) => {
  const root = setup(t);
  const raw = '---\nid: HUMAN-1\ntitle: Human test\npriority: 1\n---\nтело\n';
  const backupPath = path.join(
    root, '.workflow', 'tickets', 'review', `HUMAN-1.md${TICKET_BACKUP_SUFFIX}`,
  );
  fs.writeFileSync(backupPath, raw);

  const ticket = readRoutingTicket(root, 'HUMAN-1');

  assert.equal(ticket.status, 'review');
  assert.equal(ticket.content, raw);
  assert.ok(fs.existsSync(ticketPath(root, 'review')));
  assert.ok(!fs.existsSync(backupPath));
});

test('восстановление не заменяет тикет, созданный после падения', (t) => {
  const root = setup(t);
  const backupPath = path.join(
    root, '.workflow', 'tickets', 'review', `HUMAN-1.md${TICKET_BACKUP_SUFFIX}`,
  );
  fs.writeFileSync(backupPath, '---\nid: HUMAN-1\n---\nстарый оригинал\n');
  writeTicket(root, 'review'); // свежее решение человека

  const ticket = readRoutingTicket(root, 'HUMAN-1');

  // Действует свежий тикет, копия дожидается ручного разбора.
  assert.equal(ticket.status, 'review');
  assert.match(ticket.content, /Human test/);
  assert.ok(fs.existsSync(backupPath));
});

test('занятый слот — повторный поиск, а не отказ с ручным разбором', (t) => {
  const root = setup(t);
  const reviewDir = path.join(root, '.workflow', 'tickets', 'review');
  const backupPath = path.join(reviewDir, `HUMAN-1.md${TICKET_BACKUP_SUFFIX}`);
  fs.writeFileSync(backupPath, '---\nid: HUMAN-1\n---\nстарый оригинал\n');
  writeTicket(root, 'review'); // появился между сканированием и link

  const reason = recoverReviewBackup(
    { reviewDir, fs },
    'HUMAN-1',
  );

  // Слот занят: копия сохранена, вызывавший делает повторное сканирование.
  assert.equal(reason, 'slot-taken');
  assert.ok(fs.existsSync(backupPath));
  assert.ok(fs.existsSync(ticketPath(root, 'review')));
});

test('blocked-тикет, созданный конкурентом, не заменяется', async (t) => {  const root = setup(t);
  writeTicket(root, 'review');
  fs.writeFileSync(
    path.join(root, '.workflow', 'tickets', 'blocked', 'HUMAN-1.md'),
    '---\nid: HUMAN-1\n---\nчужой новый тикет\n',
  );
  const raw = fs.readFileSync(ticketPath(root, 'review'), 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);

  await assert.rejects(
    () => cliAsyncBlock(root, raw, frontmatter, body),
    /уже создан конкурентом/,
  );

  // Оригинал вернулся в review, чужой blocked-тикет не тронут.
  assert.ok(fs.existsSync(ticketPath(root, 'review')));
  assert.match(
    fs.readFileSync(path.join(root, '.workflow', 'tickets', 'blocked', 'HUMAN-1.md'), 'utf8'),
    /чужой новый тикет/,
  );
});

/** blockHumanTicket с собранным вручную тикетом (для гонок с готовым blocked). */
function cliAsyncBlock(root, raw, frontmatter, body) {
  return Promise.resolve().then(() => blockHumanTicket(
    {
      id: 'HUMAN-1',
      status: 'review',
      filePath: ticketPath(root, 'review'),
      blockedDir: path.join(root, '.workflow', 'tickets', 'blocked'),
      frontmatter,
      body,
      content: raw,
    },
    'human_review_failed',
  ));
}

test('свежий замок другого запуска останавливает маршрутизацию', (t) => {
  const root = setup(t);
  writeTicket(root, 'review');
  fs.writeFileSync(
    path.join(root, '.workflow', 'tickets', 'review', 'HUMAN-1.md.route-lock'),
    '99999',
  );

  const result = cli(root, 'review-failure-route.js');

  assert.equal(result.status, 'human_route_error');
  assert.match(result.message, /уже выполняется другим процессом/);
  assert.ok(fs.existsSync(ticketPath(root, 'review')));
  assert.ok(!fs.existsSync(ticketPath(root, 'blocked')));
});

test('протухший замок погибшего запуска не угоняется — отказ называет файл', (t) => {
  const root = setup(t);
  writeTicket(root, 'review');
  const lockPath = path.join(
    root, '.workflow', 'tickets', 'review', 'HUMAN-1.md.route-lock',
  );
  fs.writeFileSync(lockPath, '99999');
  const longAgo = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockPath, longAgo, longAgo);

  const result = cli(root, 'review-failure-route.js');

  assert.equal(result.status, 'human_route_error');
  assert.match(result.message, /погибший запуск/);
  assert.match(result.message, /route-lock/);
  // Никакой угон: замок и тикет на месте, операция не выполнена.
  assert.ok(fs.existsSync(lockPath));
  assert.ok(fs.existsSync(ticketPath(root, 'review')));
  assert.ok(!fs.existsSync(ticketPath(root, 'blocked')));
});

test('восстановление копии не срывает операцию под замком', (t) => {
  const root = setup(t);
  const backupPath = path.join(
    root, '.workflow', 'tickets', 'review', `HUMAN-1.md${TICKET_BACKUP_SUFFIX}`,
  );
  fs.writeFileSync(backupPath, '---\nid: HUMAN-1\n---\nзахваченный оригинал\n');
  fs.writeFileSync(
    path.join(root, '.workflow', 'tickets', 'review', 'HUMAN-1.md.route-lock'),
    '99999',
  );

  assert.throws(() => readRoutingTicket(root, 'HUMAN-1'), /удалите замок/);

  // Копия и замок нетронуты: живая операция не сорвана.
  assert.ok(fs.existsSync(backupPath));
  assert.ok(fs.existsSync(path.join(
    root, '.workflow', 'tickets', 'review', 'HUMAN-1.md.route-lock',
  )));
  assert.ok(!fs.existsSync(ticketPath(root, 'review')));
});

test('blockHumanTicket отказывается работать при тикете и копии одновременно', (t) => {
  const root = setup(t);
  writeTicket(root, 'review');
  fs.writeFileSync(
    path.join(root, '.workflow', 'tickets', 'review', `HUMAN-1.md${TICKET_BACKUP_SUFFIX}`),
    'старый оригинал',
  );
  const raw = fs.readFileSync(ticketPath(root, 'review'), 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);

  assert.throws(
    () => blockHumanTicket(
      {
        id: 'HUMAN-1',
        status: 'review',
        filePath: ticketPath(root, 'review'),
        blockedDir: path.join(root, '.workflow', 'tickets', 'blocked'),
        frontmatter,
        body,
        content: raw,
      },
      'human_review_failed',
    ),
    /резервная копия/,
  );
  // Оба файла на месте: маршрут ничего не решил за человека.
  assert.ok(fs.existsSync(ticketPath(root, 'review')));
  assert.ok(fs.existsSync(path.join(
    root, '.workflow', 'tickets', 'review', `HUMAN-1.md${TICKET_BACKUP_SUFFIX}`,
  )));
});

test('stdin: промпт, доставленный с задержкой, разбирается целиком', async (t) => {
  const root = setup(t);
  writeTicket(root, 'review');

  const { code, stdout, stderr } = await spawnCli(root, 'review-failure-route.js', {
    onSpawn: (proc) => {
      setTimeout(() => {
        proc.stdin.write('review-failure-route\n\nContext:\n  ticket_id: HUMAN-1\n');
        proc.stdin.end();
      }, 300);
    },
  });

  assert.equal(code, 0, stderr);
  const result = parseResult(stdout);
  assert.equal(result.status, 'human_action_required');
  assert.equal(result.reason, 'human_review_failed');
  assert.ok(fs.existsSync(ticketPath(root, 'blocked')));
});

test('stdin: незакрытый поток за таймаут — ошибка чтения, не частичный разбор', async (t) => {
  const root = setup(t);
  writeTicket(root, 'review');

  const { code, stdout, stderr } = await spawnCli(root, 'review-failure-route.js', {
    env: { HUMAN_ROUTE_STDIN_TIMEOUT_MS: '200' },
    onSpawn: (proc) => {
      proc.stdin.write('review-failure-route\n\nContext:\n  ticket_id: HU');
      // end() не вызываем: поток остаётся открытым дальше порога.
    },
  });

  assert.equal(code, 0, stderr);
  const result = parseResult(stdout);
  assert.equal(result.status, 'human_route_error');
  assert.equal(result.reason, 'route_input_error');
  assert.match(result.message, /stdin не закрыт/);
  assert.ok(fs.existsSync(ticketPath(root, 'review')));
  assert.ok(!fs.existsSync(ticketPath(root, 'blocked')));
});

test('дубли тикета не выбираются произвольно', (t) => {
  const root = setup(t);
  writeTicket(root, 'ready');
  writeTicket(root, 'review');

  const result = cli(root, 'human-gate-route.js');

  assert.equal(result.status, 'human_route_error');
  assert.match(result.message, /нескольких колонках/);
});

test('предпроверка human тоже использует общий failed-маршрут', () => {
  assert.equal(
    CANON.stages['verify-artifacts'].goto.failed.stage,
    'review-failure-route',
  );
  assert.equal(
    CANON.stages['review-result'].goto.failed.stage,
    'review-failure-route',
  );
  assert.equal(
    CANON.stages['review-result-legacy'].goto.failed.stage,
    'review-failure-route',
  );
  assert.equal(
    CANON.stages['review-result-legacy'].goto.error.stage,
    'increment-legacy-review-errors',
  );
});
