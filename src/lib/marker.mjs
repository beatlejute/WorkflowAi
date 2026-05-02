import fs from 'fs';
import path from 'path';

const MARKER_FILE = '.pipeline.lock';
const LOGS_DIR = '.workflow/logs';

/**
 * Ensures the logs directory exists
 */
function ensureLogsDir(projectRoot) {
  const logsPath = path.join(projectRoot, LOGS_DIR);
  if (!fs.existsSync(logsPath)) {
    fs.mkdirSync(logsPath, { recursive: true });
  }
}

/**
 * Atomic write via temp file + rename.
 * Fallback to O_EXCL (wx flag) on EXDEV/ENOTSUP.
 * Throws Error if marker file already exists (to prevent race conditions).
 */
export function writeMarker(projectRoot, payload) {
  ensureLogsDir(projectRoot);
  const markerPath = path.join(projectRoot, LOGS_DIR, MARKER_FILE);
  const content = JSON.stringify(payload, null, 2);

  // First, try exclusive create (O_EXCL) - this guarantees atomicity
  // and prevents race conditions where two processes both think they created the marker
  try {
    const fd = fs.openSync(markerPath, 'wx');
    fs.writeFileSync(fd, content, 'utf-8');
    fs.closeSync(fd);
    return;
  } catch (openErr) {
    if (openErr.code === 'EEXIST') {
      // Marker already exists - another process created it
      throw new Error(`Marker file already exists at ${markerPath}`);
    }
    // If EXDEV/ENOTSUP (cross-device link), fall back to temp+rename
    if (openErr.code !== 'EXDEV' && openErr.code !== 'ENOTSUP') {
      throw openErr;
    }
  }

  // Fallback: temp file + rename (less atomic but works across devices)
  const tempPath = markerPath + '.tmp.' + process.pid + '.' + Date.now();
  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, markerPath);
    return;
  } catch (renameErr) {
    // Cleanup temp file if it still exists
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }

    // If rename failed because marker was created by another process in the meantime
    if (renameErr.code === 'EEXIST' || !fs.existsSync(tempPath)) {
      throw new Error(`Marker file already exists at ${markerPath}`);
    }

    throw renameErr;
  }
}

/**
 * Reads and parses marker file. Returns null if file doesn't exist or is invalid.
 */
export function readMarker(projectRoot) {
  const markerPath = path.join(projectRoot, LOGS_DIR, MARKER_FILE);
  try {
    const data = fs.readFileSync(markerPath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    // ENOENT (file missing) or SyntaxError (invalid JSON) → return null
    return null;
  }
}

/**
 * Silently removes marker file. Ignores ENOENT.
 */
export function removeMarker(projectRoot) {
  const markerPath = path.join(projectRoot, LOGS_DIR, MARKER_FILE);
  try {
    fs.unlinkSync(markerPath);
  } catch (err) {
    // Ignore ENOENT — file already gone
    if (err.code !== 'ENOENT') {
      // Log warning but don't throw — silent unlink
      console.warn(`[marker] failed to remove ${markerPath}: ${err.message}`);
    }
  }
}

/**
 * Validates that marker exists and its pid matches expectedPid.
 * Returns true only if both conditions hold, false otherwise.
 */
export function validateMarker(projectRoot, expectedPid) {
  const marker = readMarker(projectRoot);
  if (!marker) {
    return false;
  }
  return marker.pid === expectedPid;
}
