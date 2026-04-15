#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import crypto from 'crypto';
import yaml from './lib/js-yaml.mjs';
import { findProjectRoot } from './lib/find-root.mjs';

// ============================================================================
// Logger — система логирования с уровнями DEBUG/INFO/WARN/ERROR
// ============================================================================
class Logger {
  static LEVELS = {
    DEBUG: -1,
    INFO: 0,
    WARN: 1,
    ERROR: 2
  };

  static COLORS = {
    DEBUG: '\x1b[90m',   // gray
    INFO: '\x1b[36m',    // cyan
    WARN: '\x1b[33m',    // yellow
    ERROR: '\x1b[31m',   // red
    RESET: '\x1b[0m'
  };

  constructor(logFilePath, consoleLevel = Logger.LEVELS.INFO) {
    this.logFilePath = logFilePath;
    this.consoleLevel = consoleLevel;
    this.stats = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      stagesStarted: 0,
      stagesCompleted: 0,
      stagesFailed: 0,
      cliCalls: 0,
      gotoTransitions: 0,
      retries: 0,
      startTime: null,
      endTime: null
    };
  }

  /**
   * Создаёт директорию для логов если она не существует
   */
  _ensureLogDirectory() {
    const logDir = path.dirname(this.logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
      console.log(`[Logger] Created log directory: ${logDir}`);
    }
  }

  /**
   * Открывает файл для записи (append mode)
   */
  _openFile() {
    // Создаём директорию и файл если не существуют
    this._ensureLogDirectory();
    if (!fs.existsSync(this.logFilePath)) {
      fs.writeFileSync(this.logFilePath, '');
    }
    this.stats.startTime = new Date();
  }

  /**
   * Инициализирует logger
   */
  async init() {
    this._openFile();
  }

  /**
   * Форматирует timestamp для логов
   */
  _formatTimestamp() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
  }

  /**
   * Форматирует сообщение для вывода
   */
  _formatMessage(level, stage, message) {
    const timestamp = this._formatTimestamp();
    const stageTag = stage ? `[${stage}]` : '[Runner]';
    const prefix = `[${timestamp}] [${level}] ${stageTag} `;
    const lines = message.split('\n');
    if (lines.length === 1) {
      return `${prefix}${message}`;
    }
    const indent = ' '.repeat(prefix.length);
    return lines.map((line, i) => i === 0 ? `${prefix}${line}` : `${indent}${line}`).join('\n');
  }

  /**
   * Записывает лог в файл (синхронно)
   */
  _writeToFile(formattedMessage) {
    fs.appendFileSync(this.logFilePath, formattedMessage + '\n', 'utf8');
  }

  /**
   * Выводит в консоль с цветом
   */
  _writeToConsole(formattedMessage, level) {
    if (Logger.LEVELS[level] < this.consoleLevel) {
      return;
    }

    const color = Logger.COLORS[level];
    const reset = Logger.COLORS.RESET;

    if (level === 'ERROR') {
      console.error(`${color}${formattedMessage}${reset}`);
    } else if (level === 'WARN') {
      console.warn(`${color}${formattedMessage}${reset}`);
    } else {
      console.log(`${color}${formattedMessage}${reset}`);
    }
  }

  /**
   * Базовый метод логирования
   */
  _log(level, stage, message) {
    const formattedMessage = this._formatMessage(level, stage, message);
    this._writeToFile(formattedMessage);
    this._writeToConsole(formattedMessage, level);

    // Обновляем статистику
    if (level === 'DEBUG') this.stats.debug++;
    else if (level === 'INFO') this.stats.info++;
    else if (level === 'WARN') this.stats.warn++;
    else if (level === 'ERROR') this.stats.error++;
  }

  /**
   * Логгирует INFO сообщение
   */
  info(message, stage) {
    this._log('INFO', stage, message);
  }

  /**
   * Логгирует WARN сообщение
   */
  warn(message, stage) {
    this._log('WARN', stage, message);
  }

  /**
   * Логгирует ERROR сообщение
   */
  error(message, stage) {
    this._log('ERROR', stage, message);
  }

  /**
   * Логгирует DEBUG сообщение
   */
  debug(message, stage) {
    this._log('DEBUG', stage, message);
  }

  /**
   * Логгирует старт stage
   */
  stageStart(stageId, agentId, skillId) {
    this.stats.stagesStarted++;
    this.info(`START stage="${stageId}" agent="${agentId}" skill="${skillId}"`, stageId);
  }

  /**
   * Логгирует завершение stage
   */
  stageComplete(stageId, status, exitCode) {
    this.stats.stagesCompleted++;
    this.info(`COMPLETE stage="${stageId}" status="${status}" exitCode=${exitCode}`, stageId);
  }

  /**
   * Логгирует ошибку stage
   */
  stageError(stageId, errorMessage) {
    this.stats.stagesFailed++;
    this.error(`ERROR stage="${stageId}" message="${errorMessage}"`, stageId);
  }

  /**
   * Логгирует goto переход
   */
  gotoTransition(fromStage, toStage, status, params = {}) {
    this.stats.gotoTransitions++;
    const paramsStr = Object.keys(params).length > 0 ? ` params=${JSON.stringify(params)}` : '';
    this.info(`GOTO ${fromStage} → ${toStage} status="${status}"${paramsStr}`, fromStage);
  }

  /**
   * Логгирует вызов CLI
   */
  cliCall(command, args, exitCode) {
    this.stats.cliCalls++;
    this.info(`CLI command="${command}" args="${args.join(' ')}" exitCode=${exitCode}`, 'CLI');
  }

  /**
   * Логгирует retry попытку
   */
  retry(stageId, attempt, maxAttempts) {
    this.stats.retries++;
    this.warn(`RETRY stage="${stageId}" attempt=${attempt}/${maxAttempts}`, stageId);
  }

  /**
   * Логгирует таймаут
   */
  timeout(stageId, timeoutSeconds) {
    this.error(`TIMEOUT stage="${stageId}" after ${timeoutSeconds}s`, stageId);
  }

  /**
   * Записывает итоговый summary
   */
  writeSummary() {
    this.stats.endTime = new Date();
    const duration = this.stats.endTime - this.stats.startTime;

    const summary = [
      '',
      '═══════════════════════════════════════════════════════════',
      '                    PIPELINE SUMMARY',
      '═══════════════════════════════════════════════════════════',
      '',
      `Duration: ${(duration / 1000).toFixed(2)}s`,
      '',
      '┌─────────────────────────────────────────────────────────┐',
      '│ LOG STATISTICS                                          │',
      '├─────────────────────────────────────────────────────────┤',
      `│ DEBUG messages:    ${String(this.stats.debug).padEnd(34)}│`,
      `│ INFO messages:     ${String(this.stats.info).padEnd(34)}│`,
      `│ WARN messages:     ${String(this.stats.warn).padEnd(34)}│`,
      `│ ERROR messages:    ${String(this.stats.error).padEnd(34)}│`,
      '├─────────────────────────────────────────────────────────┤',
      '│ STAGE STATISTICS                                        │',
      '├─────────────────────────────────────────────────────────┤',
      `│ Stages started:   ${String(this.stats.stagesStarted).padEnd(34)}│`,
      `│ Stages completed: ${String(this.stats.stagesCompleted).padEnd(34)}│`,
      `│ Stages failed:    ${String(this.stats.stagesFailed).padEnd(34)}│`,
      '├─────────────────────────────────────────────────────────┤',
      '│ ACTIVITY STATISTICS                                     │',
      '├─────────────────────────────────────────────────────────┤',
      `│ CLI calls:        ${String(this.stats.cliCalls).padEnd(34)}│`,
      `│ GOTO transitions: ${String(this.stats.gotoTransitions).padEnd(34)}│`,
      `│ Retries:          ${String(this.stats.retries).padEnd(34)}│`,
      '└─────────────────────────────────────────────────────────┘',
      '',
      '═══════════════════════════════════════════════════════════'
    ].join('\n');

    // Вывод summary в консоль (всегда, независимо от уровня)
    console.log(summary);

    // Запись summary в файл
    this._writeToFile(summary);
  }

}

