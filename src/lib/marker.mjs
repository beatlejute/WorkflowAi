import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

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
 * Atomic create via temp file + link: маркер появляется в каталоге целиком.
 * Fallback to temp + rename on file systems without hard links (EXDEV/ENOTSUP/EPERM/ENOSYS).
 * Throws Error if marker file already exists (to prevent race conditions).
 */
export function writeMarker(projectRoot, payload) {
  ensureLogsDir(projectRoot);
  const markerPath = path.join(projectRoot, LOGS_DIR, MARKER_FILE);
  const content = JSON.stringify(payload, null, 2);

  // Маркер появляется в каталоге целиком: содержимое пишется во временный файл рядом,
  // а под финальным именем файл возникает одной операцией link. Прежний порядок —
  // openSync(markerPath, 'wx') и запись вторым вызовом — оставлял окно, в котором файл
  // уже существует, но пуст, а readMarker на пустом содержимом отдаёт null, то есть
  // «пайплайн не запущен». Инцидент 2026-09-24: второй запуск в это окно не видел живой
  // маркер и шёл выполнять пайплайн параллельно первому (ровно то, что singleton и
  // предотвращает), а команда остановки отвечала «нечего останавливать».
  // link, а не rename: link падает с EEXIST на занятом имени и этим сохраняет
  // эксклюзивность создания, а rename молча перезаписал бы чужой живой маркер.
  const tempPath = path.join(
    path.dirname(markerPath),
    `.pipeline.lock.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
  );

  fs.writeFileSync(tempPath, content, 'utf-8');

  try {
    fs.linkSync(tempPath, markerPath);
    return;
  } catch (linkErr) {
    if (linkErr.code === 'EEXIST') {
      throw new Error(`Marker file already exists at ${markerPath}`);
    }
    // Файловая система без жёстких ссылок (EXDEV, ENOTSUP, EPERM, ENOSYS) — запасной путь
    // через rename: содержимое видно целиком, но эксклюзивность приходится проверять
    // отдельно, поэтому существующий маркер отсеивается до переименования.
    if (!['EXDEV', 'ENOTSUP', 'EPERM', 'ENOSYS'].includes(linkErr.code)) {
      throw linkErr;
    }
    if (fs.existsSync(markerPath)) {
      throw new Error(`Marker file already exists at ${markerPath}`);
    }
    fs.renameSync(tempPath, markerPath);
    return;
  } finally {
    // После link временное имя больше не нужно, после rename его уже нет.
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
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
