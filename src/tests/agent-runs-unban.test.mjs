/**
 * Снятие запрета человеком (recordUnban, src/lib/agent-runs.mjs, PLAN-003, задача 28)
 * — во временном проекте на диске.
 *
 * Что охраняется:
 *  - снятие постоянного запрета убирает пару «модель + тип тикета» из списка
 *    постоянных запретов (permanentBans, задача 15);
 *  - снятие временного запрета убирает модель из списка временных запретов
 *    (crashBans, задача 17);
 *  - снятие несуществующего запрета — отказ с кодом NO_BAN, строка `unban` в журнал
 *    не пишется (и файл журнала не создаётся, если до этого в проекте не было записи);
 *  - плохой ввод (нет `model`, нет или пустая `reason`) — отказ с кодом BAD_INPUT,
 *    строка не пишется.
 *
 * Изоляция: временный проект в каталоге ОС на тест, teardown в afterEach.
 *
 * Запуск: node --import ./src/tests/_rails-home.mjs --test src/tests/agent-runs-unban.test.mjs
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendRunEvent, readRunEvents, recordUnban, permanentBans, crashBans,
  runsLogPath, EXECUTOR_SKILL,
} from '../lib/agent-runs.mjs';

let root = null;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

function newProject() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runs-unban-'));
  return root;
}

let ticketSeq = 0;
const nextTicket = () => `IMPL-${++ticketSeq}`;

function seedRun(project, model, ticketType, overrides = {}) {
  const { ticket = nextTicket(), ...rest } = overrides;
  const event = {
    type: 'run',
    skill: EXECUTOR_SKILL,
    ticket,
    ticket_type: ticketType,
    agent: 'agent-a',
    model,
    status: 'ok',
    changed_files: 0,
    ...rest,
  };
  const written = appendRunEvent(project, event);
  assert.equal(written.ok, true, written.error);
  return written.event;
}

function fileLines(project) {
  try {
    return fs.readFileSync(runsLogPath(project), 'utf8').split('\n').filter((l) => l.trim());
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

describe('recordUnban', () => {
  test('снятие постоянного запрета убирает пару из permanentBans', () => {
    const project = newProject();
    seedRun(project, 'model-a', 'code', { changed_files: 0 });
    seedRun(project, 'model-a', 'code', { changed_files: 0 });
    seedRun(project, 'model-a', 'code', { changed_files: 0 });
    assert.equal(permanentBans(readRunEvents(project)).length, 1, 'запрет по правилу 1 сформирован');

    const result = recordUnban(project, { model: 'model-a', ticket_type: 'code', reason: 'починили промпт' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.event.type, 'unban');
    assert.equal(result.event.model, 'model-a');
    assert.equal(result.event.ticket_type, 'code');

    const events = readRunEvents(project);
    assert.deepEqual(permanentBans(events), []);
    assert.equal(events.at(-1).type, 'unban');
  });

  test('снятие временного запрета убирает модель из crashBans', () => {
    const project = newProject();
    const now = Date.now();
    seedRun(project, 'model-b', 'code', { status: 'error', changed_files: 0, ts: new Date(now).toISOString() });
    assert.equal(crashBans(readRunEvents(project), now).length, 1, 'временный запрет сформирован');

    const result = recordUnban(project, { model: 'model-b', reason: 'перезапустили модель' }, now + 1000);
    assert.equal(result.ok, true, result.error);
    assert.equal('ticket_type' in result.event, false, 'у временного запрета в событии нет ticket_type');

    assert.deepEqual(crashBans(readRunEvents(project), now + 2000), []);
  });

  test('снятие несуществующего запрета — отказ с кодом NO_BAN, строка не пишется', () => {
    const project = newProject();

    // Журнала ещё нет вовсе.
    const noFile = recordUnban(project, { model: 'model-c', ticket_type: 'code', reason: 'x' });
    assert.equal(noFile.ok, false);
    assert.equal(noFile.code, 'NO_BAN');
    assert.equal(fs.existsSync(runsLogPath(project)), false, 'отказ не создаёт файл журнала');

    // Журнал есть, запрет там — для другой пары.
    seedRun(project, 'model-a', 'code', { changed_files: 0 });
    seedRun(project, 'model-a', 'code', { changed_files: 0 });
    seedRun(project, 'model-a', 'code', { changed_files: 0 });
    assert.equal(permanentBans(readRunEvents(project)).length, 1);
    const before = fileLines(project);

    const wrongPair = recordUnban(project, { model: 'model-a', ticket_type: 'bug', reason: 'x' });
    assert.equal(wrongPair.ok, false);
    assert.equal(wrongPair.code, 'NO_BAN');
    assert.deepEqual(fileLines(project), before, 'строка unban не дописана');
  });

  test('плохой ввод — отказ с кодом BAD_INPUT, строка не пишется', () => {
    const project = newProject();

    const noModel = recordUnban(project, { reason: 'x' });
    assert.equal(noModel.ok, false);
    assert.equal(noModel.code, 'BAD_INPUT');

    const noReason = recordUnban(project, { model: 'model-a' });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.code, 'BAD_INPUT');

    const blankReason = recordUnban(project, { model: 'model-a', reason: '   ' });
    assert.equal(blankReason.ok, false);
    assert.equal(blankReason.code, 'BAD_INPUT');

    assert.equal(fileLines(project).length, 0, 'плохой ввод не пишет в журнал');
  });
});