// ============================================================================
// PromptBuilder — формирует промпты для CLI-агентов с подстановкой контекста
// ============================================================================
class PromptBuilder {
  constructor(context, counters, previousResults = {}) {
    this.context = context;
    this.counters = counters;
    this.previousResults = previousResults;
  }

  /**
   * Формирует промпт для агента на основе skill инструкции
   * @param {object} stage - Stage из конфигурации
   * @param {string} stageId - ID stage
   * @returns {string} Промпт для агента
   */
  build(stage, stageId) {
    const parts = [stage.skill || stageId];

    // Добавляем контекст если есть непустые значения
    const contextEntries = Object.entries(this.context)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '');
    if (contextEntries.length > 0) {
      parts.push('\n\nContext:');
      for (const [key, value] of contextEntries) {
        parts.push(`  ${key}: ${value}`);
      }
    }

    // Добавляем счётчики если есть
    const counterEntries = Object.entries(this.counters)
      .filter(([_, v]) => v > 0);
    if (counterEntries.length > 0) {
      parts.push('\nCounters:');
      for (const [key, value] of counterEntries) {
        parts.push(`  ${key}: ${value}`);
      }
    }

    // Добавляем блок Instructions если поле instructions задано и непустое
    if (stage.instructions && typeof stage.instructions === 'string' && stage.instructions.trim() !== '') {
      parts.push('\n\nInstructions:');
      parts.push(this.interpolate(stage.instructions.trim()));
    }

    return parts.join('\n');
  }

  /**
   * Форматирует контекст для вывода
   */
  formatContext() {
    const entries = Object.entries(this.context)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `  ${k}: ${v}`);
    return entries.length > 0 ? entries.join('\n') : '  (пусто)';
  }

  /**
   * Форматирует счётчики для вывода
   */
  formatCounters() {
    const entries = Object.entries(this.counters)
      .map(([k, v]) => `  ${k}: ${v}`);
    return entries.length > 0 ? entries.join('\n') : '  (пусто)';
  }

  /**
   * Форматирует результаты предыдущих stages
   */
  formatPreviousResults() {
    const entries = Object.entries(this.previousResults)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
    return entries.length > 0 ? entries.join('\n') : '  (нет результатов)';
  }

  /**
   * Интерполирует переменные в строке
   * Поддерживает: $result.field, $context.field, $counter.field
   * @param {string} template - Строка с переменными
   * @param {object} resultData - Данные результата для $result.*
   * @returns {string} Строка с подставленными значениями
   */
  interpolate(template, resultData = {}) {
    if (typeof template !== 'string') {
      return template;
    }

    let resolved = template;

    // $result.* - подстановка из результата
    resolved = resolved.replace(/\$result\.(\w+)/g, (_, key) => {
      return resultData[key] !== undefined ? resultData[key] : '';
    });

    // $context.* - подстановка из контекста
    resolved = resolved.replace(/\$context\.(\w+)/g, (_, key) => {
      return this.context[key] !== undefined ? this.context[key] : '';
    });

    // $counter.* - подстановка из счётчиков
    resolved = resolved.replace(/\$counter\.(\w+)/g, (_, key) => {
      return this.counters[key] !== undefined ? this.counters[key] : 0;
    });

    return resolved;
  }
}

// ============================================================================
// ResultParser — парсит вывод агентов и извлекает структурированные данные
// ============================================================================
class ResultParser {
  // Карта нормализации статусов: синонимы → каноническое значение
  static STATUS_ALIASES = {
    pass:        'passed',
    approved:    'passed',
    success:     'passed',
    succeeded:   'passed',
    ok:          'passed',
    accepted:    'passed',
    lgtm:        'passed',
    fixed:       'passed',
    resolved:    'passed',
    fail:        'failed',
    rejected:    'failed',
    denied:      'failed',
    not_passed:  'failed',
    err:         'error',
    crash:       'error',
    timeout:     'error',
  };

  /**
   * Нормализует статус: приводит синонимы к каноническому значению
   * @param {string} status
   * @returns {string}
   */
  normalizeStatus(status) {
    const lower = status.toLowerCase();
    const canonical = ResultParser.STATUS_ALIASES[lower];
    if (canonical) {
      console.log(`[ResultParser] Normalized status: "${status}" → "${canonical}"`);
      return canonical;
    }
    return status;
  }

  /**
   * Парсит вывод агента и извлекает результат между маркерами
   * @param {string} output - stdout агента
   * @param {string} stageId - ID stage для логирования
   * @returns {{status: string, data: object, raw: string}}
   */
  parse(output, stageId) {
    const marker = '---RESULT---';

    // Попытка найти парные маркеры
    const startIdx = output.indexOf(marker);
    const endIdx = startIdx !== -1 ? output.indexOf(marker, startIdx + marker.length) : -1;

    if (startIdx !== -1 && endIdx !== -1) {
      // Найдены маркеры — парсим структурированный блок
      const resultBlock = output.substring(startIdx + marker.length, endIdx).trim();
      const data = this.parseResultBlock(resultBlock);

      const normalizedStatus = this.normalizeStatus(data.status || 'default');
      console.log(`[ResultParser] Parsed structured result for ${stageId}: status=${normalizedStatus}`);

      return {
        status: normalizedStatus,
        data: data.data || {},
        raw: output,
        parsed: true
      };
    }

    // Fallback: пытаемся парсить текстовый вывод
    console.log(`[ResultParser] No result markers found for ${stageId}, attempting fallback parsing`);
    return this.fallbackParse(output, stageId);
  }

