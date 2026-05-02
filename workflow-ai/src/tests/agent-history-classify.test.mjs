import { test } from 'node:test';
import assert from 'node:assert';
import { classifyAgentResult } from '../lib/agent-history.mjs';

test('classifyAgentResult: timeout when timedOut=true', () => {
  const result = classifyAgentResult({
    exitCode: 1,
    stderr: '',
    stdout: '',
    timedOut: true,
    signal: null,
    parsedResult: null,
    agentType: 'ai'
  });
  assert.strictEqual(result, 'timeout');
});

test('classifyAgentResult: aborted via SIGTERM', () => {
  const result = classifyAgentResult({
    exitCode: 0,
    stderr: '',
    stdout: '',
    timedOut: false,
    signal: 'SIGTERM',
    parsedResult: null,
    agentType: 'ai'
  });
  assert.strictEqual(result, 'aborted');
});

test('classifyAgentResult: aborted via exitCode=137', () => {
  const result = classifyAgentResult({
    exitCode: 137,
    stderr: '',
    stdout: '',
    timedOut: false,
    signal: null,
    parsedResult: null,
    agentType: 'ai'
  });
  assert.strictEqual(result, 'aborted');
});

test('classifyAgentResult: blocked status', () => {
  const result = classifyAgentResult({
    exitCode: 0,
    stderr: '',
    stdout: 'some output',
    timedOut: false,
    signal: null,
    parsedResult: { status: 'blocked' },
    agentType: 'ai'
  });
  assert.strictEqual(result, 'blocked');
});

test('classifyAgentResult: skipped_relevance status', () => {
  const result = classifyAgentResult({
    exitCode: 0,
    stderr: '',
    stdout: 'some output',
    timedOut: false,
    signal: null,
    parsedResult: { status: 'irrelevant' },
    agentType: 'ai'
  });
  assert.strictEqual(result, 'skipped_relevance');
});

test('classifyAgentResult: rate_limit via 429', () => {
  const result = classifyAgentResult({
    exitCode: 1,
    stderr: '429 Too Many Requests',
    stdout: '',
    timedOut: false,
    signal: null,
    parsedResult: null,
    agentType: 'ai'
  });
  assert.strictEqual(result, 'rate_limit');
});

test('classifyAgentResult: network_error via ECONNREFUSED', () => {
  const result = classifyAgentResult({
    exitCode: 1,
    stderr: 'ECONNREFUSED: Connection refused',
    stdout: '',
    timedOut: false,
    signal: null,
    parsedResult: null,
    agentType: 'ai'
  });
  assert.strictEqual(result, 'network_error');
});

test('classifyAgentResult: auth_error via invalid api key', () => {
  const result = classifyAgentResult({
    exitCode: 1,
    stderr: 'invalid api key provided',
    stdout: '',
    timedOut: false,
    signal: null,
    parsedResult: null,
    agentType: 'ai'
  });
  assert.strictEqual(result, 'auth_error');
});

test('classifyAgentResult: empty_response for AI agent with empty stdout', () => {
  const result = classifyAgentResult({
    exitCode: 0,
    stderr: '',
    stdout: '',
    timedOut: false,
    signal: null,
    parsedResult: null,
    agentType: 'ai'
  });
  assert.strictEqual(result, 'empty_response');
});

test('classifyAgentResult: empty_response NOT for script agent (returns ok)', () => {
  const result = classifyAgentResult({
    exitCode: 0,
    stderr: '',
    stdout: '',
    timedOut: false,
    signal: null,
    parsedResult: null,
    agentType: 'script'
  });
  assert.strictEqual(result, 'ok');
});

test('classifyAgentResult: ok for AI with non-empty stdout', () => {
  const result = classifyAgentResult({
    exitCode: 0,
    stderr: '',
    stdout: 'some output',
    timedOut: false,
    signal: null,
    parsedResult: { result: 'success' },
    agentType: 'ai'
  });
  assert.strictEqual(result, 'ok');
});

test('classifyAgentResult: error fallback for non-zero exit code without specific error signature', () => {
  const result = classifyAgentResult({
    exitCode: 1,
    stderr: 'some generic error',
    stdout: '',
    timedOut: false,
    signal: null,
    parsedResult: null,
    agentType: 'ai'
  });
  assert.strictEqual(result, 'error');
});
