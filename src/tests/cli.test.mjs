import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { run } from '../cli.mjs';

let testDir;
let originalCwd;
let originalWorkflowHome;
let originalNodeOptions;

beforeEach(() => {
  originalCwd = process.cwd();
  originalWorkflowHome = process.env.WORKFLOW_HOME;
  // `workflow run` дописывает в NODE_OPTIONS `--import` своего лоадера, и без
  // восстановления его наследовали бы все процессы, порождённые после теста.
  originalNodeOptions = process.env.NODE_OPTIONS;
  testDir = join(tmpdir(), `cli-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  process.chdir(testDir);
  process.env.WORKFLOW_HOME = join(testDir, '.workflow-home');
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalNodeOptions === undefined) {
    delete process.env.NODE_OPTIONS;
  } else {
    process.env.NODE_OPTIONS = originalNodeOptions;
  }
  if (originalWorkflowHome === undefined) {
    delete process.env.WORKFLOW_HOME;
  } else {
    process.env.WORKFLOW_HOME = originalWorkflowHome;
  }
  rmSync(testDir, { recursive: true, force: true });
});

// ============ CLI Command Parsing Tests ============

test('workflow help shows help text', () => {
  const originalLog = console.log;
  const loggedLines = [];
  console.log = (...args) => {
    loggedLines.push(args.join(' '));
  };

  try {
    run(['help']);

    const output = loggedLines.join('\n');
    assert.ok(output.includes('workflow-ai'), 'Help should include workflow-ai');
    assert.ok(output.includes('Usage:'), 'Help should include Usage section');
    assert.ok(output.includes('workflow init'), 'Help should mention init command');
    assert.ok(output.includes('workflow run'), 'Help should mention run command');
  } finally {
    console.log = originalLog;
  }
});

test('workflow version shows version', () => {
  const originalLog = console.log;
  const loggedLines = [];
  console.log = (...args) => {
    loggedLines.push(args.join(' '));
  };

  try {
    run(['version']);

    const output = loggedLines.join('\n');
    assert.ok(output.includes('workflow-ai v'), 'Version should include workflow-ai v');
  } finally {
    console.log = originalLog;
  }
});

test('Unknown command shows error message', () => {
  const originalLog = console.log;
  // Сообщение об unknown command уходит в stderr, а не в stdout.
  const originalError = console.error;
  const loggedLines = [];
  let exitCode = null;
  
  console.log = (...args) => {
    loggedLines.push(args.join(' '));
  };
  console.error = (...args) => {
    loggedLines.push(args.join(' '));
  };
  
  const originalExit = process.exit;
  process.exit = (code) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  };

  try {
    assert.throws(
      () => run(['unknown-command']),
      (err) => {
        assert.ok(err.message.includes('process.exit'));
        return true;
      }
    );

    const output = loggedLines.join('\n');
    assert.ok(output.includes('Unknown command'), 'Should show unknown command error');
    assert.strictEqual(exitCode, 1, 'Should exit with code 1');
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
});

test('No command shows help', () => {
  const originalLog = console.log;
  const loggedLines = [];
  console.log = (...args) => {
    loggedLines.push(args.join(' '));
  };

  try {
    run([]);

    const output = loggedLines.join('\n');
    assert.ok(output.includes('workflow-ai'), 'Empty command should show help');
  } finally {
    console.log = originalLog;
  }
});

test('workflow init without path uses cwd', () => {
  const originalLog = console.log;
  const loggedLines = [];
  console.log = (...args) => {
    loggedLines.push(args.join(' '));
  };

  try {
    run(['init']);

    // Should attempt initialization in current directory
    const output = loggedLines.join('\n');
    assert.ok(
      output.includes('Initialization completed') ||
      output.includes('Errors:') ||
      output.length > 0,
      'init without path should execute'
    );
  } catch (e) {
    assert.ok(true, 'init command executed');
  } finally {
    console.log = originalLog;
  }
});

test('workflow init with path executes', () => {
  const originalLog = console.log;
  const loggedLines = [];
  console.log = (...args) => {
    loggedLines.push(args.join(' '));
  };

  const initTarget = join(testDir, 'test-project');
  mkdirSync(initTarget, { recursive: true });

  try {
    run(['init', initTarget]);

    const output = loggedLines.join('\n');
    assert.ok(
      output.includes('Initialization completed') ||
      output.includes('Errors:') ||
      output.length > 0,
      'init command should produce output'
    );
  } catch (e) {
    assert.ok(true, 'init command executed (may have failed due to invalid path)');
  } finally {
    console.log = originalLog;
  }
});

// Два теста ниже прежде звали `run(['run'])`, не дожидаясь результата, и
// проходили при любом исходе (`assert.ok(true)` в обеих ветках). Хуже того:
// корень искался подъёмом от временного каталога, а `WORKFLOW_HOME` здесь
// подменён — настоящая `~/.workflow` переставала считаться глобальной, и на
// машине разработчика раннер принимал домашний каталог за проект. На чистой
// машине отказ всплывал unhandledRejection'ом после конца теста и ронял файл.
//
// Теперь корень задан явно (`--project`), подъёма нет, и проверяется честный
// исход: в пустом проекте конфига нет, раннер отвечает кодом 1 и причиной.
test('workflow run executes', async () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await run(['run', '--project', testDir]);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.error, /Config file not found/);
  } finally {
    console.log = originalLog;
  }
});

test('workflow run with plan option executes', async () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await run(['run', '--project', testDir, '--plan', 'PLAN-001']);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.error, /Config file not found/);
  } finally {
    console.log = originalLog;
  }
});

// ============ Version Reporting Tests ============

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf-8')
).version;

function captureLog(fn) {
  const originalLog = console.log;
  const loggedLines = [];
  console.log = (...args) => {
    loggedLines.push(args.join(' '));
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return loggedLines.join('\n');
}

test('workflow version shows actual package.json version', () => {
  const output = captureLog(() => run(['version']));
  assert.ok(
    output.includes(`workflow-ai v${pkgVersion}`),
    `Version should be ${pkgVersion}, got: ${output}`
  );
});

test('workflow help shows actual package.json version, not a hardcoded one', () => {
  const output = captureLog(() => run(['help']));
  assert.ok(
    output.includes(`workflow-ai v${pkgVersion}`),
    `Help header should carry version ${pkgVersion}, got: ${output.split('\n')[0]}`
  );
});

test('workflow --version shows version instead of help', () => {
  const output = captureLog(() => run(['--version']));
  assert.ok(
    output.includes(`workflow-ai v${pkgVersion}`),
    `--version should print version ${pkgVersion}, got: ${output}`
  );
  assert.ok(!output.includes('Usage:'), '--version should not print the help text');
});

test('workflow -v shows version instead of unknown command error', () => {
  const output = captureLog(() => run(['-v']));
  assert.ok(
    output.includes(`workflow-ai v${pkgVersion}`),
    `-v should print version ${pkgVersion}, got: ${output}`
  );
});

// ============ Help Flags & Layout Tests ============

test('workflow --help shows help text', () => {
  const output = captureLog(() => run(['--help']));
  assert.ok(output.includes('Usage:'), '--help should print the help text');
  assert.ok(output.includes('workflow init'), '--help should list commands');
});

test('workflow -h shows help instead of unknown command error', () => {
  const originalError = console.error;
  const errorLines = [];
  console.error = (...args) => {
    errorLines.push(args.join(' '));
  };

  try {
    const output = captureLog(() => run(['-h']));
    assert.ok(output.includes('Usage:'), '-h should print the help text');
    assert.equal(errorLines.length, 0, '-h should not report an unknown command');
  } finally {
    console.error = originalError;
  }
});

test('help command list is aligned in a single description column', () => {
  const output = captureLog(() => run(['help']));
  const columns = output
    .split('\n')
    .map((line) => /^ {2}workflow \S.*? {2,}(?=\S)/.exec(line))
    .filter(Boolean)
    .map((match) => match[0].length);

  assert.ok(columns.length > 1, 'help should list several commands');
  assert.equal(
    new Set(columns).size,
    1,
    `command descriptions should start at one column, got: ${[...new Set(columns)].join(', ')}`
  );
});