  /**
   * Парсит блок результата в формате key: value с поддержкой многострочных YAML-значений.
   * При обнаружении ключа без значения (key:) читает последующие индентированные строки
   * как тело значения до следующего ключа верхнего уровня (строки без indent).
   * @param {string} block - Текстовый блок результата
   * @returns {{status: string, data: object}}
   */
  parseResultBlock(block) {
    const lines = block.split('\n');
    const data = {};
    let status = 'default';
    let currentKey = null;
    let multilineValue = null;

    const flushMultiline = () => {
      if (currentKey !== null && multilineValue !== null) {
        // Убираем trailing newline, сохраняем сырой YAML-блок
        data[currentKey] = multilineValue.replace(/\n$/, '');
        currentKey = null;
        multilineValue = null;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Проверяем: строка верхнего уровня (без indent) с ключом
      const topLevelMatch = line.match(/^([^:\s][^:]*):\s*(.*)$/);

      if (topLevelMatch) {
        // Если копим многострочное значение — сбрасываем
        flushMultiline();

        const key = topLevelMatch[1].trim();
        const value = topLevelMatch[2].trim();

        if (value !== '') {
          // Однострочное key: value — как прежде
          if (key === 'status') {
            status = value;
          } else {
            data[key] = value;
          }
        } else {
          // Ключ без значения — потенциальное многострочное YAML-значение
          currentKey = key;
          multilineValue = '';
        }
      } else if (currentKey !== null && (line.startsWith(' ') || line.startsWith('\t') || line === '')) {
        // Индентированная строка (или пустая) — накапливаем как тело multiline-значения
        multilineValue += line + '\n';
      } else if (currentKey !== null) {
        // Строка без indent и не key: value — конец multiline-блока
        flushMultiline();
      }
      // Игнорируем строки без ключа верхнего уровня если не в multiline-режиме
    }

    // Сбрасываем последнее multiline-значение
    flushMultiline();

    return { status, data };
  }

  /**
   * Fallback-парсинг для вывода без маркеров
   * Пытается извлечь статус из текстового вывода
   * @param {string} output - stdout агента
   * @param {string} stageId - ID stage для логирования
   * @returns {{status: string, data: object, raw: string}}
   */
  fallbackParse(output, stageId) {
    const lines = output.split('\n');
    let status = 'default';
    const extractedData = {};
    let inResultSection = false;

    // Ищем паттерны вида "status: xxx" или "Status: xxx" в любом месте вывода
    for (const line of lines) {
      const trimmedLine = line.trim();

      // Паттерн для извлечения статуса
      const statusMatch = trimmedLine.match(/^(?:status|Status):\s*(\w+)/i);
      if (statusMatch) {
        status = statusMatch[1];
        inResultSection = true;
        continue;
      }

      // Если нашли статус, пытаемся извлечь дополнительные данные
      if (inResultSection) {
        const dataMatch = trimmedLine.match(/^(\w+):\s*(.+)$/i);
        if (dataMatch && dataMatch[1].toLowerCase() !== 'status') {
          extractedData[dataMatch[1]] = dataMatch[2];
        }
      }
    }

    // Если статус не найден, пытаемся определить по ключевым словам
    if (status === 'default') {
      const lowerOutput = output.toLowerCase();
      if (lowerOutput.includes('completed') || lowerOutput.includes('success') || lowerOutput.includes('done')) {
        status = 'default';
        extractedData._inferred = 'success_keywords';
      } else if (lowerOutput.includes('error') || lowerOutput.includes('failed')) {
        status = 'error';
        extractedData._inferred = 'error_keywords';
      }
    }

    const normalizedStatus = this.normalizeStatus(status);
    console.log(`[ResultParser] Fallback parsing for ${stageId}: status=${normalizedStatus}`);

    return {
      status: normalizedStatus,
      data: extractedData,
      raw: output,
      parsed: false
    };
  }
}

// ============================================================================
// FileGuard — защита файлов от несанкционированного изменения агентами
// ============================================================================
class FileGuard {
  constructor(patterns, projectRoot = process.cwd(), trustedAgents = [], trustedStages = []) {
    this.enabled = patterns && patterns.length > 0;
    this.snapshots = new Map();
    this.patterns = (patterns || []).map(p => {
      if (typeof p === 'string') {
        return { pattern: p.replace(/\\/g, '/'), mode: 'full' };
      }
      return { pattern: p.pattern.replace(/\\/g, '/'), mode: p.mode || 'full' };
    });
    // projectRoot — корневая директория проекта, относительно которой указаны паттерны
    this.projectRoot = projectRoot;
    // Доверенные агенты — для них FileGuard не откатывает изменения
    this.trustedAgents = trustedAgents;
    // Доверенные стейджи — для них FileGuard не откатывает изменения
    this.trustedStages = trustedStages;
  }

  /**
   * Проверяет, является ли агент или стейдж доверенным (пропускает FileGuard)
   * Поддерживает glob-паттерны: "script-*" соответствует "script-move", "script-pick" и т.д.
   * @param {string} agentId - ID агента
   * @param {string} [stageId] - ID стейджа (опционально)
   * @returns {boolean}
   */
  isTrusted(agentId, stageId) {
    // Проверка по trustedAgents (glob-паттерны)
    const agentMatch = this.trustedAgents.some(pattern => {
      if (pattern.endsWith('*')) {
        return agentId.startsWith(pattern.slice(0, -1));
      }
      return agentId === pattern;
    });
    if (agentMatch) return true;

    // Проверка по trustedStages (точное совпадение)
    if (stageId && this.trustedStages.includes(stageId)) {
      return true;
    }

    return false;
  }

  /**
   * Проверяет, соответствует ли путь файла защищённым паттернам
   * @param {string} filePath - Путь к файлу (нормализованный через /)
   * @returns {boolean}
   */
  matchesProtected(filePath) {
    const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
    return this.patterns.some(p => this._matchGlob(relativePath, p.pattern));
  }

  /**
   * Glob-сопоставление: поддерживает * (в пределах директории) и ** (через директории)
   * @param {string} filePath - Нормализованный путь
   * @param {string} pattern - Glob-паттерн
   * @returns {boolean}
   */
  _matchGlob(filePath, pattern) {
    const normalizedPattern = pattern.replace(/\\/g, '/');
    const regexStr = normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // экранируем regex-символы (кроме *)
      .replace(/\*\*/g, '\x00')              // ** → временный placeholder
      .replace(/\*/g, '[^/]*')               // * → совпадение внутри директории
      .replace(/\x00/g, '.*');              // placeholder → .* (через директории)
    return new RegExp('^' + regexStr + '$').test(filePath);
  }

  /**
   * Извлекает базовую директорию из glob-паттерна (до первого wildcard)
   * @param {string} pattern - Glob-паттерн
   * @returns {string} Базовая директория
   */
  _getBaseDir(pattern) {
    const parts = pattern.replace(/\\/g, '/').split('/');
    const nonWildcardParts = [];
    for (const part of parts) {
      if (part.includes('*')) break;
      nonWildcardParts.push(part);
    }
    return nonWildcardParts.join('/') || '.';
  }

