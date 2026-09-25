/**
 * Подкоманды управления установкой в CLI (src/cli.mjs): update, list, eject,
 * eject-scripts, eject-configs — и прямой запуск `node src/cli.mjs`. До этого файла
 * ни одна из них не запускалась тестом: покрытие cli.mjs было 60% строк.
 *
 * Запуск — дочерним процессом через bin/workflow.mjs, как у человека: ошибки там
 * заканчиваются process.exit(1), и в процессе тестов это убило бы сам прогон.
 * WORKFLOW_HOME указывает во временный каталог: `update` копирует туда скилы,
 * скрипты, конфиги и ядро рельс из репозитория, а в проекте создаёт junction'ы на эти
 * копии. Настоящий ~/.workflow не трогается.
 *
 * Что охраняется:
 *  - update создаёт ссылки на общие скилы, скрипты и конфиги;
 *  - list показывает статус каждого скила, в том числе ejected;
 *  - eject заменяет ссылку настоящей копией И не трогает общую копию. Снятие ссылки
 *    идёт через rmSync(recursive) — если бы он прошёл по junction'у внутрь, общая копия
 *    скила пропала бы у всех проектов машины (класс инцидента 2026-09-21 из CLAUDE.md:
 *    удаление по пути через ссылку стирает цель). Проверено запуском на node 25:
 *    rmSync снимает только ссылку; тест охраняет это и на других версиях node;
 *  - eject без имени — код 1 и понятная ошибка, а не падение;
 *  - прямой запуск `node src/cli.mjs version` работает. Прежнее сравнение
 *    import.meta.url с `file://${argv[1]}` на Windows не совпадало никогда (обратные
 *    слэши в argv[1]), и прямой запуск молча ничего не делал.
 *
 * Уборка: перед удалением временного каталога ссылки проекта снимаются по одной, без
 * рекурсии — ровно тот порядок, которого требует правило «Симлинки и удаление».
 *
 * Запуск: node --test --import ./src/tests/_rails-home.mjs src/tests/cli-commands.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BIN = path.join(REPO, 'bin', 'workflow.mjs');
const CLI = path.join(REPO, 'src', 'cli.mjs');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-commands-'));
const HOME = path.join(BASE, 'home');
const PROJECT = path.join(BASE, 'project');
const SKILLS = path.join(PROJECT, '.workflow', 'src', 'skills');
const SCRIPTS = path.join(PROJECT, '.workflow', 'src', 'scripts');
const CONFIG = path.join(PROJECT, '.workflow', 'config');
const KILOCODE_SKILLS = path.join(PROJECT, '.kilocode', 'skills');

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Снять ссылку, не заходя в цель: junction — rmdir без /S, symlink — unlink.
function unlinkOnly(p) {
  if (!isLink(p)) return;
  if (process.platform === 'win32') {
    execSync(`rmdir "${p}"`, { shell: 'cmd.exe', stdio: 'pipe' });
  } else {
    fs.unlinkSync(p);
  }
}

function run(args, { cwd = PROJECT, home = HOME, entry = BIN } = {}) {
  const res = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, WORKFLOW_HOME: home },
  });
  return { code: res.status, out: `${res.stdout}`, err: `${res.stderr}` };
}

before(() => {
  fs.mkdirSync(path.join(PROJECT, '.workflow'), { recursive: true });
});

after(() => {
  for (const dir of [SKILLS, KILOCODE_SKILLS]) {
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) unlinkOnly(path.join(dir, name));
    }
  }
  unlinkOnly(SCRIPTS);
  unlinkOnly(CONFIG);
  fs.rmSync(BASE, { recursive: true, force: true });
});

test('list без общей установки: скилов нет — сообщение, а не ошибка', () => {
  const r = run(['list', PROJECT], { home: path.join(BASE, 'empty-home') });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /No skills found\./);
});

test('update: общая установка скопирована, в проекте — ссылки на скилы, скрипты и конфиги', () => {
  const r = run(['update', PROJECT]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Global dir updated/);
  assert.match(r.out, /Skill junctions recreated/);
  assert.match(r.out, /Script junction recreated/);
  assert.match(r.out, /Config junction recreated/);

  assert.ok(fs.existsSync(path.join(HOME, 'skills', 'coach', 'SKILL.md')), 'общая копия скила есть');
  assert.ok(isLink(path.join(SKILLS, 'coach')), 'скил в проекте — ссылка');
  assert.ok(isLink(SCRIPTS), 'скрипты в проекте — ссылка');
  assert.ok(isLink(CONFIG), 'конфиги в проекте — ссылка');
  assert.ok(fs.existsSync(path.join(SKILLS, 'coach', 'SKILL.md')), 'через ссылку скил читается');
});

test('list: таблица со статусом каждого скила', () => {
  const r = run(['list', PROJECT]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Skill\s+Status/m);
  assert.match(r.out, /^coach\s+\S+/m);
});

test('eject: ссылка заменена копией, общая копия скила цела', () => {
  const r = run(['eject', 'coach', PROJECT]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Skill "coach" ejected/);

  const projectSkill = path.join(SKILLS, 'coach');
  assert.equal(isLink(projectSkill), false, 'в проекте теперь настоящий каталог');
  assert.ok(fs.existsSync(path.join(projectSkill, 'SKILL.md')), 'копия содержит скил');
  assert.ok(
    fs.existsSync(path.join(HOME, 'skills', 'coach', 'SKILL.md')),
    'общая копия не тронута: снятие ссылки не прошло внутрь цели'
  );

  const listed = run(['list', PROJECT]);
  assert.match(listed.out, /^coach\s+(?!shared)\S+/m, 'статус скила сменился');

  // kilo 7.7.x читает проектный .kilocode/skills только внутри проекта: без
  // ссылки на копию он брал бы версию канона из своего каталога настроек.
  const kiloSkill = path.join(KILOCODE_SKILLS, 'coach');
  assert.ok(isLink(kiloSkill), '.kilocode/skills/coach — ссылка на проектную копию');
  assert.equal(fs.realpathSync.native(kiloSkill), fs.realpathSync.native(projectSkill));
  assert.match(r.out, /\.kilocode\/skills synced \(project-local: coach\)/);
});

test('eject без имени скила — код 1 и понятная ошибка', () => {
  const r = run(['eject']);
  assert.equal(r.code, 1);
  assert.match(r.err, /skill name is required/);
});

test('eject-scripts и eject-configs: ссылки заменены копиями, общие копии целы', () => {
  const s = run(['eject-scripts', PROJECT]);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /Scripts ejected/);
  assert.equal(isLink(SCRIPTS), false);
  assert.ok(fs.readdirSync(SCRIPTS).length > 0, 'скрипты скопированы');
  assert.ok(fs.readdirSync(path.join(HOME, 'scripts')).length > 0, 'общие скрипты на месте');

  const c = run(['eject-configs', PROJECT]);
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /Configs ejected/);
  assert.equal(isLink(CONFIG), false);
  assert.ok(fs.readdirSync(CONFIG).length > 0, 'конфиги скопированы');
  assert.ok(fs.readdirSync(path.join(HOME, 'configs')).length > 0, 'общие конфиги на месте');
});

test('прямой запуск node src/cli.mjs version печатает версию', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const r = run(['version'], { entry: CLI, cwd: BASE });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), `workflow-ai v${pkg.version}`);
});

test('флаг без значения и флаг со значением разбираются: init --force в новый каталог', () => {
  const target = path.join(BASE, 'fresh');
  fs.mkdirSync(target);
  const r = run(['init', target, '--force'], { cwd: BASE });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Initialization completed/);
  // init создаёт те же ссылки — снять до общей уборки.
  const skills = path.join(target, '.workflow', 'src', 'skills');
  if (fs.existsSync(skills)) {
    for (const name of fs.readdirSync(skills)) unlinkOnly(path.join(skills, name));
  }
  for (const p of [
    path.join(target, '.kilocode', 'skills'),
    path.join(target, '.workflow', 'src', 'scripts'),
    path.join(target, '.workflow', 'config'),
    path.join(target, '.workflow', 'src', 'rails'),
  ]) {
    unlinkOnly(p);
  }
});
