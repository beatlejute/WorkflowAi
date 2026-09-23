#!/usr/bin/env node

/**
 * Регресс: временный файл approval-записи, осиротевший после смерти процесса,
 * обязан убираться — но только он.
 *
 * Инцидент: writeApprovalPending пишет JSON во временный файл
 * `.workflow/.approval-tmp.<pid>.<hex>` и публикует его одним link'ом в
 * `.workflow/approvals`. Свой временный файл процесс снимает в finally — если
 * доживает до него. Процесс, убитый между записью и публикацией (kill,
 * перезагрузка, вылет), не снимает ничего, и чистильщика у остатка не было:
 * файл лежал в .workflow вечно. Поведению это не вредит (корень .workflow никто
 * не сканирует), цена — растущая свалка в проекте пользователя.
 *
 * Цена неаккуратной уборки выше цены мусора: в том же каталоге работает другой
 * раннер, его временный файл — это гейт, который сейчас опубликуется. Снести
 * его на лету значит потерять решение человека и оставить пайплайн ждать
 * вечно. Поэтому здесь проверяются обе стороны: остаток мёртвого процесса
 * уходит, файл живого — остаётся.
 *
 * Стенных часов в тесте нет: возраст файла задаётся utimes, живой процесс —
 * настоящий дочерний процесс, дожидается он не сна, а строки «ready».
 *
 * Запуск: node --test src/tests/recovery-approval-tmp-leftovers.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { PipelineRunner } from '../runner.mjs';
import { processAlive } from '../lib/process-alive.mjs';

// Порог возраста в runner.mjs — 5 минут. Тест не сверяется с константой, а
// берёт заведомо больший и заведомо меньший возраст.
const OLD_ENOUGH_MS = 30 * 60 * 1000;

function createTmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-tmp-sweep-'));
  fs.mkdirSync(path.join(root, '.workflow', 'approvals'), { recursive: true });
  return root;
}

function createMinimalRunner(projectRoot, logger = null) {
  const runner = Object.create(PipelineRunner.prototype);
  runner.context = { ticket_id: 'QA-77' };
  runner.counters = { task_attempts: 0 };
  runner.projectRoot = projectRoot;
  runner.running = true;
  runner.logger = logger;
  return runner;
}

const payload = (stepId = 'QA-77_manual-gate-human_0') => ({
  step_id: stepId,
  ticket_id: 'QA-77',
  stage_id: 'manual-gate-human',
  attempt: 0,
  context_snapshot: { ticket_id: 'QA-77' }
});

/**
 * Номер процесса, мёртвость которого подтверждена прямо сейчас, а не выбрана
 * по памяти: кандидаты перебираются, пока проверка не скажет «не жив».
 */
function findDeadPid() {
  for (let pid = 100_001; pid <= 100_999; pid += 2) {
    if (!processAlive(pid)) return pid;
  }
  throw new Error('не удалось найти заведомо мёртвый pid для теста');
}

/** Кладёт временный файл указанного возраста и возвращает путь к нему. */
function plantTmpFile(workflowDir, pid, { ageMs = OLD_ENOUGH_MS, hex = 'a1b2c3d4e5f6' } = {}) {
  const file = path.join(workflowDir, `.approval-tmp.${pid}.${hex}`);
  fs.writeFileSync(file, '{"status":"pending"}', 'utf8');
  const stamp = new Date(Date.now() - ageMs);
  fs.utimesSync(file, stamp, stamp);
  return file;
}

/** Настоящий живой процесс. Готовность — по строке из stdout, а не по паузе. */
async function startLiveProcess() {
  const child = spawn(
    process.execPath,
    ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );

  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`процесс-фикстура вышел с кодом ${code}, не дожив до готовности`)));
  });

  return child;
}

async function stopLiveProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await exited;
}