  /**
   * Рекурсивно получает все файлы в директории
   * @param {string} dir - Директория для сканирования
   * @returns {string[]} Список путей к файлам (нормализованных через /)
    */
  _getAllFiles(dir) {
    const files = [];
    if (!fs.existsSync(dir)) return files;
    const stats = fs.statSync(dir);
    if (!stats.isDirectory()) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        files.push(...this._getAllFiles(entryPath));
      } else {
        files.push(entryPath);
      }
    }
    return files;
  }

  /**
   * Вычисляет SHA256-хэш содержимого файла
   * @param {string} filePath - Путь к файлу
   * @returns {string|null} Хэш или null если файл не существует
   */
  _hashFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Снимает snapshot защищённых файлов перед выполнением stage
   */
  takeSnapshot() {
    if (!this.enabled) return;
    this.snapshots.clear();

    for (const { pattern, mode } of this.patterns) {
      if (!pattern.includes('*')) {
        const absolutePath = path.resolve(this.projectRoot, pattern);
        if (fs.existsSync(absolutePath)) {
          if (mode === 'structure') {
            this.snapshots.set(absolutePath, { hash: this._hashFile(absolutePath), content: fs.readFileSync(absolutePath, null), mode: 'structure' });
          } else {
            this.snapshots.set(absolutePath, this._hashFile(absolutePath));
          }
        }
      } else {
        const baseDir = path.resolve(this.projectRoot, this._getBaseDir(pattern));
        const files = this._getAllFiles(baseDir);
        for (const filePath of files) {
          if (this.matchesProtected(filePath)) {
            if (mode === 'structure') {
              this.snapshots.set(filePath, { hash: this._hashFile(filePath), content: fs.readFileSync(filePath, null), mode: 'structure' });
            } else {
              this.snapshots.set(filePath, this._hashFile(filePath));
            }
          }
        }
      }
    }

    console.log(`[FileGuard] Snapshot taken: ${this.snapshots.size} protected files`);
  }

  /**
   * Проверяет целостность защищённых файлов и откатывает несанкционированные изменения.
   * Обнаруживает как изменения/удаления существующих файлов, так и создание новых.
   * @returns {string[]} Список изменённых (и откаченных) файлов
   */
  checkAndRollback() {
    if (!this.enabled) return [];

    const violations = [];

    for (const [filePath, snapshot] of this.snapshots) {
      const mode = snapshot.mode || 'full';
      if (mode === 'structure') {
        if (!fs.existsSync(filePath)) {
          violations.push(filePath);
          console.warn(`[FileGuard] WARNING: Protected file deleted: ${filePath}`);
          try {
            fs.writeFileSync(filePath, snapshot.content);
            console.warn(`[FileGuard] WARNING: Restored deleted file: ${filePath}`);
          } catch (err) {
            console.error(`[FileGuard] ERROR: Failed to restore ${filePath}: ${err.message}`);
          }
        }
      } else {
        const currentHash = this._hashFile(filePath);
        if (currentHash !== snapshot) {
          violations.push(filePath);
          console.warn(`[FileGuard] WARNING: Protected file modified: ${filePath}`);
          this._rollbackFile(filePath);
        }
      }
    }

    for (const { pattern, mode } of this.patterns) {
      const baseDir = pattern.includes('*')
        ? path.resolve(this.projectRoot, this._getBaseDir(pattern))
        : path.resolve(this.projectRoot, pattern);

      const currentFiles = this._getAllFiles(baseDir);
      for (const filePath of currentFiles) {
        if (this.matchesProtected(filePath) && !this.snapshots.has(filePath)) {
          violations.push(filePath);
          console.warn(`[FileGuard] WARNING: New file in protected area: ${filePath}`);
          this._removeNewFile(filePath);
        }
      }
    }

    if (violations.length > 0) {
      console.warn(`[FileGuard] WARNING: Rolled back ${violations.length} protected file(s): ${violations.join(', ')}`);
    } else {
      console.log('[FileGuard] No protected files were modified');
    }

    return violations;
  }

  /**
   * Удаляет файл, созданный агентом в защищённой директории
   * @param {string} filePath - Путь к файлу
   */
  _removeNewFile(filePath) {
    try {
      fs.unlinkSync(filePath);
      console.warn(`[FileGuard] WARNING: Removed unauthorized new file: ${filePath}`);
    } catch (err) {
      console.error(`[FileGuard] ERROR: Failed to remove ${filePath}: ${err.message}`);
    }
  }

  /**
   * Откатывает файл к последнему зафиксированному состоянию через git
   * @param {string} filePath - Путь к файлу
   */
  _rollbackFile(filePath) {
    try {
      execSync(`git checkout -- "${filePath}"`, { stdio: 'pipe' });
      console.warn(`[FileGuard] WARNING: Rolled back: ${filePath}`);
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      console.error(`[FileGuard] ERROR: Failed to rollback ${filePath}: ${errMsg}`);
    }
  }
}

// ============================================================================
// StageExecutor — выполняет stages через вызов CLI-агентов
// ============================================================================
class StageExecutor {
  constructor(config, context, counters, previousResults = {}, fileGuard = null, logger = null, projectRoot = process.cwd()) {
    this.config = config;
    this.context = context;
    this.counters = counters;
    this.previousResults = previousResults;
    this.pipeline = config.pipeline;
    this.projectRoot = projectRoot;
    this.fileGuard = fileGuard;
    this.logger = logger;

    // Инициализируем билдер и парсер
    this.promptBuilder = new PromptBuilder(context, counters, previousResults);
    this.resultParser = new ResultParser();

    // Текущий дочерний процесс агента (для kill при shutdown)
    this.currentChild = null;
  }

