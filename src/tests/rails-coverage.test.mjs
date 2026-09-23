import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { extractInvariants, checkCoverage } from '../rails/coverage.mjs';
import { run as cliRun } from '../rails/cli.mjs';
import { createJunction } from '../junction-manager.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initGitRepo(root) {
  git(['init', '--quiet'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'Test'], root);
}

function commitAll(root, message) {
  git(['add', '-A'], root);
  git(['commit', '--quiet', '-m', message], root);
}

// --- extractInvariants (§12) --------------------------------------------------------

test('extractInvariants: строка с ⛔ даёт инвариант', () => {
  const text = 'Просто текст.\n⛔ Коуч не делает git-операции.\nЕщё строка.';
  const out = extractInvariants(text);
  assert.ok(out.some((s) => s.includes('Коуч не делает git-операции')));
});

test('extractInvariants: строка с ⚠️ даёт инвариант', () => {
  const out = extractInvariants('⚠️ Один план за раз в проекте.');
  assert.ok(out.some((s) => s.includes('Один план за раз')));
});

test('extractInvariants: жирный текст **...** даёт инвариант', () => {
  const out = extractInvariants('Важно: **никогда не удалять junction рекурсивно**.');
  assert.ok(out.some((s) => s.includes('никогда не удалять junction рекурсивно')));
});

test('extractInvariants: дата в формате ГГГГ-ММ-ДД даёт инвариант', () => {
  const out = extractInvariants('Инцидент произошёл 2026-09-21 и был исправлен.');
  assert.ok(out.some((s) => s.includes('2026-09-21')));
});

test('extractInvariants: дата в формате ДД.ММ.ГГГГ даёт инвариант', () => {
  const out = extractInvariants('Событие датировано 21.09.2026 годом.');
  assert.ok(out.some((s) => s.includes('21.09.2026')));
});

test('extractInvariants: строка таблицы маршрутизации/загрузки даёт инвариант целиком, шапка и разделитель — нет', () => {
  const text = ['## Загрузка знаний', '| Что | Где |', '|---|---|', '| Корень | .workflow/ |'].join('\n');
  const out = extractInvariants(text);
  assert.ok(out.includes('| Корень | .workflow/ |'));
  assert.ok(!out.includes('| Что | Где |'), 'строка-шапка таблицы не инвариант');
  assert.ok(!out.some((s) => /^\|[\s:|-]+\|$/.test(s)), 'строка-разделитель не должна попадать в инварианты');
});

test('extractInvariants: таблица под посторонним заголовком (не маршрутизация/загрузка/шаблоны) не даёт инвариантов', () => {
  const text = ['## Метрики', '| Метрика | Как считать |', '|---|---|', '| Полнота | % тикетов |'].join('\n');
  const out = extractInvariants(text);
  assert.deepEqual(out, []);
});

test('extractInvariants: обычная строка без маркеров -> ничего', () => {
  const out = extractInvariants('Обычный абзац без особых примет вообще.');
  assert.deepEqual(out, []);
});

test('extractInvariants: строка с несколькими предложениями и маркером -> оба предложения', () => {
  const out = extractInvariants('⛔ Первое предложение с запретом. Второе предложение рядом с ним.');
  assert.ok(out.some((s) => s.startsWith('⛔ Первое предложение')));
  assert.ok(out.some((s) => s.startsWith('Второе предложение рядом')));
});

// --- checkCoverage: базовая версия vs текущая ---------------------------------------

function setupRepo() {
  const base = mkdtempSync(join(tmpdir(), 'rails-coverage-'));
  const root = join(base, 'root');
  const skillDir = join(root, '.workflow', 'src', 'skills', 'covtest');
  mkdirSync(skillDir, { recursive: true });
  initGitRepo(root);
  return { base, root, skillDir };
}

