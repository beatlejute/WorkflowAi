import { readMarker, removeMarker } from './marker.mjs';
import { processAlive } from './process-alive.mjs';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Gracefully stops a running pipeline.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {object} options - Options
 * @param {number} [options.graceSec=10] - Grace period in seconds before SIGKILL
 * @returns {object} Result object
 *   - { ok: true, pid: number, escalated: boolean, duration_ms: number } on success
 *   - { ok: true, was_stale: true } if marker existed but process was dead
 *   - { ok: false, code: 'NOT_RUNNING' } if no marker found
 */
export async function stopPipeline(projectRoot, options = {}) {
  const graceSec = options.graceSec ?? 10;
  const marker = readMarker(projectRoot);

  if (!marker) {
    return { ok: false, code: 'NOT_RUNNING' };
  }

  if (!processAlive(marker.pid)) {
    removeMarker(projectRoot);
    return { ok: true, was_stale: true };
  }

  const startMs = Date.now();
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    // taskkill /T /F /PID <pid> — kills process tree immediately (forceful)
    // No graceful period on Windows — taskkill /T does tree kill in one shot
    try {
      execSync(`taskkill /T /F /PID ${marker.pid}`, { stdio: 'ignore' });
    } catch (err) {
      // Ignore errors — process may have exited already
    }
  } else {
    // POSIX: send SIGTERM, wait, then escalate to SIGKILL if needed
    try {
      process.kill(marker.pid, 'SIGTERM');
    } catch (err) {
      // Process may have exited between check and kill
    }

    let escalated = false;
    const deadline = Date.now() + graceSec * 1000;

    while (processAlive(marker.pid)) {
      if (Date.now() >= deadline) {
        try {
          process.kill(marker.pid, 'SIGKILL');
          escalated = true;
        } catch (err) {
          // Process may have already exited
        }
        break;
      }
      await sleep(200);
    }
  }

  // Ensure marker is removed
  removeMarker(projectRoot);

  return {
    ok: true,
    pid: marker.pid,
    escalated: isWindows ? false : (escalated || false),
    duration_ms: Date.now() - startMs
  };
}
