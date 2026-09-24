/**
 * Стоимость approval-хука при перемещении тикета (боевая функция из
 * src/scripts/move-ticket-core.js, её же зовёт move-ticket.js).
 *
 * Инцидент: раньше здесь стоял бюджет «p95 ≤ 50 мс за 100 итераций» и рукописная
 * копия хука. Копия не ловила регресс в боевом коде, а бюджет по стенным часам
 * падал в полном наборе — под десятком воркеров, которые одновременно молотят
 * диск, — и был зелёным в изоляции. Цена: красный CI, который никто не считал
 * настоящим, и незамеченный регресс в хуке.
 *
 * Здесь считается то, что от загрузки машины не зависит: число обращений к диску.
 * Хук обязан стоить фиксированные 5 операций независимо от того, сколько чужих
 * approval-файлов лежит в каталоге. Часы остались в src/tests/perf-*.bench.mjs —
 * их гоняют отдельной целью (npm run bench:perf), одну за раз.
 *
 * Запуск: node --test src/tests/perf-approval-hook-latency.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { updateApprovalFilesHook } from '../scripts/move-ticket-core.js';
import { createCountingFs } from './_fs-op-counter.mjs';

const TICKET_ID = 'BENCH-001';
const TARGET = 'in-progress';

function createApprovalsDir(noiseFiles) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-approval-hook-'));
  const workflowDir = path.join(tmpDir, '.workflow');
  const approvalsDir = path.join(workflowDir, 'approvals');
  fs.mkdirSync(approvalsDir, { recursive: true });

  const pendingFile = path.join(approvalsDir, `${TICKET_ID}_manual-gate-test_001.json`);
  fs.writeFileSync(pendingFile, JSON.stringify({
    status: 'pending',
    ticket_id: TICKET_ID,
    created_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  // Чужие гейты и мусор в том же каталоге: хук не должен их читать.
  for (let i = 0; i < noiseFiles; i++) {
    const otherId = `OTHER-${String(i + 1).padStart(3, '0')}`;
    fs.writeFileSync(
      path.join(approvalsDir, `${otherId}_manual-gate-test_001.json`),
      JSON.stringify({ status: 'pending', ticket_id: otherId }, null, 2),
      'utf8',
    );
  }

  return { tmpDir, workflowDir, pendingFile };
}

test('approval-hook: цена хука — 5 обращений к диску независимо от размера каталога approvals', () => {
  const { tmpDir, workflowDir, pendingFile } = createApprovalsDir(40);
  const counter = createCountingFs();

  try {
    updateApprovalFilesHook(TICKET_ID, TARGET, counter.fs, workflowDir);

    // Хук сделал работу, а не промолчал: цифры ниже имеют смысл только вместе с этим.
    const decided = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    assert.equal(decided.status, 'approved', 'pending-гейт должен быть закрыт хуком');
    assert.equal(decided.decided_by, 'move-ticket');

    assert.equal(counter.op('existsSync'), 1, `проверка каталога approvals — одна: ${counter.describe()}`);
    assert.equal(counter.op('readdirSync'), 1, `каталог читается один раз, второй проход — регресс: ${counter.describe()}`);
    assert.equal(counter.op('readFileSync'), 1, `читается только свой гейт, чужие 40 — нет: ${counter.describe()}`);
    // Запись решения идёт через временный файл: writeFileSync во временный путь плюс
    // renameSync поверх гейта. Пятая операция — цена атомарности, принятая осознанно
    // 2026-09-24: прямая запись обрезала approval-файл до нуля, и раннер в poll-цикле
    // читал пустую строку, уводя стадию в goto.error ровно в момент, когда человек
    // нажал approve. Растёт цена на константу, а не на размер каталога — второй тест
    // файла держит именно это.
    assert.equal(counter.op('writeFileSync'), 1, `содержимое пишется один раз, во временный файл: ${counter.describe()}`);
    assert.equal(counter.op('renameSync'), 1, `публикация решения — одна операция замены: ${counter.describe()}`);
    assert.equal(counter.total(), 5, `цена хука — ровно 5 операций: ${counter.describe()}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('approval-hook: цена не растёт вместе с каталогом (10 чужих гейтов против 400)', () => {
  const small = createApprovalsDir(10);
  const large = createApprovalsDir(400);
  const smallCounter = createCountingFs();
  const largeCounter = createCountingFs();

  try {
    updateApprovalFilesHook(TICKET_ID, TARGET, smallCounter.fs, small.workflowDir);
    updateApprovalFilesHook(TICKET_ID, TARGET, largeCounter.fs, large.workflowDir);

    assert.deepEqual(
      { ...largeCounter.counts },
      { ...smallCounter.counts },
      `в каталоге в 40 раз больше файлов, а обращений к диску столько же должно быть: ` +
      `10 гейтов → ${smallCounter.describe()}; 400 гейтов → ${largeCounter.describe()}`,
    );
  } finally {
    fs.rmSync(small.tmpDir, { recursive: true, force: true });
    fs.rmSync(large.tmpDir, { recursive: true, force: true });
  }
});