describe('approval-файл: уборка временных остатков', () => {
  let projectRoot;
  let workflowDir;
  let approvalsDir;
  let filePath;

  beforeEach(() => {
    projectRoot = createTmpProject();
    workflowDir = path.join(projectRoot, '.workflow');
    approvalsDir = path.join(workflowDir, 'approvals');
    filePath = path.join(approvalsDir, 'QA-77_manual-gate-human_0.json');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('остаток умершего процесса убирается при записи следующего approval-файла', async () => {
    const deadPid = findDeadPid();
    const leftover = plantTmpFile(workflowDir, deadPid);

    const runner = createMinimalRunner(projectRoot);
    const result = await runner.writeApprovalPending(filePath, payload());

    assert.strictEqual(
      fs.existsSync(leftover),
      false,
      'остаток умершего прогона обязан уйти: иначе свалка в .workflow растёт с каждым падением'
    );
    assert.strictEqual(result.status, 'pending', 'уборка не должна мешать созданию гейта');
    assert.deepStrictEqual(
      fs.readdirSync(approvalsDir),
      ['QA-77_manual-gate-human_0.json'],
      'в каталоге approvals должен лежать ровно новый гейт'
    );
  });

  it('временный файл живого чужого процесса не трогается', async () => {
    const child = await startLiveProcess();
    try {
      assert.ok(processAlive(child.pid), 'фикстура обязана быть живой к моменту уборки');
      // Возраст заведомо за порогом: файл спасает только проверка владельца.
      const alive = plantTmpFile(workflowDir, child.pid, { hex: 'f00dcafe1234' });

      const runner = createMinimalRunner(projectRoot);
      await runner.writeApprovalPending(filePath, payload());

      assert.ok(
        fs.existsSync(alive),
        'снесённая запись живого процесса — потерянный гейт: пайплайн ждал бы решения вечно'
      );
    } finally {
      await stopLiveProcess(child);
    }
  });

  it('свой временный файл, который пишется прямо сейчас, не сносится', async () => {
    const own = plantTmpFile(workflowDir, process.pid, { hex: '0123456789ab' });

    const runner = createMinimalRunner(projectRoot);
    const removed = await runner.sweepApprovalTmpLeftovers(workflowDir);

    assert.deepStrictEqual(removed, [], 'уборка не имеет права трогать запись собственного процесса');
    assert.ok(fs.existsSync(own), 'свой файл в работе обязан уцелеть');
  });

  it('свежий остаток не сносится: мёртвого pid одного мало', async () => {
    const deadPid = findDeadPid();
    const fresh = plantTmpFile(workflowDir, deadPid, { ageMs: 0 });

    const runner = createMinimalRunner(projectRoot);
    const removed = await runner.sweepApprovalTmpLeftovers(workflowDir);

    assert.deepStrictEqual(removed, [], 'у свежего файла владельца мог не разглядеть только ошибочный ответ проверки');
    assert.ok(
      fs.existsSync(fresh),
      'второй признак (возраст) страхует от чужой таблицы процессов — например, когда проект лежит на сетевой шаре'
    );
  });

  it('посторонние файлы и каталоги в .workflow не трогаются', async () => {
    const deadPid = findDeadPid();
    const keep = [
      ['marker.json', '{}'],
      ['.approval-tmp', 'файл без pid и хвоста'],
      [`.approval-tmp.${deadPid}`, 'имя оборвано на pid'],
      [`.approval-tmp.${deadPid}.a1b2c3d4e5f6.bak`, 'лишний хвост после хвоста'],
      ['.approval-tmp.nopid.a1b2c3d4e5f6', 'вместо pid — не число']
    ];
    for (const [name, body] of keep) {
      const file = path.join(workflowDir, name);
      fs.writeFileSync(file, body, 'utf8');
      const stamp = new Date(Date.now() - OLD_ENOUGH_MS);
      fs.utimesSync(file, stamp, stamp);
    }
    const logsDir = path.join(workflowDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const runner = createMinimalRunner(projectRoot);
    const removed = await runner.sweepApprovalTmpLeftovers(workflowDir);

    assert.deepStrictEqual(removed, [], 'уборка обязана узнавать только своё имя целиком');
    for (const [name] of keep) {
      assert.ok(fs.existsSync(path.join(workflowDir, name)), `файл "${name}" снесён по ошибке`);
    }
    assert.ok(fs.existsSync(logsDir), 'каталоги уборка не трогает');
  });

  it('обход каталога стоит одного readdir на раннера, а не одного на гейт', async () => {
    const runner = createMinimalRunner(projectRoot);
    const originalReaddir = fs.promises.readdir;
    let sweeps = 0;
    fs.promises.readdir = async (dir, ...rest) => {
      if (path.resolve(dir) === path.resolve(workflowDir)) sweeps++;
      return originalReaddir.call(fs.promises, dir, ...rest);
    };

    try {
      await runner.writeApprovalPending(filePath, payload());
      await runner.writeApprovalPending(
        path.join(approvalsDir, 'QA-77_manual-gate-human_1.json'),
        payload('QA-77_manual-gate-human_1')
      );
      assert.strictEqual(sweeps, 1, 'уборка на каждом входе в гейт — плата за мусор из горячего пути');

      // Новый прогон убирает снова: иначе остаток пережил бы любой запуск.
      await createMinimalRunner(projectRoot).writeApprovalPending(
        path.join(approvalsDir, 'QA-77_manual-gate-human_2.json'),
        payload('QA-77_manual-gate-human_2')
      );
      assert.strictEqual(sweeps, 2, 'следующий раннер обязан убрать остатки предыдущего');
    } finally {
      fs.promises.readdir = originalReaddir;
    }
  });

  it('сбой уборки не мешает создать гейт', async () => {
    const runner = createMinimalRunner(projectRoot);
    runner.sweepApprovalTmpLeftovers = async () => {
      throw new Error('каталог недоступен');
    };

    const result = await runner.writeApprovalPending(filePath, payload());

    assert.strictEqual(result.status, 'pending', 'мусор не имеет права уронить создание гейта');
    assert.ok(fs.existsSync(filePath), 'approval-файл обязан появиться даже при неудачной уборке');
  });

  it('снятый файл попадает в журнал прогона, пустая уборка молчит', async () => {
    const messages = [];
    const logger = { info: msg => messages.push(msg), warn: () => {}, error: () => {}, debug: () => {} };
    const deadPid = findDeadPid();
    const leftover = path.basename(plantTmpFile(workflowDir, deadPid));

    await createMinimalRunner(projectRoot, logger).writeApprovalPending(filePath, payload());

    const sweepLines = messages.filter(m => m.includes(leftover));
    assert.strictEqual(sweepLines.length, 1, 'без записи в журнале не понять, кто снёс файл: уборщик или человек');

    messages.length = 0;
    await createMinimalRunner(projectRoot, logger).writeApprovalPending(
      path.join(approvalsDir, 'QA-77_manual-gate-human_1.json'),
      payload('QA-77_manual-gate-human_1')
    );
    assert.deepStrictEqual(
      messages.filter(m => m.includes('approval: убраны')),
      [],
      'строка «убрано 0» в каждом логе — шум, а не след'
    );
  });
});

describe('уборка не роняет уже опубликованный гейт', () => {
  let projectRoot, workflowDir, approvalsDir, filePath;

  beforeEach(() => {
    projectRoot = createTmpProject();
    workflowDir = path.join(projectRoot, '.workflow');
    approvalsDir = path.join(workflowDir, 'approvals');
    filePath = path.join(approvalsDir, 'QA-77_manual-gate-human_0.json');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('падение записи в журнал не отменяет созданный approval-файл', async () => {
    // Журнал пишется синхронно и падает на кончившемся месте и на правах.
    // Уборка зовётся из finally уже ПОСЛЕ публикации файла: бросок отсюда
    // означал бы, что человек нажал approve, гейт на диске есть, а пайплайн
    // получил ошибку из-за строчки об уборке мусора.
    const brokenLogger = {
      info: () => { throw new Error('ENOSPC: no space left on device, write'); },
      warn: () => {}, error: () => {}, debug: () => {}
    };
    const leftover = plantTmpFile(workflowDir, findDeadPid());

    const result = await createMinimalRunner(projectRoot, brokenLogger).writeApprovalPending(filePath, payload());

    assert.strictEqual(result.status, 'pending', 'гейт создан — падение журнала его не отменяет');
    assert.ok(fs.existsSync(filePath), 'approval-файл обязан остаться на диске');
    assert.ok(!fs.existsSync(leftover), 'уборка при этом отработала');
  });
});
