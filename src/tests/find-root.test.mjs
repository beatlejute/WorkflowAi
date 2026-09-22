import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { findProjectRoot } from '../lib/find-root.mjs';

test('findProjectRoot finds .workflow/ in current directory', () => {
  const testDir = join(tmpdir(), 'find-root-test-current');
  
  try {
    // Setup: create temp dir with .workflow/
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, '.workflow'), { recursive: true });
    
    const result = findProjectRoot(testDir);
    assert.strictEqual(result, resolve(testDir));
  } finally {
    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('findProjectRoot finds .workflow/ in parent directory (walks up)', () => {
  const testDir = join(tmpdir(), 'find-root-test-parent');
  const nestedDir = join(testDir, 'level1', 'level2', 'level3');
  
  try {
    // Setup: create temp dir with .workflow/ and nested subdirs
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(join(testDir, '.workflow'), { recursive: true });
    
    const result = findProjectRoot(nestedDir);
    assert.strictEqual(result, resolve(testDir));
  } finally {
    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('findProjectRoot throws error when .workflow/ is not found', () => {
  const testDir = join(tmpdir(), 'find-root-test-notfound');
  
  try {
    // Setup: create temp dir without .workflow/
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    
    assert.throws(
      () => findProjectRoot(testDir),
      (err) => {
        assert.ok(err.message.includes('Could not find .workflow/ directory'));
        assert.ok(err.message.includes('Run "workflow init" first'));
        return true;
      }
    );
  } finally {
    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('findProjectRoot stops at filesystem root (no infinite loop)', () => {
  // This test verifies the function doesn't hang when searching from root
  // We use a path that will quickly reach the filesystem root
  const rootLikeDir = tmpdir(); // Start from temp dir, will walk up to root
  
  // The function should throw rather than loop infinitely
  assert.throws(
    () => findProjectRoot(rootLikeDir),
    (err) => {
      assert.ok(err.message.includes('Could not find .workflow/ directory'));
      return true;
    }
  );
});

test('findProjectRoot uses process.cwd() by default', () => {
  // Прежде тест звал функцию из корня репозитория и проходил только там, где в
  // нём лежит рабочая `.workflow/`; на чистом клоне (CI) падал. Теперь `cwd`
  // — временный проект, и проверяется, что найден именно он.
  const testDir = join(tmpdir(), `find-root-test-cwd-${Date.now()}`);
  const savedCwd = process.cwd();
  mkdirSync(join(testDir, '.workflow'), { recursive: true });
  try {
    process.chdir(testDir);
    // `process.cwd()` после chdir, а не `testDir`: на macOS временный каталог
    // лежит за симлинком `/var` → `/private/var`, и строки не совпали бы.
    assert.strictEqual(findProjectRoot(), process.cwd());
  } finally {
    process.chdir(savedCwd);
    rmSync(testDir, { recursive: true, force: true });
  }
});

// Глобальная директория ~/.workflow (или WORKFLOW_HOME) — установочный каталог,
// а не проект. Пока findProjectRoot считал её корнем, любой запуск из-под
// домашней папки уезжал туда: в ~/.workflow/logs/pipeline.log осели записи от
// тестовых песочниц, а сами тесты про «корень не найден» падали на машине,
// где глобальная директория создана.
test('findProjectRoot не принимает глобальную директорию за корень проекта', () => {
  const globalHome = join(tmpdir(), `find-root-global-${Date.now()}`);
  const globalDir = join(globalHome, '.workflow');
  const nested = join(globalHome, 'nested');
  const prevHome = process.env.WORKFLOW_HOME;

  try {
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(nested, { recursive: true });
    process.env.WORKFLOW_HOME = globalDir;

    let result = null;
    try {
      result = findProjectRoot(nested);
    } catch {
      // корень не найден — тоже корректный исход
    }

    assert.notStrictEqual(
      result,
      globalHome,
      'установочный каталог не должен становиться корнем проекта'
    );
  } finally {
    if (prevHome === undefined) {
      delete process.env.WORKFLOW_HOME;
    } else {
      process.env.WORKFLOW_HOME = prevHome;
    }
    rmSync(globalHome, { recursive: true, force: true });
  }
});

// `WORKFLOW_HOME` переопределён (тесты изолируют память сессий рельсов, второй
// профиль), а `~/.workflow` по-прежнему лежит на диске: без отдельного
// исключения умолчания домашний каталог снова становился корнем для всего под
// ним — включая os.tmpdir(), и тесты «корень не найден» падали.
test('findProjectRoot не принимает ~/.workflow за корень, даже когда WORKFLOW_HOME указывает в другое место', () => {
  const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const fakeHome = join(tmpdir(), `find-root-fake-home-${Date.now()}`);
  const nested = join(fakeHome, 'AppData', 'Local', 'Temp', 'sandbox');
  const otherGlobal = join(tmpdir(), `find-root-other-global-${Date.now()}`);
  const prevHome = process.env[homeVar];
  const prevWorkflowHome = process.env.WORKFLOW_HOME;

  try {
    mkdirSync(join(fakeHome, '.workflow'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(otherGlobal, { recursive: true });
    process.env[homeVar] = fakeHome;
    process.env.WORKFLOW_HOME = otherGlobal;

    let result = null;
    try {
      result = findProjectRoot(nested);
    } catch {
      // корень не найден — ожидаемый исход
    }
    if (result !== null) {
      assert.notStrictEqual(
        realpathSync.native(result).toLowerCase(),
        realpathSync.native(fakeHome).toLowerCase(),
        `домашний каталог принят за проект: ${result}`
      );
    }
  } finally {
    if (prevHome === undefined) delete process.env[homeVar];
    else process.env[homeVar] = prevHome;
    if (prevWorkflowHome === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = prevWorkflowHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(otherGlobal, { recursive: true, force: true });
  }
});

// На раннере GitHub `TEMP` — короткое имя 8.3 (`C:\Users\RUNNER~1\…`), а
// глобальный каталог — длинное (`C:\Users\runneradmin\.workflow`). Подъём
// от `TEMP` приходил к глобальному каталогу под коротким именем, строковое
// сравнение его не узнавало, и домашний каталог становился корнем проекта.
test('глобальный каталог узнаётся и по короткому имени 8.3', {
  skip: process.platform !== 'win32' && 'короткие имена 8.3 есть только на Windows'
}, (t) => {
  const home = join(tmpdir(), `find-root-long-home-directory-${Date.now()}`);
  const start = join(home, 'AppData', 'Local', 'Temp', 'job');
  const savedHome = process.env.WORKFLOW_HOME;
  mkdirSync(join(home, '.workflow'), { recursive: true });
  mkdirSync(start, { recursive: true });
  try {
    const shortStart = execSync(`cmd /c for %I in ("${start}") do @echo %~sI`, { encoding: 'utf8' }).trim();
    if (shortStart.toLowerCase() === start.toLowerCase()) {
      t.skip('на этом томе короткие имена 8.3 не создаются');
      return;
    }
    process.env.WORKFLOW_HOME = join(home, '.workflow');

    let found = null;
    try {
      found = findProjectRoot(shortStart);
    } catch {
      // Корня выше нет — тоже верный исход: глобальный каталог пропущен.
    }
    // Выше по дереву может лежать чужая `.workflow` (у разработчика — своя
    // `~/.workflow`), поэтому проверяется одно: найденный корень — не дом.
    if (found !== null) {
      assert.notStrictEqual(
        realpathSync.native(found).toLowerCase(),
        realpathSync.native(home).toLowerCase(),
        `домашний каталог принят за проект: ${found}`
      );
    }
  } finally {
    if (savedHome === undefined) {
      delete process.env.WORKFLOW_HOME;
    } else {
      process.env.WORKFLOW_HOME = savedHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
