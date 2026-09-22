// H5: финальный ответ — только в терминале P6S3 и кончается блоком ---RESULT--- со status
// completed или has_gaps (инцидент 2026-04-03, узел P6R1, кейс TC-ANALYZE-REPORT-002).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProject, loadSkillRuntime, loadState, atNode, SKILL } from './_project.mjs';
import { check } from '../../../../rails/output-check.mjs';

const BODY = '## Executive Summary\nПлан выполнен на 100%, пробелов нет [HIGH].\n\n';
const COMPLETED = `${BODY}---RESULT---\nstatus: completed\nreport_id: REPORT-001\n---RESULT---\n`;
const HAS_GAPS = `${BODY}---RESULT---\nstatus: has_gaps\nreport_id: REPORT-001\ngaps: "Два тикета плана в blocked, DoD не выполнен"\n---RESULT---`;

function verdict(root, text, node = 'P6S3') {
  const { config } = loadSkillRuntime(root, SKILL);
  return check(text, config, loadState(root, atNode(root, node)));
}

test('H5: completed и has_gaps в конце ответа в терминале P6S3 — приняты', () => {
  withProject(({ root }) => {
    assert.deepEqual(verdict(root, COMPLETED), { ok: true, missing: [] });
    assert.deepEqual(verdict(root, HAS_GAPS), { ok: true, missing: [] });
  });
});

test('H5: блок ---RESULT--- в code fence в конце ответа — принят (парсер раннера его разбирает)', () => {
  withProject(({ root }) => {
    const fenced = `${BODY}\`\`\`\n---RESULT---\nstatus: has_gaps\nreport_id: REPORT-003\ngaps: "check-relevance.js пропустил тикет"\n---RESULT---\n\`\`\`\n`;
    assert.deepEqual(verdict(root, fenced), { ok: true, missing: [] });
  });
});

test('H5: ответ без блока ---RESULT--- — отказ', () => {
  withProject(({ root }) => {
    assert.equal(verdict(root, BODY).ok, false);
  });
});

// Инцидент 2026-09-22: после конверсии четыре финальных ответа из шести — один блок ---RESULT---,
// отчёт анализа остался в промежуточных сообщениях (узел P3S1).
test('H5: только блок ---RESULT--- без отчёта (нет Executive Summary) — отказ', () => {
  withProject(({ root }) => {
    const r = verdict(root, COMPLETED.replace(BODY, ''));
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes('Executive Summary'), JSON.stringify(r.missing));
  });
});

test('H5: недопустимый статус (default, ok, done) — отказ', () => {
  withProject(({ root }) => {
    for (const bad of ['default', 'ok', 'done']) {
      assert.equal(verdict(root, COMPLETED.replace('status: completed', `status: ${bad}`)).ok, false, bad);
    }
  });
});

test('H5: блок не последний — после него текст — отказ', () => {
  withProject(({ root }) => {
    assert.equal(verdict(root, `${COMPLETED}\nЕсли нужно, могу подробнее.`).ok, false);
  });
});

test('H5: корректный блок, но из середины графа (P10S9) — отказ по положению', () => {
  withProject(({ root }) => {
    const r = verdict(root, COMPLETED, 'P10S9');
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((m) => /position:/.test(m)));
  });
});
