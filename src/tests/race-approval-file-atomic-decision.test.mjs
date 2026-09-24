#!/usr/bin/env node

/**
 * Регресс: решение вписывается в approval-файл целиком, а не через пустой файл.
 *
 * Инцидент QA-37-003 закрыли со стороны СОЗДАНИЯ гейта (writeApprovalPending,
 * см. src/tests/race-approval-file-atomic-create.test.mjs). Источник окна при
 * этом остался: решение «pending → approved» вписывали прямой записью поверх
 * уже существующего файла, а она сначала обрезает его до нуля. Раннер об этом
 * знал и лечил симптом на стороне чтения — readApprovalFile перечитывает файл
 * при SyntaxError дважды с паузами 25 и 50 мс, и в комментарии там прямо названы
 * updateApprovalFilesHook и approveOpenGates. Не успели ретраи (диск под
 * нагрузкой, антивирус, пауза GC) — «corrupt approval file», и стадия уходит в
 * goto.error ровно в тот момент, когда человек нажал approve.
 *
 * Тест не измеряет время: наблюдатель встаёт вместо методов fs и после каждой
 * мутации читает approval-файл так же, как его читает раннер.
 *
 * Запуск: node --test src/tests/race-approval-file-atomic-decision.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { watchFsMutations, inspectApprovalArtifact, listRaw } from './_atomic-publish-observer.mjs';
import { approvalTempPath } from '../lib/utils.mjs';
import { updateApprovalFilesHook } from '../scripts/move-ticket-core.js';
import { approveOpenGates } from '../lib/operations/tickets.mjs';

const TICKET_ID = 'QA-37';
const GATE_FILE = `${TICKET_ID}_manual-gate-human_003.json`;

// Шаблон, которым хук и approveOpenGates отбирают файлы гейтов.
const HOOK_PATTERN = new RegExp(`^${TICKET_ID}_manual-gate-.*_\\d+\\.json$`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, '../runner.mjs');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-decision-'));
  const workflowDir = path.join(root, '.workflow');
  const approvalsDir = path.join(workflowDir, 'approvals');
  fs.mkdirSync(approvalsDir, { recursive: true });

  const filePath = path.join(approvalsDir, GATE_FILE);
  fs.writeFileSync(filePath, JSON.stringify({
    step_id: GATE_FILE.replace('.json', ''),
    ticket_id: TICKET_ID,
    stage_id: 'manual-gate-human',
    attempt: 3,
    status: 'pending',
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
    decided_by: null,
    comment: null,
    context_snapshot: { note: 'снимок контекста должен уцелеть' },
  }, null, 2), 'utf8');

  return { root, workflowDir, approvalsDir, filePath };
}

/** Снимок глазами раннера: файл либо целый JSON, либо его нет. */
function makeInspector(approvalsDir, filePath) {
  return (label) => {
    const violations = inspectApprovalArtifact(filePath, label);
    for (const entry of listRaw(approvalsDir)) {
      if (entry !== GATE_FILE && HOOK_PATTERN.test(entry)) {
        violations.push(`${label}: в каталоге approvals виден посторонний файл "${entry}" — его примут за гейт`);
      }
    }
    return violations;
  };
}

