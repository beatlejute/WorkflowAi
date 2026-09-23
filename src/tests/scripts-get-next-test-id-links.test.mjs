#!/usr/bin/env node

/**
 * scripts-get-next-test-id-links.test.mjs — два края `src/scripts/get-next-test-id.js`,
 * до сих пор не проверявшиеся: запись-ссылка в каталоге кейсов и запуск без `--skill`.
 *
 * Цена ошибки у этого скрипта одна и та же с обеих сторон — выданный номер
 * тест-кейса, который уже занят. Ровно этот инцидент (2026-09-22, скил
 * analyze-report: при кейсах 001–004 скрипт вернул TC-ANALYZE-REPORT-001) и
 * заставил переписать разбор каталога.
 *
 * 1. Запись-ссылка. На Windows junction в листинге каталога — не файл и не
 *    каталог: readdir отдаёт isFile()=false, isDirectory()=false,
 *    isSymbolicLink()=true (проверено запуском на этой машине и для
 *    `fs.symlinkSync(…, 'junction')`, и для `mklink /J`; то же задокументировано
 *    в src/rails/paths.mjs). Скрипт на такой записи не выбирает шаблон вовсе —
 *    и обязан просто пройти мимо, не подставив ей чужой шаблон: имя ссылки
 *    ничего не говорит о том, что за ней. Если ссылке разрешить занимать номер,
 *    счётчик прыгает на её число (005 → 301), и план начинает ссылаться на
 *    ID, которого нет ни у одного кейса.
 * 2. Запуск без `--skill`. Скрипт обязан выйти кодом 1 и отдать блок результата
 *    со статусом error — без next_id. Молчаливый «успех» с придуманным номером
 *    здесь и есть инцидент с занятым ID.
 *
 * Все фикстуры — во временных каталогах; каталог кейсов репозитория не трогается.
 *
 * Запуск:
 *   node --test --import ./src/tests/_rails-home.mjs src/tests/scripts-get-next-test-id-links.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(PROJECT_ROOT, 'src', 'scripts', 'get-next-test-id.js');

function runScript(cwd, args) {
  try {
    // stdio задан явно: иначе execFileSync дублирует stderr скрипта в вывод прогона.
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function parseResult(stdout) {
  const marker = '---RESULT---';
  const start = stdout.indexOf(marker);
  const end = stdout.indexOf(marker, start + marker.length);
  if (start === -1 || end === -1) return null;
  const out = {};
  for (const line of stdout.slice(start + marker.length, end).split('\n')) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** Временный проект: `.workflow/` — маркер корня для findProjectRoot. */
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'next-test-id-links-'));
  mkdirSync(join(dir, '.workflow'), { recursive: true });
  return dir;
}

test('get-next-test-id: запись-ссылка в cases/ не перебивает номера настоящих кейсов', () => {
  const project = makeProject();
  try {
    const cases = join(project, 'src', 'skills', 'linktest', 'tests', 'cases');
    mkdirSync(cases, { recursive: true });

    // Цель ссылок — вне каталога кейсов: содержимое за ссылкой к нумерации отношения не имеет.
    const linkTarget = join(project, 'link-target');
    mkdirSync(join(linkTarget, 'current'), { recursive: true });

    // Настоящие занятые номера: файл кейса 003 и каталог артефактов 004.
    writeFileSync(join(cases, 'TC-LINKTEST-003-alpha.yaml'), 'id: TC-LINKTEST-003\n', 'utf8');
    mkdirSync(join(cases, 'TC-LINKTEST-004'), { recursive: true });

    // Две ссылки: одна названа как каталог артефактов, другая — как файл кейса.
    // Обе — junction на каталог, то есть ни файл, ни каталог в листинге.
    symlinkSync(linkTarget, join(cases, 'TC-LINKTEST-100'), 'junction');
    symlinkSync(linkTarget, join(cases, 'TC-LINKTEST-300-beta.yaml'), 'junction');

    // Предпосылка теста: если ссылки вдруг видны как каталоги, тест ниже
    // ничего не проверяет — лучше упасть здесь с понятной причиной.
    const links = readdirSync(cases, { withFileTypes: true }).filter((e) => e.name.startsWith('TC-LINKTEST-100') || e.name.startsWith('TC-LINKTEST-300'));
    assert.equal(links.length, 2, 'обе ссылки должны попасть в листинг каталога кейсов');
    for (const link of links) {
      assert.ok(
        !link.isFile() && !link.isDirectory(),
        `${link.name}: ссылка обязана быть в листинге ни файлом, ни каталогом — иначе этот тест проверяет не ту ветку`
      );
    }

    const data = parseResult(runScript(project, ['--skill', 'linktest']).stdout);

    assert.ok(data, 'блок ---RESULT--- обязателен: агент читает next_id только из него');
    assert.equal(
      data.next_id,
      'TC-LINKTEST-005',
      'номер обязан продолжать ряд настоящих кейсов (003 файл, 004 каталог). ' +
        'Если ссылке дать занять номер, счётчик прыгнет на её число, и план сошлётся на ID, которого нет ни у одного кейса'
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('get-next-test-id: без --skill — код выхода 1, статус error и ни одного номера', () => {
  const project = makeProject();
  try {
    const r = runScript(project, []);
    const data = parseResult(r.stdout);

    assert.equal(
      r.code,
      1,
      'без обязательного аргумента код выхода обязан быть ненулевым: по нулю пайплайн зачтёт стадию пройденной'
    );
    assert.ok(data, 'блок ---RESULT--- обязателен даже при ошибке — иначе раннеру нечего разбирать');
    assert.equal(data.status, 'error', 'статус обязан называть отказ, а не успех');
    assert.equal(
      data.next_id,
      undefined,
      'номер при отказе не выдаётся: придуманный next_id — это и есть инцидент с занятым ID'
    );
    assert.match(
      data.error,
      /--skill/,
      'текст ошибки обязан называть недостающий аргумент, иначе агенту нечего исправлять'
    );
    assert.match(r.stderr, /Usage:/, 'подсказка по запуску идёт человеку в stderr');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
