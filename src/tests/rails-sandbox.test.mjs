// Песочница тестов скилов в core.decide (граница записи WORKFLOW_SANDBOX_ROOT).
//
// Регрессия 2026-09-23: агенты тестов create-plan и decompose-plan записали планы и
// тикеты в настоящий проект (PLAN-003/004/007, IMPL-41, QA-18). Проверка песочницы
// идёт до скила, роли и корня проекта: запись вне рабочего каталога прогона — отказ.
//
// Изоляция: каждый тест создаёт свои каталоги в os.tmpdir() и снимает их в finally.
// Пути «вне песочницы» только вычисляются хуком — на диске по ним ничего не создаётся.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, linkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { decide } from '../rails/core.mjs';
import { readJournal } from '../rails/journal.mjs';
import { createJunction } from '../junction-manager.mjs';
import { fromKilo } from '../rails/actions.mjs';

// Память «сессия → корень» (session-memo.mjs) — во временном WORKFLOW_HOME, как в rails-core.test.mjs.
process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-sandbox-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));

// Путь вне os.tmpdir() и вне песочницы, которого нет на диске: хук его только разбирает.
const OUTSIDE = join(homedir(), `.rails-sandbox-probe-${randomUUID()}`, 'PLAN-999.md');

function withSandbox(fn) {
  const sandbox = mkdtempSync(join(tmpdir(), 'wf-test-sandbox-'));
  mkdirSync(join(sandbox, '.workflow', 'logs'), { recursive: true });
  try {
    fn(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const write = (path) => ({ tool: 'Write', kind: 'write', path });
const bash = (command) => ({ tool: 'Bash', kind: 'shell', command, shell: 'posix' });
const ctxFor = (sandbox, extra = {}) => ({ cwd: sandbox, sessionId: randomUUID(), sandboxRoot: sandbox, ...extra });

test('песочница: запись внутри рабочего каталога прогона разрешена', () => {
  withSandbox((sandbox) => {
    const r = decide({ action: write(join(sandbox, '.workflow', 'plans', 'current', 'PLAN-001.md')), ctx: ctxFor(sandbox) });
    assert.equal(r.decision, 'allow');
  });
});

test('песочница: запись вне рабочего каталога — отказ с путём и корнем песочницы', () => {
  withSandbox((sandbox) => {
    const r = decide({ action: write(OUTSIDE), ctx: ctxFor(sandbox) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /вне песочницы/);
    assert.ok(r.reason.includes(sandbox), 'в причине назван корень песочницы');
    assert.ok(!existsSync(OUTSIDE));
  });
});

test('песочница: отказ записан в журнал песочницы', () => {
  withSandbox((sandbox) => {
    decide({ action: write(OUTSIDE), ctx: ctxFor(sandbox) });
    const entries = readJournal(sandbox);
    assert.ok(entries.some((e) => typeof e.reason === 'string' && /вне песочницы/.test(e.reason)),
      'запись отказа в .workflow/logs/rails-denials.jsonl песочницы');
  });
});

test('песочница: роль executor не снимает границу записи', () => {
  withSandbox((sandbox) => {
    const r = decide({ action: write(OUTSIDE), ctx: ctxFor(sandbox, { role: 'executor' }) });
    assert.equal(r.decision, 'deny');
  });
});

test('песочница: смена cwd на другой каталог не снимает границу записи', () => {
  withSandbox((sandbox) => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'rails-sandbox-cwd-'));
    try {
      mkdirSync(join(elsewhere, '.workflow', 'src', 'skills'), { recursive: true });
      const r = decide({ action: write(OUTSIDE), ctx: ctxFor(sandbox, { cwd: elsewhere }) });
      assert.equal(r.decision, 'deny');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test('песочница: запись через ссылку внутри песочницы проверяется по цели ссылки', () => {
  withSandbox((sandbox) => {
    // Цель ссылки — чужая песочница во временном каталоге: вне своей песочницы и под запретом.
    const foreign = mkdtempSync(join(tmpdir(), 'wf-test-foreign-'));
    try {
      const link = join(sandbox, 'link');
      createJunction(foreign, link);
      const r = decide({ action: write(join(link, 'x.md')), ctx: ctxFor(sandbox) });
      assert.equal(r.decision, 'deny');
      assert.match(r.reason, /чужую песочницу/);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });
});

test('песочница: временный каталог ОС вне чужих песочниц разрешён', () => {
  withSandbox((sandbox) => {
    const scratch = mkdtempSync(join(tmpdir(), 'rails-sandbox-scratch-'));
    try {
      const r = decide({ action: write(join(scratch, 'note.txt')), ctx: ctxFor(sandbox) });
      assert.equal(r.decision, 'allow');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

test('песочница: запись в чужую песочницу wf-test-* — отказ', () => {
  withSandbox((sandbox) => {
    const foreign = mkdtempSync(join(tmpdir(), 'wf-test-other-'));
    try {
      const r = decide({ action: write(join(foreign, '.workflow', 'plans', 'current', 'PLAN-001.md')), ctx: ctxFor(sandbox) });
      assert.equal(r.decision, 'deny');
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });
});

test('песочница: shell-перенаправление наружу — отказ', () => {
  withSandbox((sandbox) => {
    const r = decide({ action: bash(`echo x > '${OUTSIDE.replace(/\\/g, '/')}'`), ctx: ctxFor(sandbox) });
    assert.equal(r.decision, 'deny');
  });
});

test('песочница: shell-запись с неопределимым путём — отказ', () => {
  withSandbox((sandbox) => {
    const r = decide({ action: bash('echo x > "$SOME_DIR/f.txt"'), ctx: ctxFor(sandbox) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /путь не удалось определить/);
  });
});

// Ревью 2026-09-24: Kilo bash с относительной записью и workdir настоящего проекта
// проходил — цели разрешались от cwd песочницы, а команда шла в workdir.
test('песочница: Kilo bash — цели записи считаются от workdir, а не от cwd', () => {
  withSandbox((sandbox) => {
    const outsideDir = join(homedir(), `.rails-sandbox-probe-${randomUUID()}`);
    const kilo = (args) => fromKilo({ tool: 'bash' }, { args });
    assert.equal(decide({ action: kilo({ command: 'echo x > PWN.md', workdir: outsideDir }), ctx: ctxFor(sandbox) }).decision, 'deny');
    assert.equal(decide({ action: kilo({ command: 'echo x > ok.md', workdir: join(sandbox, 'sub') }), ctx: ctxFor(sandbox) }).decision, 'allow');
    assert.equal(decide({ action: { ...kilo({ command: 'echo x > f.md' }), workdir: 42 }, ctx: ctxFor(sandbox) }).decision, 'deny');
    assert.ok(!existsSync(outsideDir));
  });
});

// Ревью 2026-09-24: встроенные инструменты Kilo с «_» в имени принимались за MCP-серверы.
test('песочница: Kilo apply_patch — каждый путь патча проверяется, нераспознанный патч — отказ', () => {
  withSandbox((sandbox) => {
    const patch = (text) => fromKilo({ tool: 'apply_patch' }, { args: { patchText: text } });
    const inside = join(sandbox, 'a.md');
    const addOutside = `*** Begin Patch\n*** Add File: ${OUTSIDE}\n+x\n*** End Patch`;
    const moveOutside = `*** Begin Patch\n*** Update File: ${inside}\n*** Move to: ${OUTSIDE}\n@@\n-a\n+b\n*** End Patch`;
    const addInside = `*** Begin Patch\n*** Add File: ${inside}\n+x\n*** End Patch`;
    assert.equal(decide({ action: patch(addOutside), ctx: ctxFor(sandbox) }).decision, 'deny');
    assert.equal(decide({ action: patch(moveOutside), ctx: ctxFor(sandbox) }).decision, 'deny');
    assert.equal(decide({ action: patch(addInside), ctx: ctxFor(sandbox) }).decision, 'allow');
    assert.equal(decide({ action: patch('garbage'), ctx: ctxFor(sandbox) }).decision, 'deny');
  });
});

test('песочница: Kilo background_process — команда проверяется как shell, запуск агентов и отложенных задач запрещён', () => {
  withSandbox((sandbox) => {
    const bg = fromKilo({ tool: 'background_process' }, { args: { action: 'start', command: `echo x > '${OUTSIDE.replace(/\\/g, '/')}'` } });
    assert.equal(bg.kind, 'shell');
    assert.equal(decide({ action: bg, ctx: ctxFor(sandbox) }).decision, 'deny');
    for (const tool of ['agent_manager', 'cron_create', 'schedule_wakeup']) {
      const a = fromKilo({ tool }, { args: {} });
      assert.equal(a.kind, 'other', tool);
      assert.equal(decide({ action: a, ctx: ctxFor(sandbox) }).decision, 'deny', tool);
    }
  });
});

test('песочница: запись в /tmp из Git Bash — это временный каталог ОС, разрешена', { skip: process.platform !== 'win32' }, () => {
  withSandbox((sandbox) => {
    const r = decide({ action: bash('echo x > /tmp/rails-sandbox-probe.txt'), ctx: ctxFor(sandbox) });
    assert.equal(r.decision, 'allow');
  });
});

test('песочница: нет корня — отказ на запись не воссоздаёт корень, shell без записи проходит', () => {
  const missing = join(tmpdir(), `wf-test-missing-${randomUUID()}`);
  const ctx = { cwd: tmpdir(), sessionId: randomUUID(), sandboxRoot: missing };
  assert.equal(decide({ action: write(join(missing, 'x.md')), ctx }).decision, 'deny');
  assert.equal(decide({ action: write(join(missing, 'x.md')), ctx }).decision, 'deny', 'второй вызов тоже отказ');
  assert.ok(!existsSync(missing), 'журнал отказа не создал корень');
  assert.equal(decide({ action: bash('ls'), ctx }).decision, 'allow');
});

// Ревью 2026-09-24, раунд 2.
test('песочница: Kilo bash на Windows без SHELL и конфига — PowerShell (Set-Location, псевдонимы)', { skip: process.platform !== 'win32' }, () => {
  withSandbox((sandbox) => {
    const outsideDir = join(homedir(), `.rails-sandbox-probe-${randomUUID()}`);
    // Kilo без shell в конфиге и без SHELL берёт powershell (kilo.exe; журнал kilo 2026-09-22/24).
    const home = mkdtempSync(join(tmpdir(), 'rails-sandbox-kilo-home-'));
    const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    try {
      delete process.env.SHELL;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const kilo = (command) => fromKilo({ tool: 'bash' }, { args: { command } });
      assert.equal(decide({ action: kilo(`Set-Location ${outsideDir}; Set-Content evil.md hi`), ctx: ctxFor(sandbox) }).decision, 'deny');
      assert.equal(decide({ action: kilo(`ni ${OUTSIDE} -Value hi`), ctx: ctxFor(sandbox) }).decision, 'deny');
      assert.equal(decide({ action: kilo(`Set-Content ${join(sandbox, 'ok.md')} hi`), ctx: ctxFor(sandbox) }).decision, 'allow');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('песочница: создание ссылки в той же команде, что и запись через неё, — отказ', () => {
  withSandbox((sandbox) => {
    const ps = (command) => ({ tool: 'PowerShell', kind: 'shell', command, shell: 'powershell' });
    const r1 = decide({ action: ps('New-Item -ItemType Junction -Path j -Target D:\\x; Set-Content -Path j\\f.md -Value hi'), ctx: ctxFor(sandbox) });
    assert.equal(r1.decision, 'deny');
    assert.match(r1.reason, /ссылок/);
    assert.equal(decide({ action: bash('ln -s /d/x j && echo hi > j/f.md'), ctx: ctxFor(sandbox) }).decision, 'deny');
    assert.equal(decide({ action: bash('cmd //c mklink /J j D:\\x'), ctx: ctxFor(sandbox) }).decision, 'deny');
  });
});

test('песочница: запись в файл с несколькими именами (жёсткая ссылка) — отказ', () => {
  withSandbox((sandbox) => {
    const a = join(sandbox, 'a.txt');
    const b = join(sandbox, 'b.txt');
    writeFileSync(a, 'x');
    linkSync(a, b);
    assert.equal(decide({ action: write(b), ctx: ctxFor(sandbox) }).decision, 'deny');
    assert.equal(decide({ action: write(join(sandbox, 'c.txt')), ctx: ctxFor(sandbox) }).decision, 'allow');
  });
});

test('песочница: workdir Kilo в записи Git Bash (/c/…) разбирается как путь диска', { skip: process.platform !== 'win32' }, () => {
  withSandbox((sandbox) => {
    const msys = sandbox.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
    const kilo = (args) => fromKilo({ tool: 'bash' }, { args });
    assert.equal(decide({ action: kilo({ command: 'echo x > ok.md', workdir: msys }), ctx: ctxFor(sandbox) }).decision, 'allow');
    assert.equal(decide({ action: kilo({ command: 'echo x > f.md', workdir: '/usr/share' }), ctx: ctxFor(sandbox) }).decision, 'deny');
  });
});

test('песочница: background_process restart — команда не видна хуку, отказ; list — не запись', () => {
  withSandbox((sandbox) => {
    const bg = (args) => fromKilo({ tool: 'background_process' }, { args });
    assert.equal(decide({ action: bg({ action: 'restart', id: 'p1' }), ctx: ctxFor(sandbox) }).decision, 'deny');
    assert.equal(decide({ action: bg({ action: 'list' }), ctx: ctxFor(sandbox) }).decision, 'allow');
  });
});

test('песочница: shell без записи разрешён', () => {
  withSandbox((sandbox) => {
    const r = decide({ action: bash('ls -la'), ctx: ctxFor(sandbox) });
    assert.equal(r.decision, 'allow');
  });
});

test('песочница: MCP workflow — меняющие инструменты запрещены, чтение и другие серверы разрешены', () => {
  withSandbox((sandbox) => {
    const mcp = (server, mcpTool) => ({ tool: `mcp__${server}__${mcpTool}`, kind: 'mcp', server, mcpTool });
    assert.equal(decide({ action: mcp('workflow', 'create_ticket'), ctx: ctxFor(sandbox) }).decision, 'deny');
    assert.equal(decide({ action: mcp('workflow', 'move_ticket'), ctx: ctxFor(sandbox) }).decision, 'deny');
    assert.equal(decide({ action: mcp('workflow', 'get_ticket'), ctx: ctxFor(sandbox) }).decision, 'allow');
    assert.equal(decide({ action: mcp('workflow', 'list_plans'), ctx: ctxFor(sandbox) }).decision, 'allow');
    assert.equal(decide({ action: mcp('other', 'create_ticket'), ctx: ctxFor(sandbox) }).decision, 'allow');
  });
});

test('песочница: чтение вне рабочего каталога разрешено', () => {
  withSandbox((sandbox) => {
    const r = decide({ action: { tool: 'Read', kind: 'read' }, ctx: ctxFor(sandbox) });
    assert.equal(r.decision, 'allow');
  });
});

test('песочница: корень, которого нет на диске, — запись запрещена', () => {
  const missing = join(tmpdir(), `wf-test-missing-${randomUUID()}`);
  const r = decide({ action: write(join(missing, 'x.md')), ctx: { cwd: tmpdir(), sessionId: randomUUID(), sandboxRoot: missing } });
  assert.equal(r.decision, 'deny');
});

test('песочница: граница берётся из WORKFLOW_SANDBOX_ROOT окружения', () => {
  withSandbox((sandbox) => {
    const prev = process.env.WORKFLOW_SANDBOX_ROOT;
    process.env.WORKFLOW_SANDBOX_ROOT = sandbox;
    try {
      const r = decide({ action: write(OUTSIDE), ctx: { cwd: sandbox, sessionId: randomUUID() } });
      assert.equal(r.decision, 'deny');
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_SANDBOX_ROOT;
      else process.env.WORKFLOW_SANDBOX_ROOT = prev;
    }
  });
});

test('без песочницы поведение прежнее: запись вне каталога без скила разрешена', () => {
  withSandbox((sandbox) => {
    const prev = process.env.WORKFLOW_SANDBOX_ROOT;
    delete process.env.WORKFLOW_SANDBOX_ROOT;
    try {
      const r = decide({ action: write(OUTSIDE), ctx: { cwd: sandbox, sessionId: randomUUID() } });
      assert.equal(r.decision, 'allow');
    } finally {
      if (prev !== undefined) process.env.WORKFLOW_SANDBOX_ROOT = prev;
    }
  });
});
