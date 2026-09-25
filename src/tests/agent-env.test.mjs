#!/usr/bin/env node
/**
 * Машинное окружение агентов `<WORKFLOW_HOME>/agent.env` (lib/agent-env.mjs).
 *
 * Инцидент 2026-09-24 (PulseProxy): раннер из расширения VS Code запускал kilo
 * без прокси, все kilo-агенты получили 403 Forbidden. agent.env доводит прокси
 * до агента в обоих путях запуска — runner.mjs (pipeline) и agent-spawner.mjs
 * (тесты скилов).
 *
 * Каждый тест подменяет WORKFLOW_HOME своим временным каталогом: без этого
 * одиночный запуск файла (без преднагрузки _rails-home.mjs) писал бы agent.env
 * в настоящий ~/.workflow.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseAgentEnv, buildAgentEnv, agentEnvPath, AGENT_ENV_FILE } from '../lib/agent-env.mjs';
import { spawnAgent } from '../lib/agent-spawner.mjs';
import { StageExecutor } from '../runner.mjs';

function withHome(fn) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-home-'));
    const saved = process.env.WORKFLOW_HOME;
    process.env.WORKFLOW_HOME = home;
    try {
      await fn(home);
    } finally {
      if (saved === undefined) delete process.env.WORKFLOW_HOME;
      else process.env.WORKFLOW_HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

function writeAgentEnv(home, text) {
  fs.writeFileSync(path.join(home, AGENT_ENV_FILE), text, 'utf8');
}

// Дочерний node-процесс печатает RESULT и JSON с интересующими переменными.
function writeEchoEnvScript(dir, keys, markerPath = null) {
  const scriptPath = path.join(dir, 'echo-env.mjs');
  const pick = `Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k] ?? null]))`;
  fs.writeFileSync(scriptPath, [
    "import fs from 'node:fs';",
    `const report = JSON.stringify(${pick});`,
    markerPath ? `fs.writeFileSync(${JSON.stringify(markerPath)}, report);` : '',
    "process.stdout.write('---RESULT---\\nstatus: passed\\n---RESULT---\\n');",
    "process.stdout.write(report + '\\n');"
  ].join('\n'));
  return scriptPath;
}

function extractReport(output) {
  const line = output.split('\n').find((l) => l.trim().startsWith('{'));
  assert.ok(line, `нет JSON-строки в выводе: ${output}`);
  return JSON.parse(line);
}

describe('parseAgentEnv', () => {
  test('KEY=VALUE, комментарии, пустые строки, CRLF и BOM', () => {
    const parsed = parseAgentEnv('\uFEFF# прокси\r\nHTTP_PROXY=http://u:p@h:1\r\n\r\n  HTTPS_PROXY = http://u:p@h:1  \r\n');
    assert.deepEqual(parsed.set, { HTTP_PROXY: 'http://u:p@h:1', HTTPS_PROXY: 'http://u:p@h:1' });
    assert.deepEqual(parsed.unset, []);
    assert.deepEqual(parsed.invalid, []);
  });

  test('значение с `=` внутри сохраняется целиком', () => {
    assert.deepEqual(parseAgentEnv('NO_PROXY=a=b,c').set, { NO_PROXY: 'a=b,c' });
  });

  test('парные кавычки снимаются, непарные — нет', () => {
    const { set } = parseAgentEnv(`A="x y"\nB='z'\nC="q`);
    assert.deepEqual(set, { A: 'x y', B: 'z', C: '"q' });
  });

  test('пустое значение — снятие переменной', () => {
    const parsed = parseAgentEnv('ALL_PROXY=\nD=""');
    assert.deepEqual(parsed.set, {});
    assert.deepEqual(parsed.unset, ['ALL_PROXY', 'D']);
  });

  test('повтор ключа — действует последняя строка', () => {
    assert.deepEqual(parseAgentEnv('A=1\nA=\nB=\nB=2'), { set: { B: '2' }, unset: ['A'], invalid: [] });
  });

  test('строки без `=` и с недопустимым именем не применяются', () => {
    const parsed = parseAgentEnv('JUSTWORD\n=x\n1A=b\nOK=1\nexport HTTPS_PROXY=http://h:1\nHTTP_PROXY: http://h:1');
    assert.deepEqual(parsed.set, { OK: '1' });
    assert.deepEqual(parsed.invalid, [1, 2, 3, 5, 6]);
  });

  test('`#` внутри значения — часть значения, комментарий только целой строкой', () => {
    const { set } = parseAgentEnv('P=http://u:pa#ss@h:1\nQ=1 # не комментарий\n  # комментарий с отступом');
    assert.deepEqual(set, { P: 'http://u:pa#ss@h:1', Q: '1 # не комментарий' });
  });
});

describe('buildAgentEnv — диагностика в лог', () => {
  function makeLogger() {
    const lines = [];
    return {
      lines,
      info: (m, s) => lines.push(['info', m, s]),
      warn: (m, s) => lines.push(['warn', m, s])
    };
  }

  test('нет файла — ни строки в логе', withHome(() => {
    const logger = makeLogger();
    buildAgentEnv({}, null, { platform: 'linux', logger, stageId: 'st' });
    assert.deepEqual(logger.lines, []);
  }));

  test('применённый файл — имена переменных без значений', withHome((home) => {
    writeAgentEnv(home, 'HTTPS_PROXY=http://user:secret@h:1\nALL_PROXY=\n');
    const logger = makeLogger();
    buildAgentEnv({}, null, { platform: 'linux', logger, stageId: 'execute-task' });
    assert.deepEqual(logger.lines, [['info', 'agent.env: задано HTTPS_PROXY; снято ALL_PROXY', 'execute-task']]);
    assert.ok(!JSON.stringify(logger.lines).includes('secret'), 'значение не попало в лог');
  }));

  test('строки не по формату — WARN с номерами строк, остальное применяется', withHome((home) => {
    writeAgentEnv(home, 'export HTTPS_PROXY=http://user:secret@h:1\nHTTP_PROXY=http://h:2\n');
    const logger = makeLogger();
    const env = buildAgentEnv({}, null, { platform: 'linux', logger, stageId: 'st' });
    assert.equal(env.HTTP_PROXY, 'http://h:2');
    assert.equal(logger.lines[0][0], 'warn');
    assert.match(logger.lines[0][1], /строки 1 не по формату/);
    assert.ok(!JSON.stringify(logger.lines).includes('secret'), 'значение не попало в лог');
  }));

  test('нечитаемый файл — WARN с кодом ошибки, окружение без изменений', withHome((home) => {
    fs.mkdirSync(path.join(home, AGENT_ENV_FILE));
    const logger = makeLogger();
    const base = { A: '1' };
    assert.deepEqual(buildAgentEnv(base, null, { platform: 'linux', logger, stageId: 'st' }), base);
    assert.equal(logger.lines.length, 1);
    assert.equal(logger.lines[0][0], 'warn');
    assert.match(logger.lines[0][1], /agent\.env не прочитан \(E[A-Z]+\)/);
  }));
});

describe('buildAgentEnv', () => {
  test('путь файла — в WORKFLOW_HOME', withHome((home) => {
    assert.equal(agentEnvPath(), path.join(home, 'agent.env'));
  }));

  test('без файла окружение не меняется', withHome(() => {
    const base = { PATH: '/bin', HTTPS_PROXY: 'keep' };
    assert.deepEqual(buildAgentEnv(base, null, { platform: 'linux' }), base);
  }));

  test('файл добавляет и перекрывает, пустое значение снимает', withHome((home) => {
    writeAgentEnv(home, 'HTTPS_PROXY=http://file\nALL_PROXY=\nNEW_VAR=1\n');
    const env = buildAgentEnv({ PATH: '/bin', HTTPS_PROXY: 'http://base', ALL_PROXY: 'socks://x' }, null, { platform: 'linux' });
    assert.deepEqual(env, { PATH: '/bin', HTTPS_PROXY: 'http://file', NEW_VAR: '1' });
  }));

  test('доплата вызывающего кода главнее файла', withHome((home) => {
    writeAgentEnv(home, 'WORKFLOW_RAILS_ROLE=from-file\nHTTPS_PROXY=http://file\n');
    const env = buildAgentEnv({}, { WORKFLOW_RAILS_ROLE: 'executor' }, { platform: 'linux' });
    assert.equal(env.WORKFLOW_RAILS_ROLE, 'executor');
    assert.equal(env.HTTPS_PROXY, 'http://file');
  }));

  test('win32: имя из файла вытесняет все регистровые варианты', withHome((home) => {
    writeAgentEnv(home, 'HTTPS_PROXY=http://file\nALL_PROXY=\n');
    const env = buildAgentEnv({ https_proxy: 'http://low', Https_Proxy: 'http://mixed', all_proxy: 'socks://x', Path: 'C:\\bin' }, null, { platform: 'win32' });
    assert.deepEqual(env, { Path: 'C:\\bin', HTTPS_PROXY: 'http://file' });
  }));

  test('не win32: регистровые варианты — разные переменные', withHome((home) => {
    writeAgentEnv(home, 'HTTPS_PROXY=http://file\n');
    const env = buildAgentEnv({ https_proxy: 'http://low' }, null, { platform: 'linux' });
    assert.deepEqual(env, { https_proxy: 'http://low', HTTPS_PROXY: 'http://file' });
  }));

  test('base не мутируется', withHome((home) => {
    writeAgentEnv(home, 'A=1\nB=\n');
    const base = { B: 'x' };
    buildAgentEnv(base, null, { platform: 'linux' });
    assert.deepEqual(base, { B: 'x' });
  }));

  // `kilo run` 7.7.x берёт каталог проекта из PWD, Git Bash отдаёт потомкам PWD своего
  // каталога: 2026-09-23 и 2026-09-25 Kilo-агенты тестов работали в настоящем проекте.
  test('cwd становится PWD агента — поверх окружения, файла и доплаты', withHome((home) => {
    writeAgentEnv(home, 'PWD=/from-file\n');
    const env = buildAgentEnv({ PWD: '/d/Dev/workflowAi' }, { PWD: '/from-extra' }, { platform: 'linux', cwd: '/tmp/sandbox' });
    assert.equal(env.PWD, '/tmp/sandbox');
  }));

  test('win32: PWD из cwd вытесняет регистровые варианты', withHome(() => {
    const env = buildAgentEnv({ PWD: 'D:/Dev/workflowAi', pwd: 'x', Path: 'C:\\bin' }, null, { platform: 'win32', cwd: 'C:\\Temp\\wf-test-1' });
    assert.deepEqual(env, { Path: 'C:\\bin', PWD: 'C:\\Temp\\wf-test-1' });
  }));

  test('без cwd PWD не трогается', withHome(() => {
    assert.equal(buildAgentEnv({ PWD: '/keep' }, null, { platform: 'linux' }).PWD, '/keep');
  }));

  test('файл перечитывается на каждый вызов', withHome((home) => {
    writeAgentEnv(home, 'A=1\n');
    assert.equal(buildAgentEnv({}, null, { platform: 'linux' }).A, '1');
    writeAgentEnv(home, 'A=2\n');
    assert.equal(buildAgentEnv({}, null, { platform: 'linux' }).A, '2');
  }));
});

// Раннер, запущенный из Git Bash, наследует PWD каталога запуска; агент обязан получить
// PWD своего рабочего каталога, иначе `kilo run` 7.7.x работает не там (инцидент выше).
function withForeignPwd(fn) {
  return async (...args) => {
    const saved = process.env.PWD;
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-foreign-pwd-'));
    process.env.PWD = foreign;
    try {
      await fn(...args, foreign);
    } finally {
      if (saved === undefined) delete process.env.PWD;
      else process.env.PWD = saved;
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  };
}

describe('PWD агента — его рабочий каталог, а не каталог запуска раннера', () => {
  test('agent-spawner.mjs (тесты скилов)', withHome(withForeignPwd(async (home, foreign) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-pwd-spawner-'));
    try {
      const script = writeEchoEnvScript(tmp, ['PWD']);
      const result = await spawnAgent({ command: 'node', args: [script], workdir: '.' }, 'prompt', {
        timeout: 10,
        projectRoot: tmp
      });
      const { PWD } = extractReport(result.output);
      assert.notEqual(PWD, foreign);
      assert.equal(path.resolve(PWD), path.resolve(tmp));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })));

  test('runner.mjs (стадия pipeline)', withHome(withForeignPwd(async (home, foreign) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-pwd-runner-'));
    try {
      const marker = path.join(projectRoot, 'env-report.json');
      const script = writeEchoEnvScript(projectRoot, ['PWD'], marker);
      const config = {
        pipeline: {
          name: 'agent-env',
          version: '1.0',
          agents: { stub: { command: 'node', args: [script], capabilities: ['text'] } },
          execution: { timeout_per_stage: 30 },
          stages: {},
          entry: 'none',
          context: {}
        }
      };
      const executor = new StageExecutor(config, {}, {}, {}, null, null, projectRoot);
      const result = await executor.executeWithFallback('execute-task', { agents: ['stub'], instructions: 'Test', skill: 'test-skill' });

      assert.equal(result.status, 'passed');
      const { PWD } = JSON.parse(fs.readFileSync(marker, 'utf8'));
      assert.notEqual(PWD, foreign);
      assert.equal(path.resolve(PWD), path.resolve(projectRoot));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  })));
});

describe('agent.env доходит до дочернего процесса агента', () => {
  test('agent-spawner.mjs (тесты скилов)', withHome(async (home) => {
    writeAgentEnv(home, 'WF_AGENT_ENV_TEST=from-file\nWF_AGENT_ENV_OVERRIDE=from-file\n');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-spawner-'));
    try {
      const script = writeEchoEnvScript(tmp, ['WF_AGENT_ENV_TEST', 'WF_AGENT_ENV_OVERRIDE']);
      const result = await spawnAgent({ command: 'node', args: [script], workdir: '.' }, 'prompt', {
        timeout: 10,
        projectRoot: tmp,
        env: { WF_AGENT_ENV_OVERRIDE: 'from-options' }
      });
      assert.deepEqual(extractReport(result.output), {
        WF_AGENT_ENV_TEST: 'from-file',
        WF_AGENT_ENV_OVERRIDE: 'from-options'
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }));

  test('runner.mjs (стадия pipeline)', withHome(async (home) => {
    writeAgentEnv(home, 'WF_AGENT_ENV_TEST=from-file\n');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-runner-'));
    try {
      const marker = path.join(projectRoot, 'env-report.json');
      const script = writeEchoEnvScript(projectRoot, ['WF_AGENT_ENV_TEST'], marker);
      const config = {
        pipeline: {
          name: 'agent-env',
          version: '1.0',
          agents: { stub: { command: 'node', args: [script], capabilities: ['text'] } },
          execution: { timeout_per_stage: 30 },
          stages: {},
          entry: 'none',
          context: {}
        }
      };
      const executor = new StageExecutor(config, {}, {}, {}, null, null, projectRoot);
      const result = await executor.executeWithFallback('execute-task', { agents: ['stub'], instructions: 'Test', skill: 'test-skill' });

      assert.equal(result.status, 'passed');
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { WF_AGENT_ENV_TEST: 'from-file' });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }));
});
