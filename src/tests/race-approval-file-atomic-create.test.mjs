#!/usr/bin/env node

/**
 * Регресс: создание approval-файла обязано быть атомарным для читателей.
 *
 * Инцидент: writeApprovalPending создавал файл через open(filePath, 'wx') и
 * только потом писал в него JSON. В промежутке файл лежал в каталоге approvals
 * нулевой длины, и любой читатель получал пустую строку вместо решения:
 *   • раннер в polling-цикле падал в goto.error по «corrupt approval file»
 *     (так в реальном прогоне набора упал QA-37-003);
 *   • хук move-ticket молча пропускал auto-approve уже принятого решения —
 *     тикет уехал в review, а гейт остался ждать вечно.
 *
 * Тест не измеряет время: он проверяет инвариант в каждой точке, где
 * writeApprovalPending трогает файловую систему. Наблюдатель подставляется
 * вместо методов fs.promises и после каждой мутации делает синхронный снимок
 * каталога. Инвариант: читатель видит либо отсутствие файла, либо целый JSON, и
 * ни в один момент не видит в каталоге approvals ничего кроме самого
 * approval-файла (временный файл не должен попадать под сканирование каталога).
 *
 * Запуск: node --test src/tests/race-approval-file-atomic-create.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PipelineRunner } from '../runner.mjs';

// Шаблон, по которому хук move-ticket (src/scripts/move-ticket.js) и
// approveOpenGates (src/lib/operations/tickets.mjs) отбирают файлы гейтов.
const HOOK_PATTERN = /^QA-77_manual-gate-human_0\.json$/;

// Методы fs, которыми создаётся approval-файл. Наблюдатель оборачивает их все,
// чтобы тест не зависел от того, каким именно способом реализована запись.
const WATCHED_FS_METHODS = ['mkdir', 'writeFile', 'open', 'link', 'rename', 'unlink'];

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'approval-atomic-'));
}

function createMinimalRunner(tmpDir) {
  const runner = Object.create(PipelineRunner.prototype);
  runner.context = { ticket_id: 'QA-77' };
  runner.counters = { task_attempts: 0 };
  runner.projectRoot = tmpDir;
  runner.running = true;
  runner.logger = null;
  return runner;
}

/**
 * Снимок каталога approvals глазами постороннего читателя.
 * Возвращает список нарушений инварианта (пустой — инвариант держится).
 */
function inspectAsReader(approvalsDir, filePath, label) {
  const violations = [];
  const expectedName = path.basename(filePath);

  let entries = [];
  try {
    entries = fs.readdirSync(approvalsDir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      violations.push(`${label}: каталог approvals не читается (${err.code})`);
    }
    return violations;
  }

  for (const entry of entries) {
    if (entry !== expectedName) {
      violations.push(`${label}: в каталоге approvals виден посторонний файл "${entry}"`);
    }
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      violations.push(`${label}: approval-файл есть, но не читается (${err.code})`);
    }
    return violations;
  }

  try {
    const data = JSON.parse(content);
    if (!data.status) {
      violations.push(`${label}: JSON разобран, но без поля status`);
    }
  } catch (err) {
    violations.push(
      `${label}: читатель получил незавершённый файл (${content.length} байт): ${err.message}`
    );
  }

  return violations;
}

/**
 * Подменяет методы fs.promises: после каждой мутации делает снимок каталога.
 * Нарушения копятся в массиве, а не бросаются исключением — исключение из
 * подменённого метода ушло бы в саму writeApprovalPending и было бы там
 * обработано как ошибка записи, то есть тест обвинил бы не то место.
 */
function watchFsMutations(approvalsDir, filePath) {
  const violations = [];
  const checkpoints = [];
  const originals = new Map();

  for (const name of WATCHED_FS_METHODS) {
    const original = fs.promises[name];
    originals.set(name, original);
    fs.promises[name] = async (...args) => {
      const result = await original.apply(fs.promises, args);
      checkpoints.push(name);
      violations.push(...inspectAsReader(approvalsDir, filePath, `после fs.${name}`));
      return result;
    };
  }

  return {
    violations,
    checkpoints,
    restore() {
      for (const [name, original] of originals) {
        fs.promises[name] = original;
      }
    }
  };
}

