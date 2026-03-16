import fs from 'fs';
import path from 'path';
import { findProjectRoot } from './find-root.mjs';

const LEVELS = {
  DEBUG: -1,
  INFO: 0,
  WARN: 1,
  ERROR: 2
};

const COLORS = {
  DEBUG: '\x1b[90m',
  INFO: '\x1b[36m',
  WARN: '\x1b[33m',
  ERROR: '\x1b[31m',
  RESET: '\x1b[0m'
};

function formatTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

function ensureLogDir(logFilePath) {
  const logDir = path.dirname(logFilePath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

function createLogger(logFilePath = null, consoleLevel = LEVELS.INFO) {
  const projectRoot = findProjectRoot();
  const defaultLogPath = path.join(projectRoot, '.workflow/logs/pipeline.log');
  const logPath = logFilePath || defaultLogPath;
  
  ensureLogDir(logPath);

  function writeToFile(formatted) {
    fs.appendFileSync(logPath, formatted + '\n', 'utf8');
  }

  function writeToConsole(formatted, level) {
    if (LEVELS[level] < consoleLevel) return;
    
    const color = COLORS[level];
    const reset = COLORS.RESET;
    
    if (level === 'ERROR') {
      console.error(`${color}${formatted}${reset}`);
    } else if (level === 'WARN') {
      console.warn(`${color}${formatted}${reset}`);
    } else {
      console.log(`${color}${formatted}${reset}`);
    }
  }

  function log(level, message) {
    const timestamp = formatTimestamp();
    const formatted = `[${timestamp}] [${level}] ${message}`;
    writeToFile(formatted);
    writeToConsole(formatted, level);
  }

  return {
    debug: (message) => log('DEBUG', message),
    info: (message) => log('INFO', message),
    warn: (message) => log('WARN', message),
    error: (message) => log('ERROR', message)
  };
}

export { createLogger, LEVELS };
