export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check, не убивает процесс
    return true;
  } catch (err) {
    // ESRCH = no process; EPERM = process exists but no permission
    if (err.code === 'EPERM') return true;
    return false;
  }
}
