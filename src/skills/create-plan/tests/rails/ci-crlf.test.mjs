import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/validate-completeness.js', import.meta.url));
const TEMPLATE = fs.readFileSync(new URL('../../../../../templates/plan-template.md', import.meta.url), 'utf8');

function validate(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-crlf-'));
  try {
    const file = path.join(root, 'plan.md');
    fs.writeFileSync(file, text);
    const output = execFileSync(process.execPath, [SCRIPT, file], { cwd: root, encoding: 'utf8' });
    return JSON.parse(output.split('---RESULT---')[1]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('validate-completeness: LF и CRLF сохраняют одинаковый frontmatter', () => {
  const lf = TEMPLATE.replace(/\r\n/g, '\n');
  const expected = validate(lf);
  assert.deepEqual(expected.errors, []);
  assert.deepEqual(validate(lf.replace(/\n/g, '\r\n')), expected);
});

test('validate-completeness: отсутствие frontmatter по-прежнему отклоняется', () => {
  const body = TEMPLATE.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const result = validate(body);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.field === 'frontmatter'));
});
