import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { realpathDeep, isInside, matchesGlob, PATH_SEP } from '../rails/paths.mjs';
import { createJunction } from '../junction-manager.mjs';

const IS_WIN32 = process.platform === 'win32';

// Фикстура: `<root>/.workflow/src/skills/coach` — junction (win32) / symlink
// (иначе) на канонический каталог `<canon>/coach`, ровно как §2 спецификации
// описывает подключение скилов. `withFixture` даёт оба: project-путь через
// junction и канонический путь напрямую.
function withFixture(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-paths-'));
  try {
    const root = join(base, 'root');
    const canon = join(base, 'canon');
    const skillsDir = join(root, '.workflow', 'src', 'skills');
    const railsDir = join(root, '.workflow', 'src', 'rails');
    const canonCoach = join(canon, 'coach');

    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(railsDir, { recursive: true });
    mkdirSync(canonCoach, { recursive: true });
    writeFileSync(join(canonCoach, 'SKILL.md'), '# coach');
    writeFileSync(join(canonCoach, 'rails.yaml'), 'version: 1');
    writeFileSync(join(railsDir, 'core.mjs'), '// rails core');

    // Соседний каталог с префиксным совпадением имени — ловушка для
    // строкового сравнения ("skills" vs "skillsX").
    mkdirSync(join(root, '.workflow', 'src', 'skillsX'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'src', 'skillsX', 'outside.md'), 'вне области');

    createJunction(canonCoach, join(skillsDir, 'coach'));

    fn({ root, canon, canonCoach, skillsDir, railsDir });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// --- realpathDeep ------------------------------------------------------------

test('realpathDeep: несуществующий файл — realpath предка + остаток', () => {
  withFixture(({ root }) => {
    const nested = join(root, '.workflow', 'src', 'skills', 'nope.md');
    const result = realpathDeep(nested);
    const expectedParent = realpathSync.native(join(root, '.workflow', 'src', 'skills'));
    assert.equal(result, join(expectedParent, 'nope.md'));
  });
});

test('realpathDeep: раскрывает junction/symlink до канонического пути', () => {
  withFixture(({ skillsDir, canonCoach }) => {
    const viaProject = realpathDeep(join(skillsDir, 'coach', 'SKILL.md'));
    const viaCanon = realpathSync.native(join(canonCoach, 'SKILL.md'));
    assert.equal(viaProject, viaCanon);
  });
});

test('realpathDeep: нестроковый/пустой вход — понятная ошибка, не TypeError вглубь fs', () => {
  assert.throws(() => realpathDeep(undefined), /непустой строковый путь/);
  assert.throws(() => realpathDeep(null), /непустой строковый путь/);
  assert.throws(() => realpathDeep(''), /непустой строковый путь/);
});

test('realpathDeep: регистр пути на win32 не влияет на результат', { skip: !IS_WIN32 }, () => {
  withFixture(({ canonCoach }) => {
    const lower = realpathDeep(join(canonCoach, 'skill.md').toLowerCase());
    const upper = realpathDeep(join(canonCoach, 'SKILL.MD').toUpperCase());
    assert.equal(lower.toLowerCase(), upper.toLowerCase());
  });
});

// --- isInside ------------------------------------------------------------------

test('isInside: файл скила, подключённого junction, — внутри проектной области (blocker-регресс)', () => {
  withFixture(({ skillsDir }) => {
    const file = join(skillsDir, 'coach', 'SKILL.md');
    assert.equal(isInside(file, skillsDir), true);
  });
});

test('isInside: тот же файл по каноническому пути — тоже внутри проектной области', () => {
  withFixture(({ skillsDir, canonCoach }) => {
    const file = join(canonCoach, 'SKILL.md');
    assert.equal(isInside(file, skillsDir), true);
  });
});

test('isInside: соседний каталог с префиксным совпадением имени не считается внутри ("skills" vs "skillsX")', () => {
  withFixture(({ root, skillsDir }) => {
    const outside = join(root, '.workflow', 'src', 'skillsX', 'outside.md');
    assert.equal(isInside(outside, skillsDir), false);
  });
});

test('isInside: не существующая ещё цель (Write) — по realpath ближайшего предка', () => {
  withFixture(({ skillsDir }) => {
    const newFile = join(skillsDir, 'coach', 'new-file.md');
    assert.equal(isInside(newFile, skillsDir), true);
  });
});

// --- matchesGlob -----------------------------------------------------------------

test('matchesGlob: "**" в конце сопоставляет файл скила через junction (проектный путь)', () => {
  withFixture(({ root, skillsDir }) => {
    const target = realpathDeep(join(skillsDir, 'coach', 'SKILL.md'));
    assert.equal(matchesGlob(target, '.workflow/src/skills/**', root), true);
  });
});

test('matchesGlob: "**" в конце сопоставляет тот же файл через канонический путь', () => {
  withFixture(({ root, canonCoach }) => {
    const target = realpathDeep(join(canonCoach, 'SKILL.md'));
    assert.equal(matchesGlob(target, '.workflow/src/skills/**', root), true);
  });
});

test('matchesGlob: write_deny — точный файл без wildcard, доступный только через junction', () => {
  withFixture(({ root, skillsDir }) => {
    const target = realpathDeep(join(skillsDir, 'coach', 'rails.yaml'));
    assert.equal(matchesGlob(target, '.workflow/src/skills/coach/rails.yaml', root), true);
  });
});

test('matchesGlob: write_deny — абсолютный паттерн', () => {
  withFixture(({ root, railsDir }) => {
    const target = realpathDeep(join(railsDir, 'core.mjs'));
    const absPattern = join(root, '.workflow', 'src', 'rails', '**');
    // root второй раз передаётся для относительных паттернов — здесь
    // паттерн абсолютный, root игнорируется.
    assert.equal(matchesGlob(target, absPattern, '/never/used'), true);
  });
});

test('matchesGlob: "**" в середине паттерна', () => {
  withFixture(({ root }) => {
    const deep = join(root, '.workflow', 'a', 'b', 'target.yaml');
    mkdirSync(join(root, '.workflow', 'a', 'b'), { recursive: true });
    writeFileSync(deep, 'x');
    const target = realpathDeep(deep);
    assert.equal(matchesGlob(target, '.workflow/**/target.yaml', root), true);
  });
});

// major-находка ревью: обход "**" останавливался на самой ссылке и не
// заходил внутрь junction/symlink — паттерн вида "skills/**/<подкаталог>/**"
// молча не находил файл на 2+ уровня глубже корня ссылки (пропуск гарда в
// write_deny/stage_actions, ложный отказ в write_scope).
test('matchesGlob: "**" находит файл на 2+ уровня ГЛУБЖЕ junction (регресс: обход не должен останавливаться на самой ссылке)', () => {
  withFixture(({ root, canonCoach }) => {
    const deep = join(canonCoach, 'tests', 'cases', 'TC-1.yaml');
    mkdirSync(join(canonCoach, 'tests', 'cases'), { recursive: true });
    writeFileSync(deep, 'id: TC-1');
    const target = realpathDeep(deep);
    assert.equal(matchesGlob(target, '.workflow/src/skills/**/cases/**', root), true);
  });
});

// major-находка ревью: isInside/хвостовой "**" всегда полностью обходили
// поддерево до сравнения (§7, бюджет 200 мс на решение) — измерено на
// os.tmpdir(): 300–684 мс. Порог здесь щедрый (не привязан к конкретным мс
// той машины), но ловит регресс "обход снова стал O(размер поддерева)".
test('isInside: не обходит всё поддерево обычных (не-ссылка) каталогов — быстрый отказ на большом дереве без совпадения', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-paths-perf-'));
  try {
    // Плоское "дерево" из полутысячи обычных подкаталогов — ни один не
    // ссылка, значит ни один не должен вызвать realpath внутри обхода.
    for (let i = 0; i < 500; i++) {
      mkdirSync(join(base, `d${i}`), { recursive: true });
    }
    const outside = join(tmpdir(), `rails-paths-perf-outside-${process.pid}-${Date.now()}.txt`);
    writeFileSync(outside, 'x');
    try {
      const start = Date.now();
      const result = isInside(outside, base);
      const elapsed = Date.now() - start;
      assert.equal(result, false);
      assert.ok(elapsed < 1000, `isInside заняло ${elapsed} мс на дереве из 500 обычных каталогов`);
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('matchesGlob: файл вне scope -> false', () => {
  withFixture(({ root, skillsDir }) => {
    const outside = join(root, '.workflow', 'src', 'skillsX', 'outside.md');
    const target = realpathDeep(outside);
    assert.equal(matchesGlob(target, '.workflow/src/skills/**', root), false);
    void skillsDir;
  });
});

// "?" не входит в grammar паттернов (§2, §4 — только "*"/"**"): экранируется
// как буквальный символ, а не превращается в regex-квантификатор "прошлый
// символ необязателен" (тогда паттерн "a?.md" ловил бы и "a.md", и "ab.md",
// чего быть не должно). На POSIX "?" — валидный символ имени файла, поэтому
// там проверяется и позитивный, и негативный случай; на Windows такое имя
// создать нельзя (запрещённый символ ФС) — там квантификатор проявил бы
// себя ложным совпадением с "a.md"/"ab.md", это и проверяется.
test('matchesGlob: "?" в паттерне — буквальный символ (POSIX: точное совпадение по имени)', { skip: IS_WIN32 }, () => {
  withFixture(({ root }) => {
    mkdirSync(join(root, '.workflow', 'q'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'q', 'a?.md'), 'x');
    writeFileSync(join(root, '.workflow', 'q', 'ab.md'), 'x');
    const withMark = realpathDeep(join(root, '.workflow', 'q', 'a?.md'));
    const withoutMark = realpathDeep(join(root, '.workflow', 'q', 'ab.md'));
    assert.equal(matchesGlob(withMark, '.workflow/q/a?.md', root), true);
    assert.equal(matchesGlob(withoutMark, '.workflow/q/a?.md', root), false);
  });
});

test('matchesGlob: "?" в паттерне не ведёт себя как regex-квантификатор (win32: "a.md"/"ab.md" не совпадают с "a?.md")', { skip: !IS_WIN32 }, () => {
  withFixture(({ root }) => {
    mkdirSync(join(root, '.workflow', 'q'), { recursive: true });
    writeFileSync(join(root, '.workflow', 'q', 'a.md'), 'x');
    writeFileSync(join(root, '.workflow', 'q', 'ab.md'), 'x');
    const aMd = realpathDeep(join(root, '.workflow', 'q', 'a.md'));
    const abMd = realpathDeep(join(root, '.workflow', 'q', 'ab.md'));
    assert.equal(matchesGlob(aMd, '.workflow/q/a?.md', root), false);
    assert.equal(matchesGlob(abMd, '.workflow/q/a?.md', root), false);
  });
});

// --- isInside followLinks:false и глубина фиксированных сегментов (2026-09-22) ---

test('isInside: followLinks=false — совпадение по префиксу realpath без обхода поддерева', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-paths-fl-'));
  try {
    const dir = join(base, 'dir');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    for (let i = 0; i < 300; i += 1) mkdirSync(join(dir, `d${i}`, 'x'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'f.txt'), 'x');
    writeFileSync(join(base, 'outside.txt'), 'x');
    assert.equal(isInside(join(dir, 'sub', 'f.txt'), dir, { followLinks: false }), true);
    const t0 = performance.now();
    assert.equal(isInside(join(base, 'outside.txt'), dir, { followLinks: false }), false);
    assert.ok(performance.now() - t0 < 200, 'промах без обхода обязан укладываться в бюджет 200 мс');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('matchesGlob: фиксированные сегменты не расходуют глубину — паттерн под каталогом глубиной 12 раскрывается', () => {
  const base = mkdtempSync(join(tmpdir(), 'rails-paths-deep-'));
  try {
    const deep = join(base, ...Array.from({ length: 12 }, (_, i) => `l${i}`));
    mkdirSync(join(deep, 'skills', 'a'), { recursive: true });
    writeFileSync(join(deep, 'skills', 'a', 'f.md'), 'x');
    const real = realpathDeep(join(deep, 'skills', 'a', 'f.md'));
    assert.equal(matchesGlob(real, 'skills/**', deep), true);
    assert.equal(matchesGlob(real, 'skills/*/f.md', deep), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- PATH_SEP (просто экспортирован, sanity) -------------------------------

test('PATH_SEP: разделитель текущей платформы', () => {
  assert.equal(PATH_SEP, IS_WIN32 ? '\\' : '/');
});
