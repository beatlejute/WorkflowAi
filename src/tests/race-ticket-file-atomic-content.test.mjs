#!/usr/bin/env node

/**
 * Регресс: тикет виден в колонке целиком, а не пустым на время записи.
 *
 * Инцидент того же класса, что и QA-37-003 (approval-файл) и маркер пайплайна.
 * Перемещение тикета делалось в два шага: `renameSync(source, target)` и сразу
 * следом `writeFileSync(target, newContent)`. Вторая операция открывает файл с
 * флагом 'w', то есть СНАЧАЛА обрезает его до нуля и только потом пишет
 * содержимое. Между этими шагами тикет лежит в целевой колонке нулевой длины.
 *
 * Цена. `parseFrontmatter('')` не бросает исключение — он возвращает
 * `{ frontmatter: {}, body: '' }`. Значит читатель не падает, ничего не пишет в
 * журнал и спокойно работает с тикетом, у которого нет ни статуса, ни типа, ни
 * зависимостей. В pick-next-task такой тикет проходит `checkDependencies(undefined)`,
 * а это «зависимостей нет»: на работу может уйти тикет, чьи зависимости ещё не
 * выполнены. Ни одной строки в логе об этом не появится.
 *
 * Путей записи два и оба живые: CLI-скрипты стадий раннера и
 * src/lib/operations/tickets.mjs — слой за MCP move_ticket, который дёргает
 * человек или соседний агент независимо от пайплайна.
 *
 * Тест не измеряет время: наблюдатель встаёт вместо методов fs и после каждой
 * мутации смотрит на тикет глазами постороннего читателя.
 *
 * Запуск: node --test src/tests/race-ticket-file-atomic-content.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  watchFsMutations,
  inspectMarkdownArtifact,
  listAsScanner,
  listRaw,
} from './_atomic-publish-observer.mjs';
import {
  tempSiblingPath,
  parsePublishTempName,
  replaceFileAtomicSync,
  RENAME_RETRY_BUDGET_MS,
} from '../lib/utils.mjs';
import { snapshot, diff, isEmpty } from '../lib/artifact-snapshot.mjs';

const COLUMNS = ['backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'archive'];
const TICKET_ID = 'IMPL-001';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '../scripts');
const LIB_DIR = path.resolve(__dirname, '../lib');

function makeBoard(root) {
  const ticketsDir = path.join(root, '.workflow', 'tickets');
  for (const column of COLUMNS) fs.mkdirSync(path.join(ticketsDir, column), { recursive: true });
  return ticketsDir;
}

function writeTicket(ticketsDir, column, id = TICKET_ID) {
  const content =
    `---\nid: ${id}\ntitle: Тикет для проверки атомарности\nstatus: ${column}\n` +
    `type: impl\npriority: 3\ndependencies:\n  - ${id}-DEP\ncreated_at: 2026-09-24T00:00:00.000Z\n---\n\n` +
    '## Описание\n\nТело тикета.\n';
  fs.writeFileSync(path.join(ticketsDir, column, `${id}.md`), content, 'utf8');
}

/**
 * Снимок доски глазами читателя: тикет либо отсутствует, либо цел, и лежит
 * ровно в одной колонке. Дубля быть не должно — иначе pick-next-task увидит
 * один и тот же тикет дважды.
 */
function makeBoardInspector(ticketsDir) {
  return (label) => {
    const violations = [];
    const seen = [];

    for (const column of COLUMNS) {
      const columnDir = path.join(ticketsDir, column);
      if (listAsScanner(columnDir).includes(`${TICKET_ID}.md`)) seen.push(column);
      violations.push(...inspectMarkdownArtifact(path.join(columnDir, `${TICKET_ID}.md`), `${label} / ${column}`));
    }

    if (seen.length !== 1) {
      violations.push(
        `${label}: тикет виден сканированию в ${seen.length} колонках (${seen.join(', ') || 'ни в одной'}) — ` +
        'читатель получает либо дубль, либо пропавший тикет'
      );
    }

    return violations;
  };
}

// Скрипт вычисляет корень проекта при импорте (`findProjectRoot()` от cwd),
// поэтому временный проект заводится до импорта, а cwd возвращается сразу после.
const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-atomic-cli-'));
const cliTicketsDir = makeBoard(cliRoot);
const cwdBeforeImport = process.cwd();
process.chdir(cliRoot);
const { moveTicket: moveTicketCli } = await import('../scripts/move-ticket.js');
process.chdir(cwdBeforeImport);

