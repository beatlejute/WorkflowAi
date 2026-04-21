#!/usr/bin/env node

import { spawn, execSync } from 'child_process';
import path from 'path';
import { loadRules, scanStderrForFatalRule } from './error-classifier.mjs';

const ResultParser = {
  STATUS_ALIASES: {
    pass: 'passed',
    approved: 'passed',
    success: 'passed',
    succeeded: 'passed',
    ok: 'passed',
    accepted: 'passed',
    lgtm: 'passed',
    fixed: 'passed',
    resolved: 'passed',
    fail: 'failed',
    rejected: 'failed',
    denied: 'failed',
    not_passed: 'failed',
    err: 'error',
    crash: 'error',
    timeout: 'error',
  },

  normalizeStatus(status) {
    const lower = status.toLowerCase();
    const canonical = ResultParser.STATUS_ALIASES[lower];
    if (canonical) {
      return canonical;
    }
    return status;
  },

  parse(output, stageId) {
    const marker = '---RESULT---';
    const startIdx = output.indexOf(marker);
    const endIdx = startIdx !== -1 ? output.indexOf(marker, startIdx + marker.length) : -1;

    if (startIdx !== -1 && endIdx !== -1) {
      const resultBlock = output.substring(startIdx + marker.length, endIdx).trim();
      const data = ResultParser.parseResultBlock(resultBlock);
      const normalizedStatus = ResultParser.normalizeStatus(data.status || 'default');
      return {
        status: normalizedStatus,
        data: data.data || {},
        raw: output,
        parsed: true
      };
    }

    return ResultParser.fallbackParse(output, stageId);
  },

  parseResultBlock(block) {
    const lines = block.split('\n');
    const data = {};
    let status = 'default';
    let currentKey = null;
    let multilineValue = null;

    const flushMultiline = () => {
      if (currentKey !== null && multilineValue !== null) {
        data[currentKey] = multilineValue.replace(/\n$/, '');
        currentKey = null;
        multilineValue = null;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const topLevelMatch = line.match(/^([^:\s][^:]*):\s*(.*)$/);

      if (topLevelMatch) {
        flushMultiline();
        const key = topLevelMatch[1].trim();
        const value = topLevelMatch[2].trim();

        if (value !== '') {
          if (key === 'status') {
            status = value;
          } else {
            data[key] = value;
          }
        } else {
          currentKey = key;
          multilineValue = '';
        }
      } else if (currentKey !== null && (line.startsWith(' ') || line.startsWith('\t') || line === '')) {
        multilineValue += line + '\n';
      } else if (currentKey !== null) {
        flushMultiline();
      }
    }

    flushMultiline();
    return { status, data };
  },

  fallbackParse(output, stageId) {
    const lines = output.split('\n');
    let status = 'default';
    const extractedData = {};
    let inResultSection = false;

    for (const line of lines) {
      const trimmedLine = line.trim();
      const statusMatch = trimmedLine.match(/^(?:status|Status):\s*(\w+)/i);
      if (statusMatch) {
        status = statusMatch[1];
        inResultSection = true;
        continue;
      }

      if (inResultSection) {
        const dataMatch = trimmedLine.match(/^(\w+):\s*(.+)$/i);
        if (dataMatch && dataMatch[1].toLowerCase() !== 'status') {
          extractedData[dataMatch[1]] = dataMatch[2];
        }
      }
    }

    if (status === 'default') {
      const lowerOutput = output.toLowerCase();
      if (lowerOutput.includes('completed') || lowerOutput.includes('success') || lowerOutput.includes('done')) {
        status = 'default';
        extractedData._inferred = 'success_keywords';
      } else if (lowerOutput.includes('error') || lowerOutput.includes('failed')) {
        status = 'error';
        extractedData._inferred = 'error_keywords';
      }
    }

    const normalizedStatus = ResultParser.normalizeStatus(status);
    return {
      status: normalizedStatus,
      data: extractedData,
      raw: output,
      parsed: false
    };
  }
};

export async function spawnAgent(agentConfig, prompt, options = {}) {
  const {
    timeout = 300,
    logger = null,
    resultParser = ResultParser,
    stageId = 'unknown',
    skillId = null,
    projectRoot = process.cwd(),
    currentChildRef = null,
    agentId = null,
    healthRules = null
  } = options;

  return new Promise((resolve, reject) => {
    const args = [...agentConfig.args];
    const finalPrompt = prompt;

    // Для онлайн-детекции фатальных stderr-паттернов
    const rules = agentId
      ? (healthRules || (() => { try { return loadRules(projectRoot); } catch { return null; } })())
      : null;
    const hasAgentRules = Boolean(rules && agentId && rules.agents.get(agentId)?.length);

    const useShell = process.platform === 'win32' && agentConfig.command !== 'node';
    const useStdin = useShell && finalPrompt.includes('\n');

    if (!useStdin) {
      args.push(finalPrompt);
    }

    if (logger) {
      const displayArgs = skillId ? [...args.slice(0, -1), skillId] : args;
      logger.info(`RUN ${agentConfig.command} ${displayArgs.join(' ')}`, stageId);
      const promptLines = prompt.split('\n').filter(l => l.trim());
      if (promptLines.length > 1) {
        for (const line of promptLines.slice(1)) {
          logger.info(`  ${line}`, stageId);
        }
      }
    }

    const startTime = Date.now();

    const child = spawn(agentConfig.command, args, {
      cwd: path.resolve(projectRoot, agentConfig.workdir || '.'),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell
    });

    if (currentChildRef) {
      currentChildRef.current = child;
    }

    if (useStdin) {
      child.stdin.write(finalPrompt);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let earlyKilled = false;
    let lastScanSize = 0;

    const killChild = () => {
      if (process.platform === 'win32' && child.pid) {
        try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe' }); } catch {}
      } else {
        try { child.kill('SIGTERM'); } catch {}
      }
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      killChild();
      if (logger) {
        logger.timeout(stageId, timeout);
      }
      reject(new Error(`Stage "${stageId}" timed out after ${timeout}s`));
    }, timeout * 1000);

    let stdoutBuffer = '';
    let agentText = '';
    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'content_block_delta' && obj.delta?.text) {
            process.stdout.write(obj.delta.text);
            agentText += obj.delta.text;
          } else if (obj.type === 'assistant' && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text) {
                process.stdout.write(block.text);
                agentText += block.text;
              }
            }
          }
        } catch {
          process.stdout.write(line + '\n');
          agentText += line + '\n';
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);

      if (!hasAgentRules || earlyKilled || timedOut) return;
      // Throttle: первый скан всегда, последующие — только после 200+ новых байт.
      if (lastScanSize > 0 && stderr.length - lastScanSize < 200) return;
      lastScanSize = stderr.length;
      const match = scanStderrForFatalRule(rules, agentId, stderr);
      if (!match) return;

      earlyKilled = true;
      clearTimeout(timeoutId);
      if (logger) {
        logger.error?.(
          `Fatal stderr pattern matched for ${agentId} (rule=${match.rule_id}, class=${match.class}). Killing process.`,
          stageId
        );
      }
      killChild();
      const err = new Error(
        `Agent "${agentId}" killed early: ${match.rule_id} (class=${match.class})`
      );
      err.code = 'EARLY_KILL';
      err.exitCode = -1;
      err.stderr = stderr;
      err.earlyKill = true;
      err.rule = match;
      reject(err);
    });

    child.on('close', (code) => {
      if (currentChildRef) {
        currentChildRef.current = null;
      }
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      if (stdoutBuffer.trim()) {
        try {
          const obj = JSON.parse(stdoutBuffer);
          if (obj.type === 'content_block_delta' && obj.delta?.text) {
            process.stdout.write(obj.delta.text);
          }
        } catch {
          process.stdout.write(stdoutBuffer + '\n');
        }
      }
      process.stdout.write('\n');

      if (timedOut || earlyKilled) return;

      if (logger) {
        logger.cliCall(agentConfig.command, args, code);
        const trimmedOutput = agentText.trim();
        if (trimmedOutput) {
          logger.info(`OUTPUT ↓`, stageId);
          for (const line of trimmedOutput.split('\n')) {
            logger.info(`  ${line}`, stageId);
          }
          logger.info(`OUTPUT ↑`, stageId);
        }
        if (stderr.trim()) {
          logger.warn(`STDERR ↓`, stageId);
          for (const line of stderr.trim().split('\n')) {
            logger.warn(`  ${line}`, stageId);
          }
          logger.warn(`STDERR ↑`, stageId);
        }
      }

      const result = resultParser.parse(stdout, stageId);

      if (code !== 0 && result.parsed && result.status && result.status !== 'default') {
        if (logger) {
          logger.warn(
            `Agent exited with code ${code}, but RESULT was parsed (status: ${result.status}). Using parsed result.`,
            stageId
          );
        }
      } else if (code !== 0) {
        const err = new Error(`Agent exited with code ${code}`);
        err.code = 'NON_ZERO_EXIT';
        err.exitCode = code;
        err.stderr = stderr;
        if (logger) {
          logger.error(`Agent exited with code ${code}`, stageId);
          if (stderr.trim()) {
            for (const line of stderr.trim().split('\n')) {
              logger.error(`  stderr: ${line}`, stageId);
            }
          }
        }
        reject(err);
        return;
      }

      resolve({
        status: result.status || 'default',
        output: stdout,
        stderr: stderr,
        result: result.data || {},
        exitCode: code,
        parsed: result.parsed,
        durationMs
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      if (!timedOut && !earlyKilled) {
        if (logger) {
          logger.error(`CLI error: ${err.message}`, stageId);
        }
        reject(err);
      }
    });
  });
}

export { ResultParser };
export default { spawnAgent, ResultParser };