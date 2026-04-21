import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.mjs';
import { parseTtl } from './error-classifier.mjs';

const HEALTH_FILE = '.workflow/state/agent-health.json';
const LOCK_FILE = '.workflow/state/agent-health.json.lock';
const SUPPORTED_VERSION = '1.0';
const MAX_LOCK_RETRIES = 5;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_BACKOFFS = [100, 200, 400, 800, 1600];

const logger = createLogger();

export class AgentHealthLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentHealthLockError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

function getHealthFilePath(projectRoot) {
  return path.join(projectRoot, HEALTH_FILE);
}

function getLockFilePath(projectRoot) {
  return path.join(projectRoot, LOCK_FILE);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function parseTimestamp(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  return isNaN(date.getTime()) ? null : date.getTime();
}

function readHealthFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { version: SUPPORTED_VERSION, updated_at: null, agents: {} };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') {
      logger.warn(`agent-health-registry: corrupted JSON in ${filePath}, returning empty state`);
      return { version: SUPPORTED_VERSION, updated_at: null, agents: {} };
    }
    return {
      version: data.version || SUPPORTED_VERSION,
      updated_at: data.updated_at || null,
      agents: data.agents || {}
    };
  } catch (e) {
    logger.warn(`agent-health-registry: corrupted JSON in ${filePath}, returning empty state`);
    return { version: SUPPORTED_VERSION, updated_at: null, agents: {} };
  }
}

function writeHealthFileAtomic(filePath, data, lockFilePath, projectRoot) {
  const tmpPath = filePath + '.tmp';
  const dirPath = path.dirname(filePath);
  ensureDir(dirPath);

  const startTime = Date.now();
  for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= LOCK_TIMEOUT_MS) {
      throw new AgentHealthLockError(`Failed to acquire lock within ${LOCK_TIMEOUT_MS}ms`);
    }

    const backoff = LOCK_BACKOFFS[attempt];
    const remaining = LOCK_TIMEOUT_MS - elapsed;
    const sleepTime = Math.min(backoff, remaining);

    if (attempt > 0) {
      if (sleepTime > 0) {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const start = Date.now();
        while (Date.now() - start < sleepTime) {
          // busy wait
        }
      }
    }

    try {
      fs.openSync(lockFilePath, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') {
        continue;
      }
      throw e;
    }

    try {
      const content = JSON.stringify(data, null, 2);
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
      return;
    } finally {
      try {
        fs.unlinkSync(lockFilePath);
      } catch (e) {
        // ignore lock cleanup errors
      }
    }
  }

  throw new AgentHealthLockError(`Failed to acquire lock after ${MAX_LOCK_RETRIES} attempts`);
}

export function loadHealth(projectRoot, now = Date.now()) {
  const filePath = getHealthFilePath(projectRoot);
  const data = readHealthFile(filePath);
  pruneExpired(projectRoot, now);
  return { agents: data.agents };
}

export function markUnhealthy(projectRoot, agentId, options) {
  const { class: agentClass, rule_id, ttl, reason } = options;
  const filePath = getHealthFilePath(projectRoot);
  const lockPath = getLockFilePath(projectRoot);

  const existing = readHealthFile(filePath);
  const currentTime = new Date().toISOString();

  let untilMs;
  const now = Date.now();
  if (typeof ttl === 'number') {
    // Legacy: numeric milliseconds offset
    untilMs = now + ttl;
  } else if (typeof ttl === 'string') {
    // String TTL: 'until_utc_midnight', '1h', '5m', '1d', 'infinite', etc.
    try {
      untilMs = parseTtl(ttl, now);
    } catch {
      untilMs = now + 5 * 60 * 1000;
    }
  } else {
    untilMs = now + 5 * 60 * 1000;
  }

  const untilIso = new Date(untilMs).toISOString();

  existing.agents[agentId] = {
    status: 'unhealthy',
    class: agentClass,
    rule_id: rule_id || null,
    reason: reason || null,
    marked_at: currentTime,
    until: untilIso
  };
  existing.updated_at = currentTime;

  writeHealthFileAtomic(filePath, existing, lockPath, projectRoot);
}

export function markHealthy(projectRoot, agentId) {
  const filePath = getHealthFilePath(projectRoot);
  const lockPath = getLockFilePath(projectRoot);

  const existing = readHealthFile(filePath);

  if (existing.agents[agentId]) {
    delete existing.agents[agentId];
    existing.updated_at = new Date().toISOString();
    writeHealthFileAtomic(filePath, existing, lockPath, projectRoot);
  }
}

export function isHealthy(projectRoot, agentId, now = Date.now()) {
  const filePath = getHealthFilePath(projectRoot);
  const data = readHealthFile(filePath);
  const agent = data.agents[agentId];

  if (!agent) {
    return true;
  }

  if (agent.status !== 'unhealthy') {
    return true;
  }

  const untilMs = parseTimestamp(agent.until);
  if (untilMs === null) {
    return true;
  }

  return now >= untilMs;
}

export function unhealthy(projectRoot, now = Date.now()) {
  const filePath = getHealthFilePath(projectRoot);
  const data = readHealthFile(filePath);
  const result = [];

  for (const [agentId, agent] of Object.entries(data.agents)) {
    if (agent.status !== 'unhealthy') {
      continue;
    }
    const untilMs = parseTimestamp(agent.until);
    if (untilMs !== null && now < untilMs) {
      result.push({
        agentId,
        class: agent.class,
        rule_id: agent.rule_id,
        reason: agent.reason,
        until: agent.until
      });
    }
  }

  return result;
}

export function pruneExpired(projectRoot, now = Date.now()) {
  const filePath = getHealthFilePath(projectRoot);
  const lockPath = getLockFilePath(projectRoot);

  const existing = readHealthFile(filePath);
  let changed = false;

  for (const [agentId, agent] of Object.entries(existing.agents)) {
    if (agent.status !== 'unhealthy') {
      continue;
    }
    const untilMs = parseTimestamp(agent.until);
    if (untilMs !== null && now >= untilMs) {
      delete existing.agents[agentId];
      changed = true;
    }
  }

  if (changed) {
    existing.updated_at = new Date().toISOString();
    writeHealthFileAtomic(filePath, existing, lockPath, projectRoot);
  }
}