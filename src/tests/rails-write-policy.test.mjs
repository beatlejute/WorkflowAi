import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { classifyWrites, WritePolicyError } from '../rails/write-policy.mjs';
import { realpathDeep } from '../rails/paths.mjs';

function fixture(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rails-policy-'));
  const root = join(base, 'project');
  const canon = join(base, 'canon');
  const skill = join(root, '.workflow', 'src', 'skills', 'coach');
  const links = [];
  mkdirSync(skill, { recursive: true });
  mkdirSync(canon);
  writeFileSync(join(skill, 'rails.yaml'), 'version: 1');
  writeFileSync(join(canon, 'SKILL.md'), '# canonical');
  const policy = join(root, '.workflow', 'rails-policy.yaml');
  const configure = (maintenance) => writeFileSync(policy, JSON.stringify({
    version: 1, canonical_skill_roots: [canon], ...(maintenance ? { maintenance } : {}),
  }));
  configure();
  const target = (display) => ({ display, real: realpathDeep(display) });
  const link = (destination, path) => {
    symlinkSync(destination, path, 'junction');
    links.push(path);
  };
  try {
    fn({ root, canon, skill, policy, configure, target, link });
  } finally {
    for (const path of links.reverse()) unlinkSync(path);
    rmSync(base, { recursive: true, force: true });
  }
}

test('independent local skill: existing rules and new files are unrestricted', () => fixture(({ root, skill, target }) => {
  for (const name of ['rails.yaml', 'tests/rails/new.test.mjs', 'workflows/new.md']) {
    const t = target(join(skill, name));
    assert.ok(classifyWrites(root, [t], 'write', root, 'coach').unrestricted.has(t.real));
  }
}));

test('relative paths use the actual caller directory', () => fixture(({ root, skill, target }) => {
  const t = target(join(skill, 'rails.yaml'));
  t.display = relative(root, t.display);
  assert.ok(classifyWrites(root, [t], 'edit', root, 'coach').unrestricted.has(t.real));
}));

test('direct canonical and mixed writes are denied', () => fixture(({ root, canon, skill, target }) => {
  const canonical = target(join(canon, 'SKILL.md'));
  assert.throws(() => classifyWrites(root, [canonical], 'write'), WritePolicyError);
  assert.throws(() => classifyWrites(root, [target(join(skill, 'rails.yaml')), canonical], 'edit'), WritePolicyError);
}));

test('nested junction and new files below it never get local permission', () => fixture(({ root, canon, skill, target, link }) => {
  const nested = join(skill, 'shared');
  link(canon, nested);
  for (const path of [join(nested, 'new.md'), join(skill, 'rails.yaml')]) {
    assert.throws(() => classifyWrites(root, [target(path)], 'write'), WritePolicyError);
  }
}));

test('hardlinked files invalidate independence of the whole skill', () => fixture(({ root, canon, skill, target }) => {
  linkSync(join(canon, 'SKILL.md'), join(skill, 'shared.md'));
  assert.throws(() => classifyWrites(root, [target(join(skill, 'rails.yaml'))], 'edit'), WritePolicyError);
}));

test('undetermined write target gets no exemption and is left to the mode layer', () => fixture(({ root }) => {
  assert.equal(classifyWrites(root, [{ marker: true }], 'shell').unrestricted.size, 0);
  assert.equal(classifyWrites(root, [{ marker: true }], 'edit').unrestricted.size, 0);
}));

test('malformed policy fails closed', () => fixture(({ root, policy, skill, target }) => {
  writeFileSync(policy, '{');
  assert.throws(() => classifyWrites(root, [target(join(skill, 'rails.yaml'))], 'write'), WritePolicyError);
}));

test('maintenance is exact, expiring and cannot grant policy writes', () => fixture(({ root, canon, policy, configure, target }) => {
  const path = join(canon, 'SKILL.md');
  configure({ expires_at: '2999-01-01T00:00:00Z', write_paths: [path] });
  assert.ok(classifyWrites(root, [target(path)], 'edit', root, 'coach').unrestricted.has(realpathDeep(path)));
  assert.throws(() => classifyWrites(root, [target(path + '.backup')], 'edit'), WritePolicyError);
  configure({ expires_at: '2000-01-01T00:00:00Z', write_paths: [path] });
  assert.throws(() => classifyWrites(root, [target(path)], 'edit'), WritePolicyError);
  configure({ expires_at: '2999-01-01T00:00:00Z', write_paths: [policy] });
  assert.throws(() => classifyWrites(root, [target(path)], 'edit'), WritePolicyError);
}));

test('ordinary project files and shell writes do not receive edit exemptions', () => fixture(({ root, target }) => {
  const t = target(join(root, 'README.md'));
  assert.equal(classifyWrites(root, [t], 'write').unrestricted.size, 0);
  assert.equal(classifyWrites(root, [t], 'shell').unrestricted.size, 0);
}));

test('hardlink в дереве продукта на канонический файл — отказ (ревью 2026-10-05)', () => fixture(({ root, canon, target }) => {
  const productDir = join(root, 'src');
  mkdirSync(productDir, { recursive: true });
  const alias = join(productDir, 'alias.md');
  linkSync(join(canon, 'SKILL.md'), alias);
  assert.throws(() => classifyWrites(root, [target(alias)], 'edit'), /общий файл/);
}));

test('первый Write нового скила разрешён коучу, пока каталог скилов не ведёт в канон', () => fixture(({ root, target }) => {
  const t = target(join(root, '.workflow', 'src', 'skills', 'new-skill', 'SKILL.md'));
  assert.ok(classifyWrites(root, [t], 'write', root, 'coach').unrestricted.has(t.real));
}));

test('каталог скилов — ссылка в канон: новый скил в канон не пишется', () => fixture(({ root, canon, link }) => {
  const mount = join(root, '.workflow', 'src', 'skills-linked');
  link(canon, mount);
  const t = { display: join(mount, 'new-skill', 'SKILL.md'), real: realpathDeep(join(mount, 'new-skill', 'SKILL.md')) };
  assert.throws(() => classifyWrites(root, [t], 'write'), /каноническая цель защищена/);
}));

test('независимая копия и новый скил открываются только авторизованному скилу (коучу)', () => fixture(({ root, skill, target }) => {
  const existing = target(join(skill, 'rails.yaml'));
  assert.throws(() => classifyWrites(root, [existing], 'edit', root, 'execute-task'), /не является независимой локальной копией/);
  const fresh = target(join(root, '.workflow', 'src', 'skills', 'new-skill', 'SKILL.md'));
  assert.throws(() => classifyWrites(root, [fresh], 'write', root, 'execute-task'), /не является независимой локальной копией/);
  assert.throws(() => classifyWrites(root, [existing], 'edit', root, null), /не является независимой локальной копией/);
}));

test('shell без скила сессии (executor) в независимую копию — отказ (ревью 2026-10-05, третий раунд)', () => fixture(({ root, skill, target }) => {
  const t = target(join(skill, 'SKILL.md'));
  assert.throws(() => classifyWrites(root, [t], 'shell', root, null), /не является независимой локальной копией/);
}));
