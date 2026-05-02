import fs from 'node:fs';
import path from 'node:path';

const METRICS_PATH_REL = '.workflow/metrics/review-metrics.json';

function emptyAgentHistory() {
  return {
    total_attempts: 0,
    tickets_with_history_count: 0,
    by_status: {},
    by_agent: {},
    by_skill: {},
    by_skill_by_agent: {},
    fallback_stats: {
      tickets_with_fallback: 0,
      fallback_attempts_total: 0,
      ok_attempts_with_prior_failure: 0,
    },
    last_updated: '',
  };
}

function inc(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

export function incrementMetrics(projectRoot, entry, ticketId) {
  if (!entry || !entry.status || !entry.agent || !entry.skill) {
    return { ok: false, code: 'INVALID_ENTRY' };
  }

  const metrics = readMetricsFile(projectRoot);
  if (!metrics.agent_history) metrics.agent_history = emptyAgentHistory();
  const ah = metrics.agent_history;

  // Ensure shape (in case partial older structure)
  ah.by_status ||= {};
  ah.by_agent ||= {};
  ah.by_skill ||= {};
  ah.by_skill_by_agent ||= {};
  ah.fallback_stats ||= { tickets_with_fallback: 0, fallback_attempts_total: 0, ok_attempts_with_prior_failure: 0 };

  inc(ah.by_status, entry.status);
  ah.by_agent[entry.agent] ||= {};
  inc(ah.by_agent[entry.agent], entry.status);
  ah.by_skill[entry.skill] ||= {};
  inc(ah.by_skill[entry.skill], entry.status);
  ah.by_skill_by_agent[entry.skill] ||= {};
  ah.by_skill_by_agent[entry.skill][entry.agent] ||= {};
  inc(ah.by_skill_by_agent[entry.skill][entry.agent], entry.status);
  ah.total_attempts = (ah.total_attempts || 0) + 1;
  ah.last_updated = new Date().toISOString();

  // Atomic write
  const filePath = path.join(projectRoot, METRICS_PATH_REL);
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const tmp = path.join(dir, `.review-metrics.json.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(metrics, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
    return { ok: true };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, code: 'WRITE_ERROR', error: err.message };
  }
}

export function readMetricsFile(projectRoot) {
  const filePath = path.join(projectRoot, METRICS_PATH_REL);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    // Other read errors — treat as missing for graceful behavior
    console.warn(`review-metrics.json read error (${err.code}), starting fresh`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn('review-metrics.json corrupted, starting fresh');
    return {};
  }
}