  /**
   * Убивает текущий дочерний процесс агента
   */
  killCurrentChild() {
    const child = this.currentChild;
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
      try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe' }); } catch {}
    } else {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  /**
   * Выполняет stage через CLI-агента с поддержкой fallback_agent
   * @param {string} stageId - ID stage из конфигурации
   * @returns {Promise<{status: string, output: string, result?: object}>}
   */
  async execute(stageId) {
    const stage = this.pipeline.stages[stageId];
    if (!stage) {
      throw new Error(`Stage not found: ${stageId}`);
    }

    // Выбираем агента по приоритету:
    // 1. attempt=1 → agent_by_type[task_type] (первая попытка — по типу задачи)
    // 2. attempt>1 → agent_by_attempt[counter] (повторные попытки — ротация)
    // 3. stage.agent — явно указанный агент stage
    // 4. default_agent — глобальный дефолт
    let agentId = stage.agent || this.pipeline.default_agent;
    let fallbackModelId = stage.fallback_agent;  // fallback_model из agent_by_type имеет приоритет
    const attempt = (stage.counter && this.counters[stage.counter]) || 0;

    // Фоллбэк: если task_type не задан, вычисляем из префикса ticket_id (PMA-005 → pma)
    const taskType = this.context.task_type
      || (this.context.ticket_id && this.context.ticket_id.split('-')[0].toLowerCase())
      || null;

    if (attempt <= 1 && stage.agent_by_type && taskType) {
      // Первая попытка: выбор по типу задачи
      const agentConfig = stage.agent_by_type[taskType];
      if (agentConfig) {
        // Поддержка формата: { agent: string, fallback_model: string } или просто string
        if (typeof agentConfig === 'object' && agentConfig.agent) {
          agentId = agentConfig.agent;
          if (agentConfig.fallback_model) {
            fallbackModelId = agentConfig.fallback_model;
          }
        } else {
          agentId = agentConfig;
        }
        if (this.logger) {
          this.logger.info(`Agent by type: task_type="${taskType}" → ${agentId}`, stageId);
        }
      }
    } else if (stage.agent_by_attempt && attempt > 1) {
      // Повторные попытки: ротация по agent_by_attempt
      if (stage.agent_by_attempt[attempt]) {
        agentId = stage.agent_by_attempt[attempt];
        if (this.logger) {
          this.logger.info(`Agent rotation: attempt ${attempt} → ${agentId}`, stageId);
        }
      }
    }

    const agent = this.pipeline.agents[agentId];
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Формируем промпт для агента через PromptBuilder
    const prompt = this.promptBuilder.build(stage, stageId);

    // Логгируем старт stage
    if (this.logger) {
      this.logger.stageStart(stageId, agentId, stage.skill);
    } else {
      console.log(`\n[StageExecutor] Executing stage: ${stageId}`);
      console.log(`  Agent: ${agentId} (${agent.command})`);
      console.log(`  Skill: ${stage.skill}`);
    }

    // Снимаем snapshot защищённых файлов перед выполнением (кроме trusted agents и trusted stages)
    const skipGuard = this.fileGuard && this.fileGuard.isTrusted(agentId, stageId);
    if (this.fileGuard && !skipGuard) {
      this.fileGuard.takeSnapshot();
    }

    // Вызываем CLI-агента с поддержкой fallback (приоритет: fallback_model из agent_by_type > stage.fallback_agent)
    const result = await this.callAgentWithFallback(agent, prompt, stageId, stage.skill, fallbackModelId);

    // Логгируем завершение stage
    if (this.logger) {
      this.logger.stageComplete(stageId, result.status, result.exitCode);
    }

    // Проверяем и откатываем несанкционированные изменения (кроме trusted agents)
    if (this.fileGuard && !skipGuard) {
      const violations = this.fileGuard.checkAndRollback();
      if (violations.length > 0) {
        result.violations = violations;
      }
    }

    return result;
  }

  /**
   * Вызывает CLI-агента через child_process
   */
  callAgent(agent, prompt, stageId, skillId) {
    return new Promise((resolve, reject) => {
      const timeout = this.pipeline.execution?.timeout_per_stage || 300;
      const args = [...agent.args];

      // Формируем финальный промпт (с ролью если есть -p с значением)
      const lastPIdx = args.lastIndexOf('-p');
      let finalPrompt;
      if (lastPIdx !== -1 && lastPIdx < args.length - 1) {
        const role = args[lastPIdx + 1];
        finalPrompt = `${prompt}\n\nТвоя роль: ${role}`;
      } else {
        finalPrompt = prompt;
      }

      // На Windows shell: true обрезает многострочные аргументы на \n (cmd.exe).
      // Поэтому передаём промпт через stdin, а -p оставляем без значения (print mode).
      const useShell = process.platform === 'win32' && agent.command !== 'node';
      const useStdin = useShell && finalPrompt.includes('\n');

      if (useStdin) {
        // Убираем значение промпта из аргументов — оно пойдёт через stdin
        if (lastPIdx !== -1 && lastPIdx < args.length - 1) {
          // -p было с ролью-промптом — убираем значение, оставляем -p (print mode)
          args.splice(lastPIdx + 1, 1);
        }
        // Для агентов без -p (kilo и т.д.) — промпт не добавляем в args, он пойдёт через stdin
      } else {
        // Однострочный промпт или не Windows — передаём через аргумент
        if (lastPIdx !== -1 && lastPIdx < args.length - 1) {
          args[lastPIdx + 1] = finalPrompt;
        } else {
          args.push(finalPrompt);
        }
      }

      // Логгируем команду перед запуском (вместо промпта — имя skill)
      if (this.logger) {
        this.logger.info(`RUN ${agent.command} ${[...args.slice(0, -1), skillId].join(' ')}`, stageId);
        // Логгируем входные параметры агента (context + counters)
        const promptLines = prompt.split('\n').filter(l => l.trim());
        if (promptLines.length > 1) {
          for (const line of promptLines.slice(1)) {
            this.logger.info(`  ${line}`, stageId);
          }
        }
      }

      const child = spawn(agent.command, args, {
        cwd: path.resolve(this.projectRoot, agent.workdir || '.'),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell
      });
      this.currentChild = child;

      // Передаём промпт через stdin или закрываем если не нужно
      if (useStdin) {
        child.stdin.write(finalPrompt);
        child.stdin.end();
      } else {
        child.stdin.end();
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Таймаут
      const timeoutId = setTimeout(() => {
        timedOut = true;
        // На Windows SIGTERM игнорируется — используем taskkill /T /F для убийства дерева
        if (process.platform === 'win32' && child.pid) {
          try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'pipe' }); } catch {}
        } else {
          child.kill('SIGTERM');
        }
        if (this.logger) {
          this.logger.timeout(stageId, timeout);
        }
        reject(new Error(`Stage "${stageId}" timed out after ${timeout}s`));
      }, timeout * 1000);

      let stdoutBuffer = '';
      let agentText = ''; // собираем текстовый вывод агента для лога
      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        // Парсим stream-json и выводим только текст дельт
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop(); // незавершённая строка остаётся в буфере
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            // Claude: content_block_delta с delta.text
            if (obj.type === 'content_block_delta' && obj.delta?.text) {
              process.stdout.write(obj.delta.text);
              agentText += obj.delta.text;
            }
            // Qwen/Claude: assistant message с content text
            else if (obj.type === 'assistant' && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === 'text' && block.text) {
                  process.stdout.write(block.text);
                  agentText += block.text;
                }
              }
            }
            // result содержит финальный текст (дублирует assistant) — пропускаем
          } catch {
            // не JSON — выводим как есть
            process.stdout.write(line + '\n');
            agentText += line + '\n';
          }
        }
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
        process.stderr.write(data);
      });

      child.on('close', (code) => {
        this.currentChild = null;
        clearTimeout(timeoutId);
        // Обрабатываем остаток буфера стриминга
        if (stdoutBuffer.trim()) {
          try {
            const obj = JSON.parse(stdoutBuffer);
            if (obj.type === 'content_block_delta' && obj.delta?.text) {
              process.stdout.write(obj.delta.text);
            }
          } catch {
            process.stdout.write(stdoutBuffer + '\n');
          }
        }
        process.stdout.write('\n');

        if (timedOut) return;

        // Логгируем CLI вызов
        if (this.logger) {
          this.logger.cliCall(agent.command, args, code);

          // Логгируем текстовый вывод агента
          const trimmedOutput = agentText.trim();
          if (trimmedOutput) {
            this.logger.info(`OUTPUT ↓`, stageId);
            for (const line of trimmedOutput.split('\n')) {
              this.logger.info(`  ${line}`, stageId);
            }
            this.logger.info(`OUTPUT ↑`, stageId);
          }

          // Логгируем stderr независимо от exit code
          if (stderr.trim()) {
            this.logger.warn(`STDERR ↓`, stageId);
            for (const line of stderr.trim().split('\n')) {
              this.logger.warn(`  ${line}`, stageId);
            }
            this.logger.warn(`STDERR ↑`, stageId);
          }
        }

        // Парсим результат из вывода агента через ResultParser
        const result = this.resultParser.parse(stdout, stageId);

        // Если exit code ≠ 0, но результат уже распарсен — используем его
        if (code !== 0 && result.parsed && result.status && result.status !== 'default') {
          if (this.logger) {
            this.logger.warn(
              `Agent exited with code ${code}, but RESULT was parsed (status: ${result.status}). Using parsed result.`,
              stageId
            );
          }
          // Проваливаемся в resolve ниже
        } else if (code !== 0) {
          const err = new Error(`Agent exited with code ${code}`);
          err.code = 'NON_ZERO_EXIT';
          err.exitCode = code;
          err.stderr = stderr;
          if (this.logger) {
            this.logger.error(`Agent exited with code ${code}`, stageId);
            if (stderr.trim()) {
              for (const line of stderr.trim().split('\n')) {
                this.logger.error(`  stderr: ${line}`, stageId);
              }
            }
          }
          reject(err);
          return;
        }

        resolve({
          status: result.status || 'default',
          output: stdout,
          stderr: stderr,
          result: result.data || {},
          exitCode: code,
          parsed: result.parsed
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        if (!timedOut) {
          if (this.logger) {
            this.logger.error(`CLI error: ${err.message}`, stageId);
          }
          reject(err);
        }
      });
    });
  }

  /**
   * Вызывает CLI-агента с поддержкой fallback_agent
   * При ошибке основного агента (exit code ≠ 0, ENOENT, таймаут) переключается на fallback_agent
   * @param {object} agent - Основной агент из конфигурации
   * @param {string} prompt - Промпт для агента
   * @param {string} stageId - ID stage для логирования
   * @param {string} skillId - ID skill для логирования
   * @param {string|null} fallbackAgentId - ID fallback агента (опционально)
   * @returns {Promise<{status: string, output: string, result?: object, exitCode: number}>}
   */
  async callAgentWithFallback(agent, prompt, stageId, skillId, fallbackAgentId) {
    try {
      // Пытаемся вызвать основной агент
      return await this.callAgent(agent, prompt, stageId, skillId);
    } catch (err) {
      // Проверяем, есть ли fallback_agent
      if (!fallbackAgentId) {
        // Fallback не задан — пробрасываем ошибку
        throw err;
      }

      // Проверяем тип ошибки — должна быть retry-able
      const isRetryableError =
        err.code === 'ENOENT' ||  // Команда не найдена
        err.code === 'ETIMEDOUT' ||  // Таймаут
        err.code === 'NON_ZERO_EXIT' ||  // Exit code ≠ 0
        err.message.includes('timed out');  // Таймаут от timeoutId

      if (!isRetryableError) {
        // Неретраемая ошибка — пробрасываем
        throw err;
      }

      // Логгируем переключение на fallback_agent
      if (this.logger) {
        this.logger.warn(`Primary agent failed, switching to fallback: ${fallbackAgentId}`, stageId);
      } else {
        console.log(`[StageExecutor] Primary agent failed, switching to fallback: ${fallbackAgentId}`);
      }

      // Находим fallback агента в конфигурации
      const fallbackAgent = this.pipeline.agents[fallbackAgentId];
      if (!fallbackAgent) {
        const errMsg = `Fallback agent not found: ${fallbackAgentId}`;
        if (this.logger) {
          this.logger.error(errMsg, stageId);
        } else {
          console.error(`[StageExecutor] ${errMsg}`);
        }
        throw err;  // Пробрасываем оригинальную ошибку
      }

      // Вызываем fallback агента
      try {
        return await this.callAgent(fallbackAgent, prompt, stageId, skillId);
      } catch (fallbackErr) {
        // Если fallback тоже упал — пробрасываем ошибку fallback агента
        if (this.logger) {
          this.logger.error(`Fallback agent also failed: ${fallbackErr.message}`, stageId);
        } else {
          console.error(`[StageExecutor] Fallback agent also failed: ${fallbackErr.message}`);
        }
        throw fallbackErr;
      }
    }
  }
}

