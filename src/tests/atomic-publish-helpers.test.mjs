#!/usr/bin/env node

/**
 * Границы самих помощников атомарной публикации (src/lib/utils.mjs), а не
 * поведение вызывающих: окно гонки держат race-*.test.mjs, здесь держится то,
 * чем помощник может сломать вызывающего.
 *
 * Что именно и почему.
 *
 * 1. Длина имени временного файла. Помощник добавляет к имени артефакта суффикс
 *    `.<pid>.<hex>.tmp` — около 24 символов, — а компонент пути длиннее 255
 *    символов NTFS не создаёт. id тикета бывает длиной больше 200
 *    (src/tests/edge-ticket-id-long.test.mjs), и без бюджета временный файл
 *    просто не создавался: запись падала ENOENT ровно там, где прямая запись
 *    раньше проходила. Цена этого несимметрична и потому проверяется отдельно:
 *    moveTicket бросает ПОСЛЕ переезда файла в новую колонку и ДО
 *    approveOpenGates (тикет в новой колонке со старым updated_at, доска и ответ
 *    MCP расходятся), а checkAndClosePlan тот же ENOENT глотает существующим
 *    `catch (_)` — план закрывается, тикет молча остаётся в done/, archived
 *    приходит пустым, и в журнале ни строки.
 *
 * 2. Слышимость запасного пути. Если лестница повторов rename исчерпана,
 *    помощник пишет файл напрямую — то есть возвращает то самое окно, ради
 *    которого он и заведён. Молчать об этом нельзя: `{ atomic: false }` не
 *    смотрит ни один вызывающий.
 *
 * Запуск: node --test --test-timeout=120000 --import ./src/tests/_rails-home.mjs src/tests/atomic-publish-helpers.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  tempSiblingPath,
  parsePublishTempName,
  replaceFileAtomicSync,
  replaceFileAtomic,
  checkAndClosePlan,
} from '../lib/utils.mjs';
import { moveTicket } from '../lib/operations/tickets.mjs';

/** Предел длины компонента пути на NTFS — проверяется прямым созданием файла ниже. */
const MAX_PATH_COMPONENT = 255;

const TICKET_COLUMNS = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'archive'];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-helpers-'));
  const workflowDir = path.join(root, '.workflow');
  const plansDir = path.join(workflowDir, 'plans', 'current');
  fs.mkdirSync(plansDir, { recursive: true });
  for (const column of TICKET_COLUMNS) {
    fs.mkdirSync(path.join(workflowDir, 'tickets', column), { recursive: true });
  }
  return { root, workflowDir, plansDir };
}

/** id заданной длины: префикс боевой, хвост — набивка. */
function longTicketId(length) {
  return 'IMPL-' + 'A'.repeat(length - 'IMPL-'.length);
}

// ============================================================================
// Предел длины имени
// ============================================================================

