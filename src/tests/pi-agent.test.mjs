import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnAgent } from '../lib/agent-spawner.mjs';
import yaml from '../lib/js-yaml.mjs';

const { pipeline } = yaml.load(readFileSync(new URL('../../configs/pipeline.yaml', import.meta.url), 'utf8'));

test('direct pi transport preserves a long prompt and parses the stage result', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-transport-'));
  try {
    const cli = path.join(root, 'cli.cjs');
    writeFileSync(cli, `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        console.log('---RESULT---\\nstatus: passed\\nlength: ' + input.length + '\\n---RESULT---');
      });
    `);
    if (process.platform === 'win32') {
      writeFileSync(path.join(root, 'pi.cmd'), `@"${process.execPath}" "${cli}" %*\r\n`);
    } else {
      writeFileSync(path.join(root, 'pi'), `#!${process.execPath}\n${readFileSync(cli, 'utf8')}`, { mode: 0o755 });
    }
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
    const prompt = 'Привет & %PATH% "quoted"\n'.repeat(2000);
    const agent = Object.values(pipeline.agents).find(agent => agent.command === 'pi');
    assert.ok(agent, 'expected a direct pi entry');
    const result = await spawnAgent(agent, prompt, {
      projectRoot: root,
      env: { [pathKey]: root + path.delimiter + (process.env[pathKey] || '') },
      timeout: 10,
    });
    assert.equal(result.status, 'passed');
    assert.equal(Number(result.result.length), prompt.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Check the CLI contract for every pi entry without coupling to provider/model names.
for (const [id, agent] of Object.entries(pipeline.agents).filter(([, agent]) => agent.command === 'pi')) {
  test(`${id}: direct noninteractive pi with stdin and no persisted session`, () => {
    assert.equal(agent.prompt_stdin, true);
    assert.ok(agent.args.includes('--print'));
    assert.ok(agent.args.includes('--no-session'));
    assert.equal(agent.args[agent.args.indexOf('--mode') + 1], 'text');
    for (const flag of ['--provider', '--model']) {
      assert.ok(agent.args.includes(flag));
      assert.ok(agent.args[agent.args.indexOf(flag) + 1]);
    }
  });
}