const { moveTicket: moveTicketMcp } = await import('../lib/operations/tickets.mjs');

after(() => fs.rmSync(cliRoot, { recursive: true, force: true }));

describe('перемещение тикета: читателю виден либо отсутствующий файл, либо целый', () => {
  it('CLI-путь (src/scripts/move-ticket.js) не показывает тикет пустым', async () => {
    writeTicket(cliTicketsDir, 'ready');
    const observer = watchFsMutations(makeBoardInspector(cliTicketsDir));

    let result;
    try {
      result = await moveTicketCli(TICKET_ID, 'in-progress');
    } finally {
      observer.restore();
    }

    assert.equal(result.status, 'moved', `перемещение должно было состояться: ${JSON.stringify(result)}`);
    assert.ok(observer.mutations > 0, 'наблюдатель не увидел ни одной мутации — тест ничего не проверил');
    assert.deepEqual(observer.violations, [], observer.violations.join('\n'));

    const moved = fs.readFileSync(path.join(cliTicketsDir, 'in-progress', `${TICKET_ID}.md`), 'utf8');
    assert.match(moved, /status: in-progress/, 'статус в frontmatter должен совпасть с колонкой');
    assert.match(moved, /IMPL-001-DEP/, 'тело и зависимости тикета должны уцелеть');

    for (const column of ['ready', 'in-progress']) {
      const leftovers = listRaw(path.join(cliTicketsDir, column)).filter(f => parsePublishTempName(f));
      assert.deepEqual(leftovers, [], `в ${column}/ остались временные файлы: ${leftovers.join(', ')}`);
    }
  });

  it('путь MCP (src/lib/operations/tickets.mjs) не показывает тикет пустым', async () => {
    const mcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-atomic-mcp-'));
    const ticketsDir = makeBoard(mcpRoot);
    writeTicket(ticketsDir, 'ready');

    const observer = watchFsMutations(makeBoardInspector(ticketsDir));
    let result;
    try {
      result = await moveTicketMcp(mcpRoot, TICKET_ID, 'in-progress');
    } finally {
      observer.restore();
    }

    try {
      assert.equal(result.to, 'in-progress');
      assert.ok(observer.mutations > 0, 'наблюдатель не увидел ни одной мутации — тест ничего не проверил');
      assert.deepEqual(observer.violations, [], observer.violations.join('\n'));

      const moved = fs.readFileSync(path.join(ticketsDir, 'in-progress', `${TICKET_ID}.md`), 'utf8');
      assert.match(moved, /IMPL-001-DEP/, 'тело и зависимости тикета должны уцелеть');
      const leftovers = listRaw(path.join(ticketsDir, 'in-progress')).filter(f => parsePublishTempName(f));
      assert.deepEqual(leftovers, [], `остались временные файлы: ${leftovers.join(', ')}`);
    } finally {
      fs.rmSync(mcpRoot, { recursive: true, force: true });
    }
  });

  it('временный файл публикации не проходит ни один боевой фильтр каталога', () => {
    // Фильтры взяты у читателей каталога тикетов: pick-next-task-core.js,
    // check-conditions.js, mark-blocked-core.js (поиск по startsWith(id) +
    // endsWith('.md')), get-next-id.js (^PREFIX-\d+\.md$), utils.mjs.
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-atomic-name-'));
    try {
      const artifact = path.join(probeDir, `${TICKET_ID}.md`);
      const tmpName = path.basename(tempSiblingPath(artifact));

      assert.ok(!tmpName.endsWith('.md'), `имя "${tmpName}" пройдёт фильтр endsWith('.md')`);
      assert.ok(tmpName.startsWith('.'), `имя "${tmpName}" не отсекается фильтром startsWith('.')`);
      assert.ok(!/^IMPL-(\d+)\.md$/i.test(tmpName), `имя "${tmpName}" примут за тикет при выдаче следующего id`);
      assert.ok(
        !(tmpName.startsWith(TICKET_ID) && tmpName.endsWith('.md')),
        `имя "${tmpName}" найдёт поиск тикета в mark-blocked-core`
      );

      // Форму имени знает сам помощник: проверки остатков выше спрашивают её у
      // него, а не повторяют шаблон руками — иначе правка имени делает такую
      // проверку не красной, а бессмысленно зелёной.
      assert.deepEqual(
        parsePublishTempName(tmpName),
        { pid: process.pid },
        `помощник не узнаёт собственное временное имя "${tmpName}"`
      );
      assert.equal(parsePublishTempName(`${TICKET_ID}.md`), null, 'тикет принят за временный файл');
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });

  it('временный файл не виден и снимку артефактов (verify-artifacts)', async () => {
    // Единственное сканирование каталога тикетов без фильтра `.md` —
    // src/lib/artifact-snapshot.mjs. Остаток процесса, убитого между записью
    // временного файла и переименованием, попадал в его diff как СОЗДАННЫЙ
    // артефакт, и verify-artifacts объявлял артефакты изменёнными на пустом
    // месте. Исключение по `*.tmp` (с префиксом из двух звёздочек) в том же
    // модуле работает только по хвосту имени — поэтому хвост обязателен.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-atomic-snap-'));
    try {
      const ticketsDir = makeBoard(root);
      writeTicket(ticketsDir, 'in-progress');
      const column = path.join(ticketsDir, 'in-progress');

      const before = await snapshot(root);
      const leftover = tempSiblingPath(path.join(column, `${TICKET_ID}.md`));
      fs.writeFileSync(leftover, 'недописанный тикет умершего процесса', 'utf8');
      const after = await snapshot(root);

      const changes = diff(before, after);
      assert.ok(
        isEmpty(changes),
        `снимок артефактов увидел остаток "${path.basename(leftover)}": ${JSON.stringify(changes)}`
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('тикет с длинным id публикуется, а не падает ENOENT на временном имени', async () => {
    // NTFS не создаёт компонент пути длиннее 255 символов. Имя тикета в 243
    // символа создаётся и перезаписывается напрямую без проблем, а временное имя
    // для него без бюджета выходило 267 — и публикация падала ENOENT. В CLI
    // исключение ловится ПОСЛЕ переезда файла, то есть получался ровно тот
    // фантомный статус (тикет в новой колонке со старым frontmatter), которого
    // вся эта правка и избегает; в MCP moveTicket оно выходило наружу.
    const longId = `IMPL-${'A'.repeat(235)}`;
    assert.equal(`${longId}.md`.length, 243, 'длина имени файла в тесте посчитана неверно');

    const tmpName = path.basename(tempSiblingPath(path.join(cliTicketsDir, 'ready', `${longId}.md`)));
    assert.ok(tmpName.length <= 255, `временное имя в ${tmpName.length} символов NTFS не создаст`);
    assert.ok(parsePublishTempName(tmpName), `урезанное имя "${tmpName}" потеряло форму временного`);

    writeTicket(cliTicketsDir, 'ready', longId);
    const result = await moveTicketCli(longId, 'in-progress');
    assert.equal(result.status, 'moved', `перемещение должно было состояться: ${JSON.stringify(result)}`);

    const moved = fs.readFileSync(path.join(cliTicketsDir, 'in-progress', `${longId}.md`), 'utf8');
    assert.match(moved, /status: in-progress/, 'frontmatter остался старым — тикет переехал с фантомным статусом');
  });
});

describe('цена атомарной публикации и слышимость запасного пути', () => {
  /** fs, у которого rename не проходит НИКОГДА: так выглядит исчерпанная лестница. */
  function busyFs() {
    const writes = [];
    const renames = [];
    return {
      writes,
      renames,
      writeFileSync: (file) => { writes.push(String(file)); },
      renameSync: (from) => { renames.push(String(from)); const err = new Error('rename отклонён'); err.code = 'EPERM'; throw err; },
      unlinkSync: () => {},
    };
  }

  it('ожидание ограничено объявленным бюджетом', () => {
    // sleepSync — это Atomics.wait на главном потоке: за эту паузу в процессе не
    // выполняется вообще ничего, ни таймер, ни ввод-вывод. Цифра прибита здесь
    // намеренно, чтобы удлинение лестницы нельзя было провести молча: потолок
    // ожидания — решение, а не деталь реализации.
    assert.equal(
      RENAME_RETRY_BUDGET_MS,
      88,
      'потолок ожидания одной публикации изменился; это блокирующая пауза на главном ' +
      'потоке, и новое значение нужно обосновать замером, а не правкой лестницы'
    );

    const fsModule = busyFs();
    const started = Date.now();
    const result = replaceFileAtomicSync('/нет-такого-каталога/IMPL-001.md', 'содержимое', {
      fsModule,
      warn: () => {},
    });
    const elapsed = Date.now() - started;

    assert.equal(result.atomic, false, 'при вечном EPERM публикация обязана уйти на запасной путь');
    // Ограниченность — числом попыток: по одной на ступень лестницы, не больше.
    assert.equal(
      fsModule.renames.length,
      7,
      `попыток замены ${fsModule.renames.length} — лестница перестала быть ограниченной`
    );
    // Время — только грубый потолок: под полным набором Atomics.wait перелетает
    // заказанную паузу, и на CI macOS 2026-09-25 88 мс ожидания заняли 271 мс.
    // Потолок ловит ожидание на порядок длиннее бюджета, а не точность паузы.
    assert.ok(
      elapsed <= RENAME_RETRY_BUDGET_MS * 10,
      `ожидание ${elapsed} мс при бюджете ${RENAME_RETRY_BUDGET_MS} мс — пауза ступени перестала быть заказанной`
    );
    assert.equal(
      fsModule.writes.length,
      2,
      `записей должно быть две — временный файл и запасной путь: ${fsModule.writes.join(', ')}`
    );
  });

  it('без опций сообщение о запасном пути уходит в stderr, а не теряется', () => {
    // Что сообщение приходит в переданный `warn`, держит
    // src/tests/atomic-publish-helpers.test.mjs. Здесь проверяется путь БЕЗ
    // опций — тот, которым идут все боевые вызывающие: `{ atomic: false }` не
    // смотрит ни один из них, поэтому если приёмник по умолчанию отвалится,
    // тикеты начнут публиковаться небезопасно и узнать об этом будет неоткуда.
    // console.warn пишет в stderr — stdout у скриптов занят JSON-ответом.
    const seen = [];
    const original = console.warn;
    console.warn = (message) => seen.push(message);
    try {
      replaceFileAtomicSync('/нет-такого-каталога/IMPL-001.md', 'содержимое', { fsModule: busyFs() });
    } finally {
      console.warn = original;
    }

    assert.equal(seen.length, 1, 'по умолчанию сообщение о неатомарной записи никуда не уходит');
    assert.match(seen[0], /IMPL-001\.md/, 'в сообщении нет имени файла — искать виновника будет негде');
    assert.match(seen[0], /пуст/, 'сообщение не называет следствие: файл виден читателю пустым');
  });
});

describe('ни один пишущий путь не возвращает прямую запись поверх тикета', () => {
  // Четыре из шести мест — скрипты, которые вызывают main() прямо при импорте
  // (move-to-ready, move-to-review, check-conditions) или считают корень проекта
  // на уровне модуля. Наблюдателем их не накрыть, не переписав сами скрипты,
  // поэтому от возврата прежнего кода их стережёт проверка исходника: она
  // краснеет ровно на том тексте, который и был багом.
  const SITES = [
    { file: path.join(SCRIPTS_DIR, 'move-ticket.js'), forbidden: ['fs.writeFileSync(targetPath'], required: 'replaceFileAtomicSync(targetPath' },
    { file: path.join(SCRIPTS_DIR, 'move-to-ready.js'), forbidden: ['fs.writeFileSync(targetPath'], required: 'replaceFileAtomicSync(targetPath' },
    { file: path.join(SCRIPTS_DIR, 'move-to-review.js'), forbidden: ['fs.writeFileSync(targetPath'], required: 'replaceFileAtomicSync(targetPath' },
    { file: path.join(SCRIPTS_DIR, 'check-conditions.js'), forbidden: ['fs.writeFileSync(targetPath'], required: 'replaceFileAtomicSync(targetPath' },
    { file: path.join(SCRIPTS_DIR, 'pick-next-task.js'), forbidden: ['fs.writeFileSync(toPath', 'fs.writeFileSync(destPath'], required: 'replaceFileAtomicSync(toPath' },
    { file: path.join(LIB_DIR, 'operations', 'tickets.mjs'), forbidden: ['fs.writeFile(targetPath'], required: 'replaceFileAtomic(targetPath' },
  ];

  for (const site of SITES) {
    it(`${path.basename(site.file)} публикует тикет через общий помощник`, () => {
      const source = fs.readFileSync(site.file, 'utf8');
      for (const bad of site.forbidden) {
        assert.ok(
          !source.includes(bad),
          `${path.basename(site.file)}: вернулась прямая запись "${bad}" — она обрезает тикет до нуля, ` +
          'и читатель получает тикет с пустым frontmatter вместо ошибки'
        );
      }
      assert.ok(
        source.includes(site.required),
        `${path.basename(site.file)}: нет публикации через "${site.required}"`
      );
    });
  }
});
