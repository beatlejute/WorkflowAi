import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/verify-artifacts.js', import.meta.url));

function withProject(check) {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'human-scope-alias-')));
  const root = path.join(parent, 'project');
  const alias = path.join(parent, 'alias');
  const linkedSrc = path.join(root, 'linked-src');
  const outside = path.join(parent, 'outside');
  const linkedOutside = path.join(root, 'linked-outside');
  const links = [];
  try {
    fs.mkdirSync(path.join(root, '.workflow', 'tickets', 'review'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(root, 'qa'), { recursive: true });
    fs.mkdirSync(outside);
    for (const file of ['src/app.js', 'src/deep/mod.js', 'qa/result.md']) fs.writeFileSync(path.join(root, file), 'x');
    fs.writeFileSync(path.join(outside, 'app.js'), 'x');
    for (const [target, link] of [[root, alias], [path.join(root, 'src'), linkedSrc], [outside, linkedOutside]]) {
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      links.push(link);
    }
    const run = (scope, changed = 'src/app.js', cwd = root) => {
      const file = path.join(root, '.workflow', 'tickets', 'review', 'HUMAN-1.md');
      fs.writeFileSync(file, `---\nid: HUMAN-1\ncreated_at: "2026-04-21T00:00:00Z"\ndod_format: 2\nexecutor_type: human\ncontext:\n  files:\n    - ${JSON.stringify(scope)}\n---\n## Критерии готовности (Definition of Done)\n\n- [x] Результат записан\n  - check: \`node -e "process.exit(0)" -- qa/result.md\`, expect: \`exit 0\`\n\n## Результат выполнения\n\n### Summary\nfixture summary.\n\n### Изменённые файлы\n\n- \`qa/result.md\` — результат\n- \`${changed.replace(/\\/g, '/')}\` — правка\n`);
      const output = execFileSync(process.execPath, [SCRIPT, file], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const block = output.split('---RESULT---')[1];
      return Object.fromEntries(block.split(/\r?\n/).map(line => /^(\w+):\s*(.*)$/.exec(line)).filter(Boolean).map(match => [match[1], match[2].trim()]));
    };
    check({ root, alias, linkedSrc, outside, linkedOutside, run });
  } finally {
    for (const link of links.reverse()) fs.unlinkSync(link);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function green(result) {
  assert.equal(result.status, 'all_green', result.warnings);
  assert.doesNotMatch(result.warnings || '', /human_out_of_scope_changes/);
}

function outOfScope(result) {
  assert.equal(result.status, 'legacy', result.fail_reasons);
  assert.match(result.warnings || '', /human_out_of_scope_changes=/);
}

test('human scope: абсолютный адрес через ссылку не расширяет область', () => withProject(({ root, alias, outside, run }) => {
  for (const scope of [path.join(root, 'src'), path.join(alias, 'src')]) green(run(scope));
  for (const scope of ['.', path.join(alias, 'qa'), outside]) outOfScope(run(scope));
}));

test('human scope: внутренняя ссылка сравнивается в обе стороны', () => withProject(({ root, linkedSrc, run }) => {
  green(run(linkedSrc, 'linked-src/app.js'));
  green(run('linked-src', path.join(root, 'src', 'app.js')));
  green(run('src', 'linked-src/app.js'));
  outOfScope(run('qa/', 'linked-src/app.js'));
}));

test('human scope: корень через ссылку и абсолютные изменённые пути', () => withProject(({ root, alias, run }) => {
  green(run(path.join(root, 'src'), 'src/app.js', alias));
  green(run('src', path.join(alias, 'src', 'app.js')));
  green(run(path.join(alias, 'src'), path.join(root, 'src', 'app.js'), alias));
  outOfScope(run('qa/', path.join(alias, 'src', 'app.js')));
}));

test('human scope: маски и отсутствующие пути сохраняются при нормализации', () => withProject(({ root, alias, linkedSrc, run }) => {
  for (const scope of ['src/**/*.js', 'linked-src/**/*.js', `${linkedSrc}/**/*.js`, `${alias}/src/**/*.js`]) {
    green(run(scope, 'linked-src/app.js'));
    green(run(scope, 'linked-src/deep/mod.js'));
  }
  outOfScope(run('linked-src/*.js', 'src/deep/mod.js'));
  outOfScope(run(`${alias}/src/**/*.md`, 'src/app.js'));
  const missing = run(path.join(linkedSrc, 'missing'), 'src/missing/new.js');
  assert.equal(missing.status, 'failed');
  assert.match(missing.fail_reasons, /missing_files=/);
  assert.doesNotMatch(missing.warnings || '', /human_out_of_scope_changes/);
  outOfScope(run(path.join(root, 'src', 'missing'), 'src/app.js'));
}));

test('human scope: маска в имени ссылки покрывает файл через эту ссылку', () => withProject(({ root, run }) => {
  // linked-* — маска по имени junction linked-src → src: файл канонизируется в src/app.js,
  // маска остаётся записью — совпадение ищется и в исходных координатах (ревью 2026-10-05).
  green(run('linked-*/*.js', 'linked-src/app.js'));
  green(run(`${root.replace(/\\/g, '/')}/linked-*/*.js`, 'linked-src/app.js'));
  green(run('linked-*/**', 'linked-src/deep/mod.js'));
  // Маска в имени ссылки не открывает физическое дерево и чужие каталоги
  // (qa/result.md не годится на «чужой»: он в области через цель проверки DoD).
  outOfScope(run('linked-*/*.js', 'src/app.js'));
  outOfScope(run('linked-*/*.js', 'src/deep/mod.js'));
}));

test('human scope: вложенная ссылка в записи области — обе стороны в исходных координатах', () => withProject(({ root, run }) => {
  // linked-src → src, src/linked-inner → src/deep: физическая маска области
  // (src/linked-*/*.js) не совпадает ни с физическим (src/deep/app.js), ни с
  // исходным адресом файла — совпадение ищется парой исходных координат (ревью 2026-10-05).
  fs.symlinkSync(path.join(root, 'src', 'deep'), path.join(root, 'src', 'linked-inner'), process.platform === 'win32' ? 'junction' : 'dir');
  green(run('linked-src/linked-*/*.js', 'linked-src/linked-inner/mod.js'));
  green(run('linked-src/linked-*/**', 'linked-src/linked-inner/mod.js'));
  outOfScope(run('linked-src/linked-*/*.js', 'src/deep/mod.js'));
  outOfScope(run('linked-src/linked-*/*.js', 'src/app.js'));
}));

test('human scope: ссылка наружу не разрешает внешние файлы', () => withProject(({ outside, linkedOutside, run }) => {
  for (const scope of ['linked-outside', linkedOutside, outside, '**/*.js']) {
    outOfScope(run(scope, 'linked-outside/app.js'));
  }
  green(run('qa/', path.join(outside, 'app.js')));
}));