// ============================================================================
// PipelineRunner — основной цикл выполнения пайплайна
// ============================================================================
class PipelineRunner {
  constructor(config, args) {
    this.config = config;
    this.args = args;
    this.pipeline = config.pipeline;
    this.context = { ...this.pipeline.context };
    this.counters = {};
    this.stepCount = 0;
    this.tasksExecuted = 0;
    this.running = true;
    this.currentStage = this.pipeline.entry;

    // Базовая директория проекта вычисляется динамически
    const projectRoot = args.project ? path.resolve(args.project) : findProjectRoot();

    // Инициализация Logger — каждый запуск пишется в отдельный файл
    const logDir = this.pipeline.execution?.log_file
      ? path.dirname(path.resolve(projectRoot, this.pipeline.execution.log_file))
      : path.resolve(projectRoot, '.workflow/logs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
    const logFilePath = path.resolve(logDir, `pipeline_${timestamp}.log`);
    this.logger = new Logger(logFilePath);
    this.loggerInitialized = false;

    // Инициализация контекста из CLI аргументов
    if (args.plan) {
      this.context.plan_id = args.plan;
    }

    // Инициализация FileGuard для защиты файлов от изменений агентами
    const protectedPatterns = this.pipeline.protected_files || [];
    const trustedAgents = this.pipeline.trusted_agents || [];
    const trustedStages = this.pipeline.trusted_stages || [];
    this.fileGuard = new FileGuard(protectedPatterns, projectRoot, trustedAgents, trustedStages);
    this.projectRoot = projectRoot;
    this.currentExecutor = null;

    // Настройка graceful shutdown
    this.setupGracefulShutdown();
  }

  /**
   * Асинхронно инициализирует runner (logger)
   */
  async init() {
    await this.logger.init();
    this.loggerInitialized = true;

    // Логгируем после инициализации
    const protectedPatterns = this.pipeline.protected_files || [];
    if (protectedPatterns.length > 0) {
      this.logger.info(`FileGuard enabled: ${protectedPatterns.length} pattern(s)`, 'PipelineRunner');
    }

    if (this.context.plan_id) {
      this.logger.info(`Plan ID: ${this.context.plan_id}`, 'PipelineRunner');
    } else {
      this.logger.info('No plan_id set — processing all tickets', 'PipelineRunner');
    }
  }

  /**
   * Выполняет встроенный стейдж типа update-counter:
   * инкрементирует счётчик и возвращает статус для goto-перехода.
   *
   * Конфигурация стейджа:
   *   type: update-counter
   *   counter: <name>   — имя счётчика
   *   max: <number>     — максимальное значение (опционально)
   *   goto:
   *     default: <stage>           — следующий стейдж
   *     max_reached: <stage>       — стейдж при достижении max
   */
  executeUpdateCounter(stageId, stage) {
    const counterName = stage.counter;
    if (!counterName) {
      throw new Error(`Stage "${stageId}" has type update-counter but no counter specified`);
    }

    this.counters[counterName] = (this.counters[counterName] || 0) + 1;
    const value = this.counters[counterName];

    if (this.logger) {
      this.logger.info(`Counter "${counterName}" incremented to ${value}`, stageId);
    }

    const max = stage.max;
    const status = (max && value >= max) ? 'max_reached' : 'default';

    return { status, result: { counter: counterName, value } };
  }

  /**
   * Запускает основной цикл выполнения
   */
  async run() {
    // Инициализируем logger
    await this.init();

    const maxSteps = this.pipeline.execution?.max_steps || 100;
    const delayBetweenStages = this.pipeline.execution?.delay_between_stages || 5;

    this.logger.info('=== Pipeline Runner Started ===', 'PipelineRunner');
    this.logger.info(`Entry stage: ${this.pipeline.entry}`, 'PipelineRunner');
    this.logger.info(`Max steps: ${maxSteps}`, 'PipelineRunner');
    this.logger.info(`Context: ${JSON.stringify(this.context)}`, 'PipelineRunner');

    while (this.running && this.stepCount < maxSteps) {
      this.stepCount++;

      this.logger.info(`Step ${this.stepCount}`, 'PipelineRunner');
      this.logger.info(`Current stage: ${this.currentStage}`, 'PipelineRunner');

      if (this.currentStage === 'end') {
        this.logger.info('Pipeline completed successfully!', 'PipelineRunner');
        break;
      }

      try {
        // Выполняем stage
        const stage = this.pipeline.stages[this.currentStage];
        if (!stage) {
          throw new Error(`Stage not found: ${this.currentStage}`);
        }

        let result;

        // Встроенный тип стейджа: update-counter — инкрементирует счётчик без вызова агента
        if (stage.type === 'update-counter') {
          result = this.executeUpdateCounter(this.currentStage, stage);
        } else {
          this.currentExecutor = new StageExecutor(this.config, this.context, this.counters, {}, this.fileGuard, this.logger, this.projectRoot);
          result = await this.currentExecutor.execute(this.currentStage);
          this.currentExecutor = null;
        }

        this.logger.info(`Stage ${this.currentStage} completed with status: ${result.status}`, 'PipelineRunner');

        // Определяем следующий stage по goto-логике
        const nextStage = this.resolveNextStage(this.currentStage, result);

        // Считаем выполненные задачи (execute-task)
        if (this.currentStage === 'execute-task' && result.status !== 'error') {
          this.tasksExecuted++;
        }

        // Переход к следующему stage
        this.currentStage = nextStage;

        // Задержка между stages
        if (nextStage !== 'end' && this.running) {
          this.logger.info(`Waiting ${delayBetweenStages}s before next stage...`, 'PipelineRunner');
          await this.sleep(delayBetweenStages * 1000);
        }

      } catch (err) {
        this.logger.error(`Error at stage "${this.currentStage}": ${err.message}`, 'PipelineRunner');

        // Пытаемся получить fallback transition
        const stage = this.pipeline.stages[this.currentStage];
        if (stage?.goto?.error) {
          const errorTarget = typeof stage.goto.error === 'string' ? stage.goto.error : stage.goto.error.stage;
          this.logger.info(`Transitioning to error handler: ${errorTarget}`, 'PipelineRunner');
          this.currentStage = errorTarget;

          // Обновляем контекст параметрами из error transition
          if (typeof stage.goto.error === 'object' && stage.goto.error.params) {
            this.updateContext(stage.goto.error.params, { error: err.message });
          }
        } else {
          this.logger.error('No error handler defined. Stopping.', 'PipelineRunner');
          this.running = false;
        }
      }
    }

    if (this.stepCount >= maxSteps) {
      this.logger.error(`Stopped: reached max steps limit (${maxSteps})`, 'PipelineRunner');
    }

    this.logger.info('=== Pipeline Runner Finished ===', 'PipelineRunner');
    this.logger.info(`Total steps: ${this.stepCount}`, 'PipelineRunner');
    this.logger.info(`Tasks executed: ${this.tasksExecuted}`, 'PipelineRunner');
    this.logger.info(`Final context: ${JSON.stringify(this.context)}`, 'PipelineRunner');

    // Записываем итоговый summary
    this.logger.writeSummary();

    return {
      steps: this.stepCount,
      tasksExecuted: this.tasksExecuted,
      context: this.context,
      failed: !this.running && this.stepCount < maxSteps
    };
  }

  /**
   * Определяет следующий stage на основе результата и goto-конфигурации
   * Также управляет retry-логикой с agent_by_attempt
   */
  resolveNextStage(stageId, result) {
    const stage = this.pipeline.stages[stageId];
    if (!stage || !stage.goto) {
      this.logger.gotoTransition(stageId, 'end', result.status);
      return 'end';
    }

    const goto = stage.goto;
    const status = result.status;

    // Проверяем точное совпадение статуса
    if (goto[status]) {
      const transition = goto[status];

      // Если переход задан строкой (shorthand: "stage-name")
      if (typeof transition === 'string') {
        this.logger.gotoTransition(stageId, transition, status);
        return transition;
      }

      // Обновляем контекст параметрами перехода
      if (transition.params) {
        this.updateContext(transition.params, result.result);
      }

      const nextStage = transition.stage || 'end';
      this.logger.gotoTransition(stageId, nextStage, status, transition.params);
      return nextStage;
    }

    // Fallback на default
    if (goto.default) {
      const transition = goto.default;

      if (typeof transition === 'string') {
        this.logger.gotoTransition(stageId, transition, 'default');
        return transition;
      }

      if (transition.params) {
        this.updateContext(transition.params, result.result);
      }

      const nextStage = transition.stage || 'end';
      this.logger.gotoTransition(stageId, nextStage, 'default', transition.params);
      return nextStage;
    }

    this.logger.gotoTransition(stageId, 'end', 'default');
    return 'end';
  }

  /**
   * Обновляет контекст переменными из params с подстановкой значений
   */
  updateContext(params, resultData) {
    if (!params) return;

    // Проверяем смену ticket_id для сброса счётчика попыток
    const newTicketId = params.ticket_id ?
      (typeof params.ticket_id === 'string' ?
        params.ticket_id
          .replace(/\$result\.(\w+)/g, (_, k) => resultData[k] || '')
          .replace(/\$context\.(\w+)/g, (_, k) => this.context[k] || '')
        : params.ticket_id)
      : null;

    if (newTicketId && this.context.ticket_id && newTicketId !== this.context.ticket_id) {
      // Тикет сменился — сбрасываем все счётчики попыток
      for (const counterKey of Object.keys(this.counters)) {
        if (counterKey.includes('attempt')) {
          this.counters[counterKey] = 0;
          if (this.logger) {
            this.logger.info(`Reset counter "${counterKey}" due to ticket change (${this.context.ticket_id} → ${newTicketId})`, 'PipelineRunner');
          }
        }
      }
    }

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        // Подстановка переменных: $context.*, $result.*, $counter.*
        let resolvedValue = value;

        // $result.*
        resolvedValue = resolvedValue.replace(/\$result\.(\w+)/g, (_, k) => resultData[k] || '');

        // $context.*
        resolvedValue = resolvedValue.replace(/\$context\.(\w+)/g, (_, k) => this.context[k] || '');

        // $counter.*
        resolvedValue = resolvedValue.replace(/\$counter\.(\w+)/g, (_, k) => this.counters[k] || 0);

        this.context[key] = resolvedValue;
      } else {
        this.context[key] = value;
      }
    }

