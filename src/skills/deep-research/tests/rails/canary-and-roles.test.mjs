// Канарейка живости (узел P0S1): рельсы отклоняют echo RAILS_CANARY у координатора
// и молчат у делегата. Скрипт исследования и веб-инструменты по этапам не привязаны
// (правило P0R4 держится формулировкой узла: stage_actions не сопоставляет kind other).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, atNode, ctx, claude, decide } from './_project.mjs';

test('канарейка: координатор на P0S1 — отказ с упоминанием RAILS_CANARY', () => {
  withProject(({ root }) => {
    const r = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, atNode(root, 'P0S1')) });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /RAILS_CANARY/);
  });
});

test('канарейка: делегат (role executor) — молчание', () => {
  withProject(({ root }) => {
    const r = decide({ action: claude('Bash', { command: 'echo RAILS_CANARY' }), ctx: ctx(root, atNode(root, 'P0S1'), { role: 'executor' }) });
    assert.equal(r.decision, 'allow');
  });
});

test('perplexity-research.js и fallback WebSearch/WebFetch — молчание на шаге сбора данных', () => {
  withProject(({ root }) => {
    const s = atNode(root, 'P10S2');
    const script = 'node .workflow/src/skills/deep-research/scripts/perplexity-research.js "размер рынка"';
    assert.equal(decide({ action: claude('Bash', { command: script }), ctx: ctx(root, s) }).decision, 'allow');
    assert.equal(decide({ action: claude('WebSearch', { query: 'market size' }), ctx: ctx(root, s) }).decision, 'allow');
    assert.equal(decide({ action: claude('WebFetch', { url: 'https://example.com', prompt: 'x' }), ctx: ctx(root, s) }).decision, 'allow');
  });
});
