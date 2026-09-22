// Тесты памяти «сессия → корень» (src/rails/session-memo.mjs).
// Файл — <WORKFLOW_HOME>/state/rails-sessions.json; здесь WORKFLOW_HOME
// подменяется на временный каталог для каждого теста.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { rememberSessionRoot, recallSessionRoot } from '../rails/session-memo.mjs';

function withHome(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-memo-'));
  const prev = process.env.WORKFLOW_HOME;
  process.env.WORKFLOW_HOME = join(base, 'home');
  try {
    fn({ base, memoFile: join(base, 'home', 'state', 'rails-sessions.json') });
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_HOME;
    else process.env.WORKFLOW_HOME = prev;
    rmSync(base, { recursive: true, force: true });
  }
}

function makeRoot(base, name) {
  const root = join(base, name);
  mkdirSync(join(root, '.workflow'), { recursive: true });
  return root;
}

test('remember/recall: корень возвращается по id сессии; файл — в <WORKFLOW_HOME>/state', () => {
  withHome(({ base, memoFile }) => {
    const root = makeRoot(base, 'proj');
    const sessionId = randomUUID();
    rememberSessionRoot(sessionId, root);
    assert.ok(existsSync(memoFile), 'файл памяти создан в WORKFLOW_HOME');
    assert.equal(recallSessionRoot(sessionId), root);
    assert.equal(recallSessionRoot(randomUUID()), null, 'неизвестная сессия — null');
    assert.equal(recallSessionRoot(''), null);
  });
});

test('recall: корень, у которого больше нет .workflow, не возвращается', () => {
  withHome(({ base }) => {
    const root = makeRoot(base, 'gone');
    const sessionId = randomUUID();
    rememberSessionRoot(sessionId, root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(recallSessionRoot(sessionId), null);
  });
});

test('remember: повторная запись того же корня не меняет файл', () => {
  withHome(({ base, memoFile }) => {
    const root = makeRoot(base, 'proj');
    const sessionId = randomUUID();
    rememberSessionRoot(sessionId, root);
    const before = readFileSync(memoFile, 'utf8');
    rememberSessionRoot(sessionId, root);
    assert.equal(readFileSync(memoFile, 'utf8'), before);
  });
});

test('remember: при переполнении первыми уходят записи с исчезнувшим корнем, живые сессии остаются', () => {
  withHome(({ base, memoFile }) => {
    const live = makeRoot(base, 'live');
    const liveSession = randomUUID();
    rememberSessionRoot(liveSession, live);

    // 60 одноразовых корней (как временные проекты тестов/раннера): каждый удаляется сразу после записи.
    for (let i = 0; i < 60; i++) {
      const tmpRoot = makeRoot(base, `tmp-${i}`);
      rememberSessionRoot(randomUUID(), tmpRoot);
      rmSync(tmpRoot, { recursive: true, force: true });
    }

    const memo = JSON.parse(readFileSync(memoFile, 'utf8'));
    assert.ok(Object.keys(memo).length <= 50, 'не больше 50 записей');
    assert.equal(recallSessionRoot(liveSession), live, 'живая сессия пережила поток временных корней');
    const deadKept = Object.values(memo).filter((e) => !existsSync(join(e.root, '.workflow'))).length;
    assert.ok(deadKept <= 1, `в файле остаётся не больше одной мёртвой записи (последняя записанная), есть ${deadKept}`);
  });
});

test('remember: при переполнении живыми записями уходят самые старые', () => {
  withHome(({ base, memoFile }) => {
    const first = randomUUID();
    rememberSessionRoot(first, makeRoot(base, 'p-first'));
    for (let i = 0; i < 55; i++) rememberSessionRoot(randomUUID(), makeRoot(base, `p-${i}`));
    const memo = JSON.parse(readFileSync(memoFile, 'utf8'));
    assert.equal(Object.keys(memo).length, 50);
    assert.equal(recallSessionRoot(first), null, 'самая старая запись вытеснена');
  });
});

test('remember: пустые аргументы игнорируются, файл не создаётся', () => {
  withHome(({ base, memoFile }) => {
    rememberSessionRoot('', makeRoot(base, 'x'));
    rememberSessionRoot(randomUUID(), '');
    assert.ok(!existsSync(memoFile));
  });
});
