/**
 * Тикет, которому синхронизация правит frontmatter.status под папку доски, обязан быть
 * виден читателю целиком — либо в прежнем виде, либо уже синхронизированным. Пустого и
 * обрезанного промежутка быть не должно.
 *
 * Инцидент того же класса, что маркер запущенного пайплайна, approval-файл ручного гейта
 * и авто-блокировка тикета (все 2026-09-24): syncProject клал результат обратно одним
 * writeFileSync поверх тикета. writeFileSync — это open(файл, 'w') плюс запись вторым
 * шагом: усечение происходит сразу, содержимое приходит позже. В этом окне читатель
 * получает тикет нулевой длины или обрезанный хвост.
 *
 * Цена здесь шире, чем у точечных правок: скрипт проходит по всей доске подряд, то есть
 * окон столько же, сколько рассинхронизированных тикетов. Доску в это время сканируют
 * pick-next-task (readTicketsFromDir), check-conditions (readTickets) и MCP get_ticket.
 * Пустой тикет теряет frontmatter целиком — статус и parent_plan пропадают, id
 * подставляется из имени файла; обрезанный теряет хвост тела, включая секцию Result, по
 * которой findCompletedInProgress решает, что тикет доделан. Ни одна из этих функций не
 * падает — все они просто считают неправду.
 *
 * Стенных часов в тесте нет: наблюдатель подменяет методы fs и снимает состояние тикета
 * глазами читателя после каждой мутации каталога.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/race-sync-ticket-status-atomic-write.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';
import { syncProject, BOARD_DIRS } from '../scripts/sync-ticket-status-core.js';
import { watchFsMutations, inspectMarkdownArtifact, listRaw } from './_atomic-publish-observer.mjs';

// Тело крупное намеренно: чем больше содержимое, тем шире окно между усечением и записью.
const BODY_TAIL = '## Result\n\nСделано, артефакты перечислены.\n';
const BODY = `# Тикет\n\n${'Детали реализации и шаги проверки.\n'.repeat(60)}\n${BODY_TAIL}`;

function ticketText(id, status, extra = '') {
  return [
    '---',
    `id: "${id}"`,
    'title: "Задача"',
    `status: ${status}`,
    'parent_plan: "PLAN-001"',
    'type: task',
    extra,
    '---',
    '',
    BODY,
  ].filter((line) => line !== '').join('\n');
}

function withBoard(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-status-atomic-'));
  try {
    for (const dir of BOARD_DIRS) {
      fs.mkdirSync(path.join(root, '.workflow', 'tickets', dir), { recursive: true });
    }
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const ticketPath = (root, dir, id) => path.join(root, '.workflow', 'tickets', dir, `${id}.md`);

test('синхронизация статуса: читатель ни в одной точке не видит пустой или обрезанный тикет', () => {
  withBoard((root) => {
    // Три тикета в разных колонках с неверным статусом — три окна записи подряд.
    const targets = [
      ['ready', 'TASK-001', 'backlog'],
      ['in-progress', 'TASK-002', 'ready'],
      ['review', 'TASK-003', 'backlog'],
    ];
    for (const [dir, id, wrongStatus] of targets) {
      fs.writeFileSync(ticketPath(root, dir, id), ticketText(id, wrongStatus), 'utf8');
    }

    const watch = watchFsMutations((label) => {
      const found = [];
      for (const [dir, id] of targets) {
        found.push(...inspectMarkdownArtifact(ticketPath(root, dir, id), label));
      }
      return found;
    });

    let result;
    try {
      result = syncProject(root, true);
    } finally {
      watch.restore();
    }

    assert.equal(result.statusFixed.length, 3, 'все три рассинхрона найдены');
    assert.ok(watch.mutations > 0, 'наблюдатель обязан был увидеть хотя бы одну мутацию каталога');
    assert.deepEqual(watch.violations, [], `читатель видел неполный тикет: ${watch.violations.join('; ')}`);

    for (const [dir, id] of targets) {
      const { frontmatter, body } = parseFrontmatter(fs.readFileSync(ticketPath(root, dir, id), 'utf8'));
      assert.equal(frontmatter.status, dir, `${id}: статус приведён к папке`);
      assert.equal(frontmatter.parent_plan, 'PLAN-001', `${id}: привязка к плану не потеряна`);
      assert.ok(body.includes(BODY_TAIL.trim()), `${id}: хвост тела на месте`);
    }
  });
});

test('синхронизация статуса: после записи рядом с тикетом не остаётся временных файлов', () => {
  withBoard((root) => {
    fs.writeFileSync(ticketPath(root, 'done', 'TASK-010'), ticketText('TASK-010', 'review'), 'utf8');

    syncProject(root, true);

    const leftovers = listRaw(path.join(root, '.workflow', 'tickets', 'done')).filter((name) => name !== 'TASK-010.md');
    assert.deepEqual(leftovers, [], `в колонке остался мусор: ${leftovers.join(', ')}`);
  });
});

test('синхронизация статуса: тикет в done без completed_at получает его по mtime файла', () => {
  withBoard((root) => {
    const file = ticketPath(root, 'done', 'TASK-020');
    fs.writeFileSync(file, ticketText('TASK-020', 'done'), 'utf8');
    const mtime = fs.statSync(file).mtime.toISOString();

    const result = syncProject(root, true);

    assert.equal(result.statusFixed.length, 0, 'статус уже верный — правки статуса нет');
    assert.deepEqual(result.completedFilled, [{ id: 'TASK-020', mtime }]);
    const { frontmatter } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    assert.equal(frontmatter.completed_at, mtime);
  });
});

test('синхронизация статуса: dry-run ничего не пишет', () => {
  withBoard((root) => {
    const file = ticketPath(root, 'ready', 'TASK-030');
    const before = ticketText('TASK-030', 'backlog');
    fs.writeFileSync(file, before, 'utf8');

    const result = syncProject(root, false);

    assert.equal(result.statusFixed.length, 1, 'рассинхрон в отчёте есть');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'файл не тронут');
  });
});

test('синхронизация статуса: битый frontmatter и нетикетные файлы пропускаются', () => {
  withBoard((root) => {
    const broken = ticketPath(root, 'backlog', 'TASK-040');
    fs.writeFileSync(broken, '---\nid: "TASK-040"\n  status: [нераскрытая\n---\n\nтело\n', 'utf8');
    fs.writeFileSync(path.join(root, '.workflow', 'tickets', 'backlog', '.gitkeep.md'), '', 'utf8');
    fs.writeFileSync(path.join(root, '.workflow', 'tickets', 'backlog', 'notes.txt'), 'не тикет\n', 'utf8');
    fs.writeFileSync(path.join(root, '.workflow', 'tickets', 'backlog', 'plain.md'), 'без frontmatter\n', 'utf8');
    fs.writeFileSync(ticketPath(root, 'backlog', 'TASK-041'), ticketText('TASK-041', 'ready'), 'utf8');

    const result = syncProject(root, true);

    assert.equal(result.scanned, 1, 'считается только читаемый тикет с frontmatter');
    assert.deepEqual(result.statusFixed.map((r) => r.id), ['TASK-041']);
  });
});

test('синхронизация статуса: отсутствующие колонки и archive не трогаются', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-status-dirs-'));
  try {
    fs.mkdirSync(path.join(root, '.workflow', 'tickets', 'done'), { recursive: true });
    fs.mkdirSync(path.join(root, '.workflow', 'tickets', 'archive'), { recursive: true });
    const archived = path.join(root, '.workflow', 'tickets', 'archive', 'TASK-050.md');
    const before = ticketText('TASK-050', 'ready');
    fs.writeFileSync(archived, before, 'utf8');

    const result = syncProject(root, true);

    assert.equal(result.scanned, 0, 'колонок доски с тикетами нет');
    assert.equal(fs.readFileSync(archived, 'utf8'), before, 'архив хранит статус на момент архивации');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
