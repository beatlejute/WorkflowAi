#!/usr/bin/env node

/**
 * Регрессионный тест: script-стейдж с пустым stdout → 'ok', не 'empty_response'
 *
 * IMPL-83 требует, чтобы classifyAgentResult различал AI и script агентов:
 * - AI агент + пустой stdout + exitCode=0 → empty_response
 * - Script агент + пустой stdout + exitCode=0 → ok (не empty_response)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyAgentResult } from '../lib/agent-history.mjs';

describe('runner-script-stage-ok — script-стейдж с пустым stdout', () => {
  it('should return "ok" for script agent with empty stdout and exitCode=0', () => {
    const result = classifyAgentResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      signal: null,
      parsedResult: null,
      agentType: 'script'
    });

    assert.strictEqual(result, 'ok',
      'Script agent with empty stdout and exitCode=0 should have status "ok"');
  });

  it('should NOT return "empty_response" for script agent with empty stdout and exitCode=0', () => {
    const result = classifyAgentResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      signal: null,
      parsedResult: null,
      agentType: 'script'
    });

    assert.notStrictEqual(result, 'empty_response',
      'Script agent should NOT get "empty_response" status, even with empty stdout');
  });

  it('should return "empty_response" for AI agent with empty stdout and exitCode=0', () => {
    const result = classifyAgentResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      signal: null,
      parsedResult: null,
      agentType: 'ai'
    });

    assert.strictEqual(result, 'empty_response',
      'AI agent with empty stdout and exitCode=0 should have status "empty_response"');
  });

  it('should return "ok" for script agent with whitespace-only stdout and exitCode=0', () => {
    const result = classifyAgentResult({
      exitCode: 0,
      stdout: '   \n\n  ',
      stderr: '',
      timedOut: false,
      signal: null,
      parsedResult: null,
      agentType: 'script'
    });

    assert.strictEqual(result, 'ok',
      'Script agent with whitespace-only stdout and exitCode=0 should have status "ok"');
  });

  it('should return "ok" for script agent with actual output and exitCode=0', () => {
    const result = classifyAgentResult({
      exitCode: 0,
      stdout: 'Script executed successfully',
      stderr: '',
      timedOut: false,
      signal: null,
      parsedResult: null,
      agentType: 'script'
    });

    assert.strictEqual(result, 'ok',
      'Script agent with normal output and exitCode=0 should have status "ok"');
  });

  it('should return "error" for script agent with exitCode!=0', () => {
    const result = classifyAgentResult({
      exitCode: 1,
      stdout: '',
      stderr: 'Some error',
      timedOut: false,
      signal: null,
      parsedResult: null,
      agentType: 'script'
    });

    assert.strictEqual(result, 'error',
      'Script agent with non-zero exitCode should have status "error"');
  });

  it('should return "ok" for script agent even with exitCode=0 and empty stderr', () => {
    const result = classifyAgentResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      signal: null,
      parsedResult: null,
      agentType: 'script'
    });

    assert.strictEqual(result, 'ok',
      'Script agent with exitCode=0 should be "ok" regardless of stdout/stderr content');
  });
});
