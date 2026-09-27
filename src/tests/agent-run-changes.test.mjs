/**
 * Подсчёт изменённых файлов за запуск агента (src/lib/agent-run-changes.mjs, PLAN-003,
 * задача 6) — captureRunChanges / countRunChanges (задача 7).
 *
 * Что охраняется:
 *  - в git-проекте правка только `tests/x.test.ts` или только файла тикета (в
 *    игнорируемом `.workflow/`) даёт `changed_files >= 1`; без правок — `0`;
 *  - в проекте без git (`git init` не делался) правка файла тоже считается — снимок
 *    идёт по обходу каталога;
 *  - запись в `.workflow/metrics/` и `.workflow/state/` не считается изменением, даже
 *    если сам git их не игнорирует (правило — в модуле, не в `.gitignore` проекта);
 *  - коммит, сделанный во время запуска (файл правится и коммитится агентом), тоже
 *    засчитывается — через diff между `HEAD` снимков `до` и `после`.
 *
 * Временный git-репозиторий — каталог ОС, `git init` с локальными (не глобальными)
 * user.name/user.email, чтобы коммит не зависел от настроек машины. Корень — новый
 * на каждый тест, удаляется в afterEach.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-run-changes.test.mjs
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { captureRunChanges, countRunChanges } from '../lib/agent-run-changes.mjs';

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-changes-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function initGitRepo(dir, { ignoreWorkflow = true } = {}) {
  git(dir, ['init', '-q']);
  // Локально, не --global: коммит не должен зависеть от настроек машины,
  // на которой запускается тест.
  git(dir, ['config', 'user.email', 'agent-run-changes-test@example.invalid']);
  git(dir, ['config', 'user.name', 'agent-run-changes-test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  if (ignoreWorkflow) {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.workflow/\n');
  }
}

function writeFile(dir, relPath, content) {
  const file = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

function ticketFile(dir) {
  return path.join(dir, '.workflow', 'tickets', 'in-progress', 'IMPL-1.md');
}

test('git-проект: правка только tests/x.test.ts даёт changed_files >= 1', () => {
  initGitRepo(root);
  writeFile(root, 'tests/x.test.ts', 'test v1\n');
  writeFile(root, 'src/app.js', 'v1\n');
  commitAll(root, 'init');

  const before = captureRunChanges(root, null);
  assert.ok(before, 'снимок должен сняться в git-проекте');
  assert.equal(before.mode, 'git');

  writeFile(root, 'tests/x.test.ts', 'test v2\n');

  const count = countRunChanges(root, before, null);
  assert.equal(count, 1, 'изменён ровно один файл проекта');
});

test('git-проект: правка только файла тикета в игнорируемом .workflow/ даёт changed_files >= 1', () => {
  initGitRepo(root);
  writeFile(root, 'src/app.js', 'v1\n');
  commitAll(root, 'init');
  const ticket = ticketFile(root);
  writeFile(root, path.relative(root, ticket), '---\nid: IMPL-1\n---\n# v1\n');

  const before = captureRunChanges(root, ticket);
  assert.equal(before.mode, 'git');
  assert.deepEqual(before.ticket, { key: '.workflow/tickets/in-progress/IMPL-1.md', fingerprint: before.ticket.fingerprint });

  fs.writeFileSync(ticket, '---\nid: IMPL-1\n---\n# v2, правка агента\n', 'utf8');

  const count = countRunChanges(root, before, ticket);
  assert.equal(count, 1, 'единственная правка — файл тикета, который git не видит из-за .gitignore');
});

test('git-проект: ничего не изменилось — changed_files 0', () => {
  initGitRepo(root);
  writeFile(root, 'src/app.js', 'v1\n');
  commitAll(root, 'init');
  const ticket = ticketFile(root);
  writeFile(root, path.relative(root, ticket), '---\nid: IMPL-1\n---\n# v1\n');

  const before = captureRunChanges(root, ticket);
  const count = countRunChanges(root, before, ticket);
  assert.equal(count, 0);
});

test('проект без git: правка файла считается, .tmp — нет', () => {
  writeFile(root, 'notes.txt', 'v1\n');

  const before = captureRunChanges(root, null);
  assert.ok(before, 'снимок обходом каталога должен сняться без git');
  assert.equal(before.mode, 'walk');

  writeFile(root, 'notes.txt', 'v2\n');
  assert.equal(countRunChanges(root, before, null), 1);

  // Второй агент вдобавок оставил временный файл — он вне области подсчёта.
  writeFile(root, 'scratch.tmp', 'мусор\n');
  assert.equal(countRunChanges(root, before, null), 1, '*.tmp не входит в область подсчёта без git');
});

test('запись в .workflow/metrics/ и .workflow/state/ не считается, даже если git их не игнорирует', () => {
  // Без .gitignore на .workflow/: git должен сам увидеть эти файлы как untracked —
  // проверка ниже подтверждает это, чтобы тест не проходил случайно.
  initGitRepo(root, { ignoreWorkflow: false });
  writeFile(root, 'src/app.js', 'v1\n');
  commitAll(root, 'init');

  const before = captureRunChanges(root, null);
  assert.equal(before.mode, 'git');

  writeFile(root, '.workflow/metrics/agent-runs.jsonl', '{"type":"run"}\n');
  writeFile(root, '.workflow/state/agent-run-open.json', '{}\n');

  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  assert.match(status, /\.workflow\/metrics\/agent-runs\.jsonl/, 'git должен видеть эти файлы untracked — иначе тест ничего не проверяет');
  assert.match(status, /\.workflow\/state\/agent-run-open\.json/);

  assert.equal(countRunChanges(root, before, null), 0, 'файлы раннера исключены модулем, а не .gitignore');
});

test('коммит во время запуска засчитывается через diff HEAD-снимков', () => {
  initGitRepo(root);
  writeFile(root, 'src/app.js', 'v1\n');
  commitAll(root, 'init');

  const before = captureRunChanges(root, null);
  assert.ok(before.head, 'до запуска должен быть HEAD');

  writeFile(root, 'src/app.js', 'v2, правка агента\n');
  commitAll(root, 'agent commit');

  // Рабочее дерево после коммита чистое — если бы подсчёт смотрел только на
  // git status, правка осталась бы незамеченной.
  assert.equal(git(root, ['status', '--porcelain=v1']).trim(), '');

  const count = countRunChanges(root, before, null);
  assert.equal(count, 1, 'файл, изменённый закоммиченной за время запуска правкой, засчитан');
});

test('измерение длительности capture+count на дереве из нескольких сотен файлов (риск «медленный подсчёт»)', (t) => {
  // Без git: снимок идёт полным обходом каталога — это и есть путь, для
  // которого план называет риск «подсчёт изменённых файлов медленный на
  // большом репозитории».
  const FILE_COUNT = 400;
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFile(root, `pkg/dir${i % 20}/file${i}.txt`, `содержимое ${i}\n`);
  }

  const t0 = Date.now();
  const before = captureRunChanges(root, null);
  const t1 = Date.now();
  assert.equal(before.mode, 'walk');

  writeFile(root, 'pkg/dir0/file0.txt', 'изменено агентом\n');

  const t2 = Date.now();
  const count = countRunChanges(root, before, null);
  const t3 = Date.now();

  assert.equal(count, 1);
  t.diagnostic(`agent-run-changes: capture=${t1 - t0}ms count=${t3 - t2}ms файлов=${FILE_COUNT}`);
});