    if (this.logger) {
      this.logger.info(`Context updated: ${JSON.stringify(this.context)}`, 'PipelineRunner');
    }
  }

  /**
   * Утилита для задержки
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Настройка graceful shutdown
   */
  setupGracefulShutdown() {
    const shutdown = (signal) => {
      if (this.logger) {
        this.logger.info(`Received ${signal}. Shutting down gracefully...`, 'PipelineRunner');
      }
      this.running = false;
      // Убиваем текущего агента
      if (this.currentExecutor) {
        this.currentExecutor.killCurrentChild();
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

function parseArgs(argv) {
  const args = {
    plan: null,
    config: null,
    project: null,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--plan':
        args.plan = argv[++i] || null;
        break;
      case '--config':
        args.config = argv[++i] || null;
        break;
      case '--project':
        args.project = argv[++i] || null;
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Workflow Runner - Pipeline Orchestrator

Usage: node runner.mjs [options]

Options:
  --plan PLAN-ID      Plan ID to execute (e.g., PLAN-003)
  --config PATH       Path to pipeline.yaml config (default: .workflow/config/pipeline.yaml)
  --project PATH      Project root path (overrides auto-detection)
  --help, -h          Show this help message

Examples:
  node .workflow/src/runner.mjs --help
  node .workflow/src/runner.mjs --plan PLAN-003
  node runner.mjs --project /path/to/project --plan PLAN-003
`);
}

function loadConfig(configPath) {
  const fullPath = path.resolve(configPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}`);
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const config = yaml.load(content);

  return config;
}

function validateConfig(config) {
  const errors = [];

  if (!config) {
    errors.push('Config is empty');
    return errors;
  }

  if (!config.pipeline) {
    errors.push('Missing required field: pipeline');
    return errors;
  }

  const pipeline = config.pipeline;

  if (!pipeline.name || typeof pipeline.name !== 'string') {
    errors.push('Missing or invalid required field: pipeline.name (string)');
  }

  if (!pipeline.version || typeof pipeline.version !== 'string') {
    errors.push('Missing or invalid required field: pipeline.version (string)');
  }

  if (!pipeline.agents || typeof pipeline.agents !== 'object') {
    errors.push('Missing or invalid required field: pipeline.agents (object)');
  }

  if (!pipeline.stages || typeof pipeline.stages !== 'object') {
    errors.push('Missing or invalid required field: pipeline.stages (object)');
  }

  if (pipeline.agents && pipeline.stages) {
    const agentIds = Object.keys(pipeline.agents);
    const stageIds = Object.keys(pipeline.stages);

    for (const [stageId, stage] of Object.entries(pipeline.stages)) {
      const resolvedAgent = stage.agent || pipeline.default_agent;
      if (resolvedAgent && !agentIds.includes(resolvedAgent)) {
        errors.push(`Stage "${stageId}" references non-existent agent: ${resolvedAgent}`);
      }

      if (stage.goto) {
        for (const [status, transition] of Object.entries(stage.goto)) {
          if (status === 'default') continue;
          if (transition.stage && transition.stage !== 'end' && !stageIds.includes(transition.stage)) {
            errors.push(`Stage "${stageId}" goto.${status} references non-existent stage: ${transition.stage}`);
          }
        }
      }
    }
  }

  return errors;
}

async function runPipeline(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return { exitCode: 0, help: true };
  }

  // Resolve config path
  if (!args.config) {
    const projectRoot = args.project ? path.resolve(args.project) : findProjectRoot();
    args.config = path.resolve(projectRoot, '.workflow/config/pipeline.yaml');
  }

  console.log('=== Workflow Runner ===');
  console.log(`Config: ${args.config}`);
  if (args.plan) console.log(`Plan: ${args.plan}`);
  if (args.project) console.log(`Project: ${args.project}`);
  console.log('');

  try {
    const config = loadConfig(args.config);
    const errors = validateConfig(config);

    if (errors.length > 0) {
      console.error('Configuration validation failed:');
      errors.forEach(err => console.error(`  - ${err}`));
      return { exitCode: 1, error: 'Configuration validation failed', details: errors };
    }

    console.log(`Pipeline: ${config.pipeline.name} v${config.pipeline.version}`);
    console.log(`Agents: ${Object.keys(config.pipeline.agents).join(', ')}`);
    console.log(`Stages: ${Object.keys(config.pipeline.stages).join(', ')}`);
    console.log('');
    console.log('Configuration validated successfully!');

    // Запускаем пайплайн
    const runner = new PipelineRunner(config, args);
    const result = await runner.run();

    console.log('\n=== Summary ===');
    console.log(`Steps executed: ${result.steps}`);
    console.log(`Tasks completed: ${result.tasksExecuted}`);

    return { exitCode: result.failed ? 1 : 0, result };

  } catch (err) {
    console.error(`\nError: ${err.message}`);
    console.error(err.stack);

    // Даём файлу логов время записаться перед выходом
    await new Promise(resolve => setTimeout(resolve, 100));

    return { exitCode: 1, error: err.message, stack: err.stack };
  }
}

// Export for use as ES module
export { runPipeline, parseArgs, PipelineRunner, FileGuard };