test('checkCoverage: фраза-инвариант из базовой версии, дословно оставшаяся в текущей, -> covered (via content)', () => {
  const { base, root, skillDir } = setupRepo();
  try {
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '# Коуч\n\n⛔ Коуч не выполняет git-операции — коммит делает исключительно пользователь.\n',
      'utf8'
    );
    commitAll(root, 'baseline');
    const baselineRef = git(['rev-parse', 'HEAD'], root).trim();

    // Текущая версия — граф вместо прозы, но фраза дословно осталась в rails.yaml как incident.
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '# Коуч\n\n```mermaid\ngraph TD\n    P1E1["П1 ВХОД: начало"]\n```\n',
      'utf8'
    );
    writeFileSync(
      join(skillDir, 'rails.yaml'),
      [
        'version: 1',
        'skill: covtest',
        'entry: P1E1',
        'deny_shell:',
        '  - pattern: "git (commit|push)"',
        '    reason: "запрет"',
        '    incident: "Коуч не выполняет git-операции — коммит делает исключительно пользователь"',
        '',
      ].join('\n'),
      'utf8'
    );

    const { covered, missing } = checkCoverage({ root, skill: 'covtest', baselineRef });
    assert.equal(missing.length, 0);
    assert.ok(covered.some((c) => c.via === 'content'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('checkCoverage: фраза отсутствует и в текущих файлах, и в карте -> missing', () => {
  const { base, root, skillDir } = setupRepo();
  try {
    writeFileSync(join(skillDir, 'SKILL.md'), '# Коуч\n\n⛔ Эта фраза потеряется при конверсии в граф насовсем.\n', 'utf8');
    commitAll(root, 'baseline');
    const baselineRef = git(['rev-parse', 'HEAD'], root).trim();

    writeFileSync(join(skillDir, 'SKILL.md'), '# Коуч\n\n```mermaid\ngraph TD\n    P1E1["П1 ВХОД: начало"]\n```\n', 'utf8');

    const { missing } = checkCoverage({ root, skill: 'covtest', baselineRef });
    assert.equal(missing.length, 1);
    assert.match(missing[0], /потеряется при конверсии/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('checkCoverage: фраза, явно перечисленная в карте --map, -> covered (via map), даже если её нет в текущих файлах', () => {
  const { base, root, skillDir } = setupRepo();
  try {
    writeFileSync(join(skillDir, 'SKILL.md'), '# Коуч\n\n⛔ Фраза без прямого следа в новом графе вовсе.\n', 'utf8');
    commitAll(root, 'baseline');
    const baselineRef = git(['rev-parse', 'HEAD'], root).trim();

    writeFileSync(join(skillDir, 'SKILL.md'), '# Коуч\n\n```mermaid\ngraph TD\n    P1E1["П1 ВХОД: начало"]\n```\n', 'utf8');

    const mapFile = join(base, 'rails-migration.yaml');
    writeFileSync(
      mapFile,
      'phrases:\n' /* заведомо неправильный верхний ключ проигнорируется ниже — используем плоскую карту */,
      'utf8'
    );
    // Карта — плоское отображение phrase -> target (см. §12): перезаписываем плоским YAML.
    writeFileSync(
      mapFile,
      [
        '"⛔ Фраза без прямого следа в новом графе вовсе.": "dropped: сознательно убрано, покрыто правилом P1E1"',
        '',
      ].join('\n'),
      'utf8'
    );

    const { covered, missing } = checkCoverage({ root, skill: 'covtest', baselineRef, mapFile });
    assert.equal(missing.length, 0);
    assert.equal(covered.length, 1);
    assert.equal(covered[0].via, 'map');
    assert.match(String(covered[0].target), /dropped:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('checkCoverage: baselineRef не существует -> бросает (не молчит про пустое покрытие, blocker-фикс)', () => {
  const { base, root, skillDir } = setupRepo();
  try {
    writeFileSync(join(skillDir, 'SKILL.md'), '# Коуч\n', 'utf8');
    commitAll(root, 'init');
    assert.throws(
      () => checkCoverage({ root, skill: 'covtest', baselineRef: 'does-not-exist' }),
      /baseline не содержит файлов скила/
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('checkCoverage: каталог скила не найден вовсе -> бросает', () => {
  const { base, root } = setupRepo();
  try {
    assert.throws(
      () => checkCoverage({ root, skill: 'no-such-skill', baselineRef: 'HEAD' }),
      /baseline не содержит файлов скила/
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- blocker-фикс: путь базовой версии — src/skills/<skill> от git-toplevel ---------
//
// В каноническом репозитории `.workflow/` в .gitignore, а `.workflow/src/skills/<skill>`
// в проекте — junction на канон (§2, §12). Раньше coverage.mjs читал baseline по
// жёстко зашитому `.workflow/src/skills/<skill>` относительно `root` — для такой
// раскладки git ничего не находил (0 файлов), и «покрытие» молча оказывалось 0/0
// вместо ошибки. Тест воспроизводит реальную раскладку: канонический git-репозиторий
// с `src/skills/<skill>/SKILL.md`, и `root/.workflow/src/skills/<skill>` — junction
// на него.

function setupJunctionRepo() {
  const base = mkdtempSync(join(tmpdir(), 'rails-coverage-junction-'));
  const canonRoot = join(base, 'canon');
  const canonSkillDir = join(canonRoot, 'src', 'skills', 'covtest');
  mkdirSync(canonSkillDir, { recursive: true });
  initGitRepo(canonRoot);

  const root = join(base, 'root');
  const projectSkillDir = join(root, '.workflow', 'src', 'skills', 'covtest');
  mkdirSync(join(root, '.workflow', 'src', 'skills'), { recursive: true });

  return { base, canonRoot, canonSkillDir, root, projectSkillDir };
}

test('checkCoverage: канон подключён junction — базовая версия читается по src/skills/<skill> от git-toplevel канона', () => {
  const { base, canonRoot, canonSkillDir, root, projectSkillDir } = setupJunctionRepo();
  try {
    writeFileSync(
      join(canonSkillDir, 'SKILL.md'),
      '# Коуч\n\n⛔ Коуч не выполняет git-операции — коммит делает исключительно пользователь.\n',
      'utf8'
    );
    commitAll(canonRoot, 'baseline');
    const baselineRef = git(['rev-parse', 'HEAD'], canonRoot).trim();

    createJunction(canonSkillDir, projectSkillDir);

    // Текущая версия (по ту же junction-цепочку) — граф вместо прозы, фраза
    // дословно осталась в rails.yaml как incident.
    writeFileSync(join(canonSkillDir, 'SKILL.md'), '# Коуч\n\n```mermaid\ngraph TD\n    P1E1["П1 ВХОД: начало"]\n```\n', 'utf8');
    writeFileSync(
      join(canonSkillDir, 'rails.yaml'),
      [
        'version: 1',
        'skill: covtest',
        'entry: P1E1',
        'deny_shell:',
        '  - pattern: "git (commit|push)"',
        '    reason: "запрет"',
        '    incident: "Коуч не выполняет git-операции — коммит делает исключительно пользователь"',
        '',
      ].join('\n'),
      'utf8'
    );

    const { covered, missing } = checkCoverage({ root, skill: 'covtest', baselineRef });
    assert.equal(missing.length, 0);
    assert.ok(covered.some((c) => c.via === 'content'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- через child_process: cli.mjs coverage -----------------------------------------

const CLI_PATH = join(process.cwd(), 'src', 'rails', 'cli.mjs');

function runCliProcess(args, cwd) {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout || '') + (err.stderr || '') };
  }
}

test('child_process: cli.mjs coverage на несуществующем baseline -> код выхода 1', () => {
  const { base, root, skillDir } = setupRepo();
  try {
    writeFileSync(join(skillDir, 'SKILL.md'), '# Коуч\n', 'utf8');
    commitAll(root, 'init');
    const r = runCliProcess(['coverage', '--skill', 'covtest', '--baseline', 'does-not-exist'], root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /baseline не содержит файлов скила/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('run: cli coverage на реальном временном git-репозитории -> код выхода 0 при полном покрытии', () => {
  const { base, root, skillDir } = setupRepo();
  try {
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '# Коуч\n\n⛔ Коуч не выполняет git-операции — коммит делает исключительно пользователь.\n',
      'utf8'
    );
    commitAll(root, 'baseline');
    const baselineRef = git(['rev-parse', 'HEAD'], root).trim();

    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '# Коуч\n\n```mermaid\ngraph TD\n    P1E1["П1 ВХОД: начало"]\n```\n',
      'utf8'
    );
    writeFileSync(
      join(skillDir, 'rails.yaml'),
      [
        'version: 1',
        'skill: covtest',
        'entry: P1E1',
        'deny_shell:',
        '  - pattern: "git (commit|push)"',
        '    reason: "запрет"',
        '    incident: "Коуч не выполняет git-операции — коммит делает исключительно пользователь"',
        '',
      ].join('\n'),
      'utf8'
    );

    const r = cliRun(['coverage', '--skill', 'covtest', '--baseline', baselineRef], { cwd: root, env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Пропущено: 0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- minor-фикс: ветка «есть непокрытые фразы» команды coverage (код выхода 1) -----
//
// Раньше эта ветка (cli.mjs cmdCoverage, missing.length > 0) не была покрыта тестом
// ни через run(), ни через child_process: существующие тесты проверяли только полное
// покрытие (код 0) и ошибку baseline (код 1 по другой причине — исключение
// checkCoverage, не список пропущенных фраз).

test('run: cli coverage при непокрытой фразе -> код выхода 1 и список «Непокрытые фразы:»', () => {
  const { base, root, skillDir } = setupRepo();
  try {
    writeFileSync(join(skillDir, 'SKILL.md'), '# Коуч\n\n⛔ Эта фраза потеряется при конверсии в граф насовсем.\n', 'utf8');
    commitAll(root, 'baseline');
    const baselineRef = git(['rev-parse', 'HEAD'], root).trim();

    writeFileSync(join(skillDir, 'SKILL.md'), '# Коуч\n\n```mermaid\ngraph TD\n    P1E1["П1 ВХОД: начало"]\n```\n', 'utf8');

    const r = cliRun(['coverage', '--skill', 'covtest', '--baseline', baselineRef], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Пропущено: 1/);
    assert.match(r.stdout, /Непокрытые фразы:/);
    assert.match(r.stdout, /потеряется при конверсии/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- карта --map: поиск и умолчание (прогон коуча 2026-09-22) ----------------------
//
// `--map rails-migration.yaml` из корня проекта резолвился от cwd в несуществующий файл,
// loadMap молча отдавал пустую карту: 151/200 вместо 200/200 без слова об ошибке.

function setupMappedRepo() {
  const { base, root, skillDir } = setupRepo();
  writeFileSync(join(skillDir, 'SKILL.md'), '# Коуч\n\n⛔ Фраза без прямого следа в новом графе вовсе.\n', 'utf8');
  commitAll(root, 'baseline');
  const baselineRef = git(['rev-parse', 'HEAD'], root).trim();
  writeFileSync(join(skillDir, 'SKILL.md'), '# Коуч\n\n```mermaid\ngraph TD\n    P1E1["П1 ВХОД: начало"]\n```\n', 'utf8');
  writeFileSync(
    join(skillDir, 'rails-migration.yaml'),
    '"⛔ Фраза без прямого следа в новом графе вовсе.": "dropped: покрыто P1E1"\n',
    'utf8'
  );
  return { base, root, skillDir, baselineRef };
}

test('run: cli coverage без --map берёт rails-migration.yaml скила и печатает «Карта:»', () => {
  const { base, root, skillDir, baselineRef } = setupMappedRepo();
  try {
    const r = cliRun(['coverage', '--skill', 'covtest', '--baseline', baselineRef], { cwd: root, env: {} });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Пропущено: 0/);
    assert.ok(r.stdout.includes(`Карта: ${join(skillDir, 'rails-migration.yaml')}`), r.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('run: cli coverage --map с именем файла из корня проекта -> найден в каталоге скила', () => {
  const { base, root, baselineRef } = setupMappedRepo();
  try {
    const r = cliRun(['coverage', '--skill', 'covtest', '--baseline', baselineRef, '--map', 'rails-migration.yaml'], { cwd: root, env: {} });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Пропущено: 0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('run: cli coverage --map на несуществующий файл -> код 1 и оба проверенных пути, а не молчаливая пустая карта', () => {
  const { base, root, baselineRef } = setupMappedRepo();
  try {
    const r = cliRun(['coverage', '--skill', 'covtest', '--baseline', baselineRef, '--map', 'no-such-map.yaml'], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /карта --map не найдена/);
    assert.match(r.stdout, /no-such-map\.yaml.*no-such-map\.yaml/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('run: cli coverage без --map и без rails-migration.yaml -> «Карта: нет», фраза вне графа — пропуск', () => {
  const { base, root, skillDir, baselineRef } = setupMappedRepo();
  try {
    rmSync(join(skillDir, 'rails-migration.yaml'));
    const r = cliRun(['coverage', '--skill', 'covtest', '--baseline', baselineRef], { cwd: root, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Карта: нет/);
    assert.match(r.stdout, /Пропущено: 1/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Конверсия execute-task (2026-09-23): строка режется на предложения по точке, и нумерация
// списка ограничений («8.», «9.», «10.») попадала в инварианты отдельными «требованиями».
// Покрыть такой обрывок нельзя ни лейблом узла, ни картой переноса (ключ карты — минимум
// 10 символов), поэтому гейт конверсии не закрывался ни при какой правке скила.
test('extractInvariants: обрывки разбора — нумерация и скобки — не инварианты', () => {
  const text = [
    '## Ограничения',
    '',
    '⛔ **Запрещено** делать это. 8. Второй пункт списка. 9.',
    '',
    '- **Пример:** формат `DEF-XXX-N`. 10.',
    '',
    '⛔ Да.',
  ].join('\n');
  const phrases = extractInvariants(text);
  for (const noise of ['8.', '9.', '10.', 'Да.']) {
    assert.equal(phrases.includes(noise), false, `обрывок «${noise}» инвариантом быть не должен`);
  }
  assert.ok(phrases.some((p) => p.includes('Запрещено')), JSON.stringify(phrases));
  assert.ok(phrases.some((p) => p.includes('Второй пункт списка')), JSON.stringify(phrases));
});
