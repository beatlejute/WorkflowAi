/**
 * Секция «## Ревью» тикета (src/lib/review-section.mjs): чтение последнего вердикта и
 * дописывание строки. До этого файла запись строки (appendReviewEntry) не проверялась
 * ни одним тестом, а чтение — только попутно.
 *
 * Почему это важно. По последнему вердикту пайплайн решает судьбу тикета: авто-коррекция
 * pick-next-task переносит тикет из done/ в backlog/, если вердикта нет или он failed;
 * check-relevance и move-ticket смотрят туда же. Поэтому:
 *  - нераспознанный статус равен «ревью не было» — это проверяется явно, чтобы формат
 *    ячейки (значок плюс слово) не поменяли молча;
 *  - при нескольких секциях берётся последняя (дописывание запасным путём);
 *  - строка дописывается после последней строки данных, а не в конец секции, и таблица
 *    создаётся, если её не было.
 *
 * Инцидент, закрытый этим же изменением (проверено запуском 2026-09-24 на NTFS): пока
 * тикет держал открытым другой читатель, appendReviewEntry падал EPERM на rename и
 * возвращал WRITE_ERROR — строка ревью терялась. Теперь запись идёт через общий
 * replaceFileAtomicSync с лестницей повторов; регресс ловит тест «открытый читатель».
 * На Linux rename поверх открытого файла разрешён, и тест там проходит в любом случае —
 * он охраняет именно Windows.
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/review-section.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getLastReviewStatus, appendReviewEntry } from '../lib/review-section.mjs';

const HEADER = '| Дата | Статус | Самари | Агент |';
const SEP = '|------|--------|--------|-------|';

function withTicket(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-section-'));
  const file = path.join(dir, 'IMPL-001.md');
  fs.writeFileSync(file, content, 'utf8');
  try {
    fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Вывод предупреждений парсера («section not found» и т.п.) в тестах не нужен:
// нужен только возвращаемый статус.
function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

const review = (...rows) => `## Ревью\n\n${HEADER}\n${SEP}\n${rows.join('\n')}\n`;

// ---------- getLastReviewStatus ----------

test('чтение: три канонических статуса распознаются по значку и слову', () => {
  assert.equal(getLastReviewStatus(review('| 2026-09-24 | ✅ passed | ок | a |')), 'passed');
  assert.equal(getLastReviewStatus(review('| 2026-09-24 | ❌ failed | нет | a |')), 'failed');
  assert.equal(getLastReviewStatus(review('| 2026-09-24 | ⏭️ skipped | неактуально | a |')), 'skipped');
});

test('чтение: берётся последняя строка таблицы', () => {
  const content = review('| 2026-09-23 | ❌ failed | нет | a |', '| 2026-09-24 | ✅ passed | ок | b |');
  assert.equal(getLastReviewStatus(content), 'passed');
});

test('чтение: при двух секциях берётся последняя', () => {
  const content = `${review('| 2026-09-23 | ✅ passed | ок | a |')}\n## Заметки\n\nтекст\n\n${review('| 2026-09-24 | ❌ failed | нет | b |')}`;
  assert.equal(getLastReviewStatus(content), 'failed');
});

test('чтение: столбец статуса ищется по заголовку, а не по позиции', () => {
  const content = '## Ревью\n\n| Дата | Агент | Verdict |\n|---|---|---|\n| 2026-09-24 | a | ✅ passed |\n';
  assert.equal(getLastReviewStatus(content), 'passed');
});

test('чтение: голое слово без значка — «ревью не было», формат ячейки не размывается', () => {
  assert.equal(quiet(() => getLastReviewStatus(review('| 2026-09-24 | passed | ок | a |'))), null);
});

test('чтение: нет секции, нет таблицы, нет столбца статуса, нет строк — null', () => {
  quiet(() => {
    assert.equal(getLastReviewStatus('# Тикет\n\n## Result\n\nСделано.\n'), null);
    assert.equal(getLastReviewStatus('## Ревью\n\nтаблицы нет\n'), null);
    assert.equal(getLastReviewStatus('## Ревью\n\n| Дата | Агент |\n|---|---|\n| 2026-09-24 | a |\n'), null);
    assert.equal(getLastReviewStatus(`## Ревью\n\n${HEADER}\n${SEP}\n`), null);
    assert.equal(getLastReviewStatus(undefined), null);
  });
});

// ---------- appendReviewEntry ----------

const ENTRY = { date: '2026-09-24', agent: 'claude-sonnet', status: 'passed', summary: 'всё сходится' };

test('запись: секции нет — создаётся сразу после frontmatter с таблицей и строкой', () => {
  withTicket('---\nid: "IMPL-001"\n---\n\n# Тикет\n\n## Result\n\nСделано.\n', (file) => {
    assert.deepEqual(appendReviewEntry(file, ENTRY), { ok: true });
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /---\n## Ревью\n\n\| Дата \| Статус \| Самари \| Агент \|/);
    assert.equal(getLastReviewStatus(content), 'passed');
    assert.match(content, /\| 2026-09-24 \| ✅ passed \| всё сходится \| claude-sonnet \|/);
  });
});

test('запись: секция есть — строка встаёт после последней строки данных', () => {
  const before = `---\nid: "IMPL-001"\n---\n\n${review('| 2026-09-23 | ❌ failed | нет | a |')}\n## Заметки\n\nхвост\n`;
  withTicket(before, (file) => {
    appendReviewEntry(file, ENTRY);
    const content = fs.readFileSync(file, 'utf8');
    const rows = content.split('\n').filter((l) => l.startsWith('| 2026'));
    assert.deepEqual(rows.map((r) => r.slice(0, 12)), ['| 2026-09-23', '| 2026-09-24']);
    assert.equal(getLastReviewStatus(content), 'passed');
    assert.match(content, /## Заметки\n\nхвост/, 'следующая секция не задета');
  });
});

test('запись: секция без таблицы — таблица создаётся заново', () => {
  withTicket('---\nid: "IMPL-001"\n---\n\n## Ревью\n\nпока пусто\n', (file) => {
    appendReviewEntry(file, { ...ENTRY, status: 'failed', agent: undefined });
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(getLastReviewStatus(content), 'failed');
    assert.match(content, /\| unknown \|/, 'без агента пишется unknown');
  });
});

test('запись: без frontmatter секция встаёт перед первым заголовком второго уровня', () => {
  withTicket('# Тикет\n\n## Result\n\nСделано.\n', (file) => {
    appendReviewEntry(file, ENTRY);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.indexOf('## Ревью') < content.indexOf('## Result'));
  });
});

test('запись: ни frontmatter, ни заголовков — секция дописывается в конец', () => {
  withTicket('просто текст', (file) => {
    appendReviewEntry(file, ENTRY);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.startsWith('просто текст\n## Ревью'));
  });
});

test('запись: нестандартный статус пишется как есть', () => {
  withTicket('---\nid: "IMPL-001"\n---\n', (file) => {
    appendReviewEntry(file, { ...ENTRY, status: 'на доработке' });
    assert.match(fs.readFileSync(file, 'utf8'), /\| на доработке \|/);
  });
});

test('запись: нет файла или неполная запись — отказ с кодом, файл не создаётся', () => {
  withTicket('---\nid: "IMPL-001"\n---\n', (file, dir) => {
    const missing = path.join(dir, 'IMPL-404.md');
    assert.equal(appendReviewEntry(missing, ENTRY).code, 'FILE_NOT_FOUND');
    assert.equal(fs.existsSync(missing), false);
    assert.equal(appendReviewEntry(file, { date: '2026-09-24' }).code, 'INVALID_ENTRY');
    assert.equal(appendReviewEntry(file, null).code, 'INVALID_ENTRY');
  });
});

test('запись: тикет держит открытым другой читатель — строка всё равно записана', () => {
  withTicket('---\nid: "IMPL-001"\n---\n\n# Тикет\n', (file, dir) => {
    const warn = console.warn;
    const stderrWrite = process.stderr.write;
    process.stderr.write = () => true;
    console.warn = () => {};
    const fd = fs.openSync(file, 'r');
    let result;
    try {
      result = appendReviewEntry(file, ENTRY);
    } finally {
      fs.closeSync(fd);
      console.warn = warn;
      process.stderr.write = stderrWrite;
    }
    assert.deepEqual(result, { ok: true }, 'на NTFS прежняя запись падала EPERM и теряла строку');
    assert.equal(getLastReviewStatus(fs.readFileSync(file, 'utf8')), 'passed');
    assert.deepEqual(fs.readdirSync(dir), ['IMPL-001.md'], 'временных файлов не осталось');
  });
});