describe('approval-файл: атомарное создание', () => {
  let tmpDir;
  let approvalsDir;
  let filePath;

  beforeEach(() => {
    tmpDir = createTmpDir();
    approvalsDir = path.join(tmpDir, '.workflow', 'approvals');
    filePath = path.join(approvalsDir, 'QA-77_manual-gate-human_0.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const payload = () => ({
    step_id: 'QA-77_manual-gate-human_0',
    ticket_id: 'QA-77',
    stage_id: 'manual-gate-human',
    attempt: 0,
    context_snapshot: { ticket_id: 'QA-77' }
  });

  it('читатель ни в одной точке записи не видит пустой или обрезанный файл', async () => {
    const runner = createMinimalRunner(tmpDir);
    const watcher = watchFsMutations(approvalsDir, filePath);

    let result;
    try {
      result = await runner.writeApprovalPending(filePath, payload());
    } finally {
      watcher.restore();
    }

    assert.ok(watcher.checkpoints.length > 0, 'наблюдатель обязан увидеть хотя бы одну мутацию fs');
    assert.deepStrictEqual(
      watcher.violations,
      [],
      `инвариант «нет файла или целый JSON» нарушен:\n${watcher.violations.join('\n')}`
    );

    assert.strictEqual(result.status, 'pending');
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(onDisk.status, 'pending', 'на диске должен лежать разбираемый pending');
    assert.strictEqual(onDisk.step_id, 'QA-77_manual-gate-human_0');
  });

  it('временный файл не попадает под сканирование каталога approvals', async () => {
    const runner = createMinimalRunner(tmpDir);
    const seen = new Set();

    const originalLink = fs.promises.link;
    const originalWriteFile = fs.promises.writeFile;
    // Снимок берётся в самый опасный момент — когда временный файл уже есть,
    // а approval-файла ещё нет.
    const snapshot = () => {
      try {
        for (const entry of fs.readdirSync(approvalsDir)) seen.add(entry);
      } catch { /* каталога ещё нет — сканировать нечего */ }
    };

    fs.promises.writeFile = async (...args) => {
      const r = await originalWriteFile.apply(fs.promises, args);
      snapshot();
      return r;
    };
    fs.promises.link = async (...args) => {
      snapshot();
      return originalLink.apply(fs.promises, args);
    };

    try {
      await runner.writeApprovalPending(filePath, payload());
    } finally {
      fs.promises.link = originalLink;
      fs.promises.writeFile = originalWriteFile;
    }

    for (const entry of seen) {
      assert.ok(
        HOOK_PATTERN.test(entry),
        `в каталоге approvals засветился файл "${entry}": хук move-ticket или readdir в тестах примет его за гейт`
      );
    }

    // После успешной публикации в каталоге ровно один файл — тесты берут
    // readdirSync(approvals)[0] и обязаны получить именно approval-файл.
    assert.deepStrictEqual(fs.readdirSync(approvalsDir), ['QA-77_manual-gate-human_0.json']);

    // И ни одного забытого временного файла рядом.
    const leftovers = fs.readdirSync(path.join(tmpDir, '.workflow'))
      .filter(name => name.startsWith('.approval-tmp'));
    assert.deepStrictEqual(leftovers, [], 'временные файлы не должны оставаться после записи');
  });

  it('готовое решение не затирается повторным входом на стейдж', async () => {
    const runner = createMinimalRunner(tmpDir);

    await runner.writeApprovalPending(filePath, payload());

    const decided = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    decided.status = 'approved';
    decided.decided_by = 'human';
    decided.comment = 'ok';
    fs.writeFileSync(filePath, JSON.stringify(decided, null, 2), 'utf8');
    const before = fs.readFileSync(filePath, 'utf8');

    const result = await runner.writeApprovalPending(filePath, payload());

    assert.strictEqual(
      fs.readFileSync(filePath, 'utf8'),
      before,
      'публикация файла должна падать с EEXIST, а не перезаписывать чужое решение'
    );
    assert.strictEqual(result.status, 'approved', 'вернуться должно уже принятое решение');
    assert.strictEqual(result.decided_by, 'human');
  });
});

describe('approval-файл: чтение во время перезаписи решения', () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = createTmpDir();
    filePath = path.join(tmpDir, 'QA-77_manual-gate-human_0.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('обрезанное чтение перечитывается, а не объявляется битым файлом', async () => {
    const runner = createMinimalRunner(tmpDir);
    const whole = JSON.stringify({ status: 'approved', decided_by: 'move-ticket' }, null, 2);
    fs.writeFileSync(filePath, whole, 'utf8');

    // Хук move-ticket вписывает решение через writeFile поверх файла, а он
    // сначала обрезает его до нуля. Имитируем попадание читателя в это окно:
    // первое чтение возвращает пустую строку, дальше файл уже целый.
    const originalReadFile = fs.promises.readFile;
    let reads = 0;
    fs.promises.readFile = async (...args) => {
      reads++;
      if (reads === 1) return '';
      return originalReadFile.apply(fs.promises, args);
    };

    let result;
    try {
      result = await runner.readApprovalFile(filePath);
    } finally {
      fs.promises.readFile = originalReadFile;
    }

    assert.ok(reads > 1, 'после пустого чтения обязан быть повтор');
    assert.strictEqual(result.status, 'approved', 'решение человека не должно теряться');
  });

  it('по-настоящему битый файл остаётся ошибкой после повторов', async () => {
    const runner = createMinimalRunner(tmpDir);
    fs.writeFileSync(filePath, '{ не json', 'utf8');

    await assert.rejects(
      () => runner.readApprovalFile(filePath),
      err => err.message.includes('corrupt approval file at') && err.message.includes(filePath)
    );
  });
});