describe('решение по гейту: читателю виден либо прежний файл, либо принятое решение', () => {
  it('хук CLI (move-ticket-core.js) не показывает approval-файл битым', () => {
    const project = makeProject();
    const observer = watchFsMutations(makeInspector(project.approvalsDir, project.filePath));

    try {
      updateApprovalFilesHook(TICKET_ID, 'in-progress', fs, project.workflowDir);
    } finally {
      observer.restore();
    }

    try {
      assert.ok(observer.mutations > 0, 'наблюдатель не увидел ни одной мутации — тест ничего не проверил');
      assert.deepEqual(observer.violations, [], observer.violations.join('\n'));

      const decided = JSON.parse(fs.readFileSync(project.filePath, 'utf8'));
      assert.equal(decided.status, 'approved', 'гейт должен быть закрыт хуком');
      assert.equal(decided.decided_by, 'move-ticket');
      assert.equal(decided.context_snapshot.note, 'снимок контекста должен уцелеть');

      assert.deepEqual(listRaw(project.approvalsDir), [GATE_FILE], 'каталог approvals должен остаться чистым');
      const leftovers = listRaw(project.workflowDir).filter(f => f.startsWith('.approval-tmp.'));
      assert.deepEqual(leftovers, [], `остались временные файлы: ${leftovers.join(', ')}`);
    } finally {
      fs.rmSync(project.root, { recursive: true, force: true });
    }
  });

  it('путь MCP (approveOpenGates) не показывает approval-файл битым', async () => {
    const project = makeProject();
    const observer = watchFsMutations(makeInspector(project.approvalsDir, project.filePath));

    let approved;
    try {
      approved = await approveOpenGates(project.root, TICKET_ID, 'review');
    } finally {
      observer.restore();
    }

    try {
      assert.deepEqual(approved, [GATE_FILE], 'гейт должен быть закрыт');
      assert.ok(observer.mutations > 0, 'наблюдатель не увидел ни одной мутации — тест ничего не проверил');
      assert.deepEqual(observer.violations, [], observer.violations.join('\n'));

      const decided = JSON.parse(fs.readFileSync(project.filePath, 'utf8'));
      assert.equal(decided.status, 'approved');
      assert.equal(decided.context_snapshot.note, 'снимок контекста должен уцелеть');

      assert.deepEqual(listRaw(project.approvalsDir), [GATE_FILE], 'каталог approvals должен остаться чистым');
      const leftovers = listRaw(project.workflowDir).filter(f => f.startsWith('.approval-tmp.'));
      assert.deepEqual(leftovers, [], `остались временные файлы: ${leftovers.join(', ')}`);
    } finally {
      fs.rmSync(project.root, { recursive: true, force: true });
    }
  });

  it('имя временного файла остаётся под уборщиком остатков из runner.mjs', () => {
    // Процесс может умереть между записью временного файла и его публикацией.
    // Свой остаток убирает finally, чужой — уборщик умерших прогонов в
    // src/runner.mjs. Он отбирает файлы по шаблону, и если имя здесь разойдётся
    // с шаблоном там, мусор перестанет убираться, и никто этого не заметит.
    const SWEEPER_PATTERN = /^\.approval-tmp\.(\d+)\.[0-9a-f]+$/;
    const name = path.basename(approvalTempPath(path.join(os.tmpdir(), '.workflow')));

    assert.match(name, SWEEPER_PATTERN, `имя "${name}" уборщик из runner.mjs не подберёт`);
    assert.equal(Number(SWEEPER_PATTERN.exec(name)[1]), process.pid, 'в имени должен быть pid владельца');

    const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');
    assert.ok(
      runnerSource.includes(String(SWEEPER_PATTERN)),
      'шаблон уборщика в runner.mjs разошёлся с именем, которое даёт approvalTempPath: ' +
      'остатки умерших прогонов перестанут убираться'
    );

    // Временный файл лежит в .workflow, а не в approvals: каталог гейтов обязан
    // остаться таким, чтобы readdirSync(approvals)[0] всегда давал гейт.
    assert.ok(!HOOK_PATTERN.test(name), `имя "${name}" примут за гейт`);
  });
});

describe('ни один пишущий путь не возвращает прямую запись поверх approval-файла', () => {
  const SITES = [
    {
      file: path.resolve(__dirname, '../scripts/move-ticket-core.js'),
      forbidden: 'fsModule.writeFileSync(filePath',
      required: 'replaceFileAtomicSync(filePath',
    },
    {
      file: path.resolve(__dirname, '../lib/operations/tickets.mjs'),
      forbidden: 'fs.writeFile(filePath',
      required: 'replaceFileAtomic(filePath',
    },
  ];

  for (const site of SITES) {
    it(`${path.basename(site.file)} пишет решение через общий помощник`, () => {
      const source = fs.readFileSync(site.file, 'utf8');
      assert.ok(
        !source.includes(site.forbidden),
        `${path.basename(site.file)}: вернулась прямая запись "${site.forbidden}" — она обрезает ` +
        'approval-файл до нуля, и раннер уводит стадию в goto.error по «corrupt approval file»'
      );
      assert.ok(source.includes(site.required), `${path.basename(site.file)}: нет "${site.required}"`);
    });
  }
});
