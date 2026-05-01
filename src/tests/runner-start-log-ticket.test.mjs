import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

// Logger implementation for testing
class Logger {
  constructor(logFilePath, consoleLevel = 0) {
    this.logFilePath = logFilePath;
    this.consoleLevel = consoleLevel;
    this.context = null;
    this.stats = { info: 0, stagesStarted: 0 };
  }

  async init() {
    const dir = path.dirname(this.logFilePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.logFilePath, '');
  }

  _formatTimestamp() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
  }

  _formatMessage(level, stage, message) {
    const timestamp = this._formatTimestamp();
    const stageTag = stage ? `[${stage}]` : '[Runner]';
    return `[${timestamp}] [${level}] ${stageTag} ${message}`;
  }

  _writeToFile(formattedMessage) {
    appendFileSync(this.logFilePath, formattedMessage + '\n', 'utf8');
  }

  _log(level, stage, message) {
    const formattedMessage = this._formatMessage(level, stage, message);
    this._writeToFile(formattedMessage);
    if (level === 'INFO') this.stats.info++;
  }

  info(message, stage) {
    this._log('INFO', stage, message);
  }

  stageStart(stageId, agentId, skillId) {
    this.stats.stagesStarted++;
    const ticketInfo = this.context && this.context.ticket_id ? ` ticket="${this.context.ticket_id}"` : '';
    this.info(`START stage="${stageId}" agent="${agentId}" skill="${skillId}"${ticketInfo}`, stageId);
  }
}

// QA-43 Test Suite
test('QA-43-001: START contains ticket="HUMAN-5" when context.ticket_id is set', async () => {
  const tmpDir = join(tmpdir(), `qa-43-test-001-${Date.now()}`);
  const logFilePath = join(tmpDir, 'runner.log');

  try {
    mkdirSync(tmpDir, { recursive: true });

    const logger = new Logger(logFilePath);
    await logger.init();
    logger.context = { ticket_id: 'HUMAN-5' };

    logger.stageStart('test-stage', 'test-agent', 'test-skill');

    const logContent = readFileSync(logFilePath, 'utf8');
    assert.ok(
      logContent.includes('ticket="HUMAN-5"'),
      'START log should contain ticket="HUMAN-5"'
    );
    assert.ok(
      logContent.includes('START stage="test-stage"'),
      'START log should contain stage'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('QA-43-002: START does not contain ticket= when context.ticket_id is undefined', async () => {
  const tmpDir = join(tmpdir(), `qa-43-test-002-${Date.now()}`);
  const logFilePath = join(tmpDir, 'runner.log');

  try {
    mkdirSync(tmpDir, { recursive: true });

    const logger = new Logger(logFilePath);
    await logger.init();
    logger.context = null;

    logger.stageStart('test-stage', 'test-agent', 'test-skill');

    const logContent = readFileSync(logFilePath, 'utf8');
    assert.ok(
      !logContent.includes('ticket='),
      'START log should not contain ticket= when context.ticket_id is undefined'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('QA-43-003: START does not contain ticket= when context.ticket_id is empty', async () => {
  const tmpDir = join(tmpdir(), `qa-43-test-003-${Date.now()}`);
  const logFilePath = join(tmpDir, 'runner.log');

  try {
    mkdirSync(tmpDir, { recursive: true });

    const logger = new Logger(logFilePath);
    await logger.init();
    logger.context = { ticket_id: '' };

    logger.stageStart('test-stage', 'test-agent', 'test-skill');

    const logContent = readFileSync(logFilePath, 'utf8');
    assert.ok(
      !logContent.includes('ticket='),
      'START log should not contain ticket= when context.ticket_id is empty'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('QA-43-004: START contains ticket="IMPL-60" with default format', async () => {
  const tmpDir = join(tmpdir(), `qa-43-test-004-${Date.now()}`);
  const logFilePath = join(tmpDir, 'runner.log');

  try {
    mkdirSync(tmpDir, { recursive: true });

    const logger = new Logger(logFilePath);
    await logger.init();
    logger.context = { ticket_id: 'IMPL-60' };

    logger.stageStart('decompose-plan', 'decompose', 'decompose-plan');

    const logContent = readFileSync(logFilePath, 'utf8');
    assert.ok(
      logContent.includes('ticket="IMPL-60"'),
      'START log should contain ticket="IMPL-60"'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('QA-43-005: START contains ticket field at the end (field order)', async () => {
  const tmpDir = join(tmpdir(), `qa-43-test-005-${Date.now()}`);
  const logFilePath = join(tmpDir, 'runner.log');

  try {
    mkdirSync(tmpDir, { recursive: true });

    const logger = new Logger(logFilePath);
    await logger.init();
    logger.context = { ticket_id: 'QA-43' };

    logger.stageStart('verify-artifacts', 'verify', 'verify-artifacts');

    const logContent = readFileSync(logFilePath, 'utf8');

    // Check that ticket field comes after skill
    const startMatch = logContent.match(
      /START stage="[^"]*" agent="[^"]*" skill="[^"]*" ticket="[^"]*"/
    );
    assert.ok(
      startMatch,
      'Fields should be in order: stage, agent, skill, ticket'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('QA-43-006: context.ticket_id with hyphens is preserved correctly', async () => {
  const tmpDir = join(tmpdir(), `qa-43-test-006-${Date.now()}`);
  const logFilePath = join(tmpDir, 'runner.log');

  try {
    mkdirSync(tmpDir, { recursive: true });

    const logger = new Logger(logFilePath);
    await logger.init();
    logger.context = { ticket_id: 'HUMAN-123-ABC' };

    logger.stageStart('review', 'review-agent', 'review-skill');

    const logContent = readFileSync(logFilePath, 'utf8');
    assert.ok(
      logContent.includes('ticket="HUMAN-123-ABC"'),
      'START log should correctly contain ticket_id with hyphens'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
