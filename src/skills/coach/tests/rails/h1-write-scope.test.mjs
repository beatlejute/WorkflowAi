// H1: коуч пишет в .workflow/src/skills/**, .workflow/shared/** и coach-backlog.yaml.
// 2026-10-05: канон установки защищён физической политикой (правка — только по
// разрешению владельца), независимая локальная копия скила правится целиком на
// любом этапе. Инцидент 2026-09-21 (rails.yaml коуча).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withCoachProject, atNode, ctx, claude, decide, CANON } from './_project.mjs';

test('H1: Write тикета в .workflow/tickets вне write_scope — отказ (утечка фикстуры 2026-09-21)', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Write', { file_path: join(root, '.workflow', 'tickets', 'backlog', 'IMPL-999.md') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /вне write_scope/);
  });
});

test('H1: скил через junction в канон — отказ на любом этапе, этапные правила не достигаются', () => {
  withCoachProject(({ root, link }) => {
    for (const node of ['P1S1', 'P4S2', 'P10S5']) {
      const r = decide({ action: claude('Write', { file_path: join(link, 'knowledge', 'new-note.md') }), ctx: ctx(root, atNode(root, node)) });
      assert.equal(r.decision, 'deny', node);
      assert.match(r.reason, /каноническая цель защищена/, node);
    }
  });
});

test('H1: Edit по каноническому пути (мимо проектной ссылки) — отказ', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Edit', { file_path: join(CANON, 'SKILL.md') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /каноническая цель защищена/);
  });
});

test('H1: независимая локальная копия правится целиком — любой этап, E-узел, новые файлы, собственные rails.yaml и tests', () => {
  withCoachProject(({ root, link }) => {
    for (const node of ['P1S1', 'P4E1', 'P4S2', 'P10S5', 'P70S5']) {
      for (const rel of ['SKILL.md', 'rails.yaml', 'knowledge/new-note.md', 'workflows/new.md', 'tests/rails/new.test.mjs']) {
        const r = decide({ action: claude('Write', { file_path: join(link, rel) }), ctx: ctx(root, atNode(root, node)) });
        assert.equal(r.decision, 'allow', `${node}: ${rel} — ${r.reason ?? ''}`);
      }
    }
  }, { independent: true });
});

test('H1: смешанная операция — правка копии вместе с каноном отклоняется целиком', () => {
  withCoachProject(({ root, link }) => {
    const s = atNode(root, 'P4S2');
    // apply_patch Kilo: несколько путей одной операцией (kind edit, paths).
    const r = decide({
      action: { tool: 'apply_patch', kind: 'edit', paths: [join(link, 'SKILL.md'), join(CANON, 'README.md')] },
      ctx: ctx(root, s),
    });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /каноническая цель защищена/);
  }, { independent: true });
});

test('H1: Write в shared knowledge проекта (.workflow/shared) на этапе П4 — молчание (DOCS-014, 2026-09-30)', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Write', { file_path: join(root, '.workflow', 'shared', 'module.md') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'allow');
  });
});

test('H1: запись файлов кодом `node -e` — отказ, путь не определить (инцидент 2026-09-30)', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    // коуч переписал 17 файлов канона такой командой в обход write_scope
    const command = `node -e "const fs=require('fs'); for (const f of ['src/skills/a/SKILL.md']) fs.writeFileSync(f, 'x')"`;
    const r = decide({ action: claude('Bash', { command }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /путь не удалось определить/);
  });
});

test('H1b: Write в ядро rails проекта (.workflow/src/rails) — отказ', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Write', { file_path: join(root, '.workflow', 'src', 'rails', 'core.mjs') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'deny');
    // В реальном проекте это junction в установку (каноническая цель), в фикстуре —
    // write_scope/write_deny: отказ в любом случае.
    assert.match(r.reason, /write_deny|вне write_scope/);
  });
});

test('H1: Write во временный каталог — молчание (allow_temp)', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Write', { file_path: join(tmpdir(), 'coach-rails-probe', 'note.txt') }), ctx: ctx(root, s) });
    assert.equal(r.decision, 'allow');
  });
});

test('H1: делегат (role=executor) пишет куда угодно — молчание', () => {
  withCoachProject(({ root }) => {
    const s = atNode(root, 'P4S2');
    const r = decide({ action: claude('Write', { file_path: join(root, '.workflow', 'tickets', 'backlog', 'X.md') }), ctx: ctx(root, s, { role: 'executor' }) });
    assert.deepEqual(r, { decision: 'allow' });
  });
});