test('tempSiblingPath: временный файл создаётся при любой длине имени артефакта', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-name-'));
  try {
    // 232 — порог, найденный запуском: на нём прежнее имя выходило в 256
    // символов и запись падала ENOENT. Остальные длины по обе стороны от него.
    for (const nameLength of [12, 200, 231, 232, 240, 255, 400]) {
      const artifact = path.join(dir, 'I'.repeat(nameLength - 3) + '.md');
      const tempPath = tempSiblingPath(artifact);
      const tempName = path.basename(tempPath);

      assert.ok(
        tempName.length <= MAX_PATH_COMPONENT,
        `имя артефакта ${nameLength} символов дало временное имя ${tempName.length} — ` +
        `компонент длиннее ${MAX_PATH_COMPONENT} не создаётся, и запись упадёт ENOENT`
      );

      // Доказательство запуском, а не арифметикой: файл действительно создаётся.
      fs.writeFileSync(tempPath, 'содержимое', 'utf8');
      assert.ok(fs.existsSync(tempPath), `временный файл для имени ${nameLength} символов не создался`);
      fs.unlinkSync(tempPath);

      // Требования к форме имени от бюджета не пострадали. Форму спрашиваем у
      // самого помощника: повтор шаблона руками от правки имени стал бы не
      // красным, а бессмысленно зелёным.
      assert.ok(tempName.startsWith('.'), `имя "${tempName}" не отсекается фильтром startsWith('.')`);
      assert.ok(!tempName.endsWith('.md'), `имя "${tempName}" пройдёт фильтр endsWith('.md')`);
      assert.deepEqual(parsePublishTempName(tempName), { pid: process.pid },
        `имя "${tempName}" перестало называть владельца — по pid отличают остаток умершего прогона`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('moveTicket: тикет с длинным id переезжает целиком, а не в новую колонку со старым updated_at', async () => {
  const project = makeProject();
  try {
    const id = longTicketId(230);
    const oldStamp = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(
      path.join(project.workflowDir, 'tickets', 'ready', `${id}.md`),
      `---\nid: ${id}\ntitle: Тикет с длинным id\nstatus: ready\ntype: impl\n` +
      `updated_at: ${oldStamp}\n---\n\nТело тикета.\n`,
      'utf8',
    );

    const result = await moveTicket(project.root, id, 'in-progress');

    assert.equal(result.to, 'in-progress');
    assert.ok(Array.isArray(result.approvals),
      'бросок на записи не давал дойти до approveOpenGates — открытые manual-gate оставались неподтверждёнными');

    const moved = fs.readFileSync(path.join(project.workflowDir, 'tickets', 'in-progress', `${id}.md`), 'utf8');
    assert.doesNotMatch(moved, new RegExp(oldStamp),
      'тикет переехал, но updated_at остался старым — доска и ответ MCP расходятся');
    assert.match(moved, /Тело тикета/, 'тело тикета должно уцелеть');

    const leftovers = fs.readdirSync(path.join(project.workflowDir, 'tickets', 'in-progress'))
      .filter(f => parsePublishTempName(f));
    assert.deepEqual(leftovers, [], `остались временные файлы: ${leftovers.join(', ')}`);
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

test('checkAndClosePlan: done-тикет с длинным id попадает в archive, а не молча остаётся в done', () => {
  const project = makeProject();
  try {
    const id = longTicketId(230);
    fs.writeFileSync(
      path.join(project.plansDir, 'PLAN-001.md'),
      '---\nid: PLAN-001\ntitle: План с длинным тикетом\nstatus: approved\n---\n\nТело плана.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(project.workflowDir, 'tickets', 'done', `${id}.md`),
      `---\nid: ${id}\ntitle: Тикет с длинным id\nstatus: done\ntype: impl\n` +
      `parent_plan: plans/current/PLAN-001.md\n---\n\nТело тикета.\n`,
      'utf8',
    );

    const result = checkAndClosePlan(project.workflowDir, 'PLAN-001');

    assert.equal(result.closed, true, `план должен был закрыться: ${JSON.stringify(result)}`);
    assert.deepEqual(result.archived, [id],
      'ENOENT на длинном имени проглатывался catch(_): план закрывался, а тикет оставался в done без единой строки в журнале');
    assert.deepEqual(fs.readdirSync(path.join(project.workflowDir, 'tickets', 'done')), []);
    assert.deepEqual(fs.readdirSync(path.join(project.workflowDir, 'tickets', 'archive')), [`${id}.md`]);
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

// ============================================================================
// Слышимость запасного пути
// ============================================================================

/** fs, у которого замена всегда отклоняется как «файл занят»: лестница исчерпывается заведомо. */
function fsWithBusyRename() {
  return {
    ...fs,
    renameSync() {
      const err = new Error('rename отклонён: файл держит открытым другой процесс');
      err.code = 'EPERM';
      throw err;
    },
  };
}

test('replaceFileAtomicSync: исчерпанная лестница повторов не проходит молча', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-fallback-'));
  try {
    const artifact = path.join(dir, 'PLAN-001.md');
    fs.writeFileSync(artifact, '---\nid: PLAN-001\n---\n\nстарое\n', 'utf8');
    const warnings = [];

    const result = replaceFileAtomicSync(artifact, '---\nid: PLAN-001\n---\n\nновое\n', {
      fsModule: fsWithBusyRename(),
      warn: (message) => warnings.push(message),
    });

    assert.equal(result.atomic, false, 'замена не состоялась — признак обязан это показывать');
    assert.equal(warnings.length, 1, `о неатомарной записи сообщается ровно один раз: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /PLAN-001\.md/, 'в сообщении должен быть файл, иначе искать нечего');
    assert.match(warnings[0], /НЕ атомарно/, 'сообщение обязано называть суть, а не только код ошибки');
    assert.match(warnings[0], /88 мс/, 'сообщение обязано называть исчерпанный бюджет повторов');

    assert.match(fs.readFileSync(artifact, 'utf8'), /новое/,
      'запасной путь на то и запасной: содержимое обязано дойти до файла');
    const leftovers = fs.readdirSync(dir).filter(f => parsePublishTempName(f));
    assert.deepEqual(leftovers, [], `после запасного пути остались временные файлы: ${leftovers.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replaceFileAtomicSync: урезанный fs без renameSync предупреждения не даёт', () => {
  // Подменённый в тесте fs без замены — не деградация, а отсутствие предмета
  // защиты: гонки в выдуманной файловой системе нет. Предупреждение здесь было
  // бы шумом в каждом тесте, который подсовливает mock.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-fakefs-'));
  try {
    const artifact = path.join(dir, 'PLAN-001.md');
    const warnings = [];
    const written = [];

    const result = replaceFileAtomicSync(artifact, 'содержимое', {
      fsModule: { writeFileSync: (file, data) => written.push([String(file), data]) },
      warn: (message) => warnings.push(message),
    });

    assert.equal(result.atomic, false);
    assert.deepEqual(warnings, [], 'урезанный fs — не повод пугать читателя журнала');
    assert.deepEqual(written, [[artifact, 'содержимое']], 'содержимое должно уйти прямо в артефакт');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Только Windows: на Linux и macOS rename поверх открытого файла проходит (CI 2026-09-25:
// `atomic: true` на ubuntu и macOS), занятого файла в смысле NTFS там нет.
test('replaceFileAtomic: на настоящем занятом файле запасной путь тоже слышен', { skip: process.platform !== 'win32' && 'rename поверх открытого файла отклоняет только NTFS' }, async () => {
  // Здесь rename отклоняет не подмена, а сама ОС: NTFS отвечает EPERM на замену
  // файла, который кто-то держит открытым (проверено запуском — и для чужого
  // процесса, и для своего же дескриптора), тогда как прямая запись проходит.
  // Именно это несовпадение и есть причина существования запасного пути.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-busy-'));
  const artifact = path.join(dir, 'IMPL-001.md');
  fs.writeFileSync(artifact, '---\nid: IMPL-001\n---\n\nстарое\n', 'utf8');
  const holder = fs.openSync(artifact, 'r');
  const warnings = [];
  try {
    const result = await replaceFileAtomic(artifact, '---\nid: IMPL-001\n---\n\nновое\n', {
      warn: (message) => warnings.push(message),
    });

    assert.equal(result.atomic, false, 'на занятом файле замена обязана не состояться, а не притворяться удачной');
    assert.equal(warnings.length, 1, `о неатомарной записи сообщается ровно один раз: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /IMPL-001\.md/);
    assert.match(fs.readFileSync(artifact, 'utf8'), /новое/, 'содержимое обязано дойти до файла');
  } finally {
    fs.closeSync(holder);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
