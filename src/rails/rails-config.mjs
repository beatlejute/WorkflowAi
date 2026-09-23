// Загрузка и валидация rails.yaml скила. Спецификация: src/rails/README.md §4.
// Без побочных эффектов при импорте — чтение файла только внутри loadRailsConfig().

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from '../lib/js-yaml.mjs';

// §6: допустимые значения kind в stage_actions.*.kind.
const VALID_KINDS = new Set(['shell', 'edit', 'write', 'read', 'agent', 'mcp', 'other']);

const DEFAULTS = {
  version: 1,
  fragments: ['workflows/*.md'],
  quote_min: 25,
  terminal: [],
  pause_nodes: [],
  canary: null,
  write_scope: [],
  allow_temp: false,
  write_deny: [],
  deny_shell: [],
  deny_mcp: [],
  stage_actions: {},
  cycles: [],
  output: {
    final_requires: [],
    final_forbids: [],
    max_stop_blocks: 2,
  },
};

/**
 * Читает `<skillDir>/rails.yaml` и дополняет её дефолтами (§4). Не валидирует
 * (для этого — validateRailsConfig) и не глотает ошибки чтения/парсинга YAML —
 * они должны быть видны вызывающему (`cli check` решает, что с ними делать).
 * @param {string} skillDir
 * @returns {object} config
 */
export function loadRailsConfig(skillDir) {
  const yamlPath = join(skillDir, 'rails.yaml');
  const text = readFileSync(yamlPath, 'utf8');
  const raw = load(text);

  if (raw === null || raw === undefined) {
    return { ...DEFAULTS, output: { ...DEFAULTS.output } };
  }
  if (!isPlainObject(raw)) {
    // Корень YAML — не объект (список, скаляр): дефолты сюда раскладывать
    // нельзя (spread списка даёт ключи "0","1",… и прячет настоящую причину).
    // Отдаём как есть — validateRailsConfig() сообщит понятный bad-type '$'.
    return raw;
  }

  // output не-объект (число/строка/список) не должен молча раствориться в дефолтах —
  // тогда H5 (final_requires/max_stop_blocks) выключился бы без единой ошибки check.
  // Отдаём как есть, validateRailsConfig() сообщит bad-type 'output'.
  const output = isPlainObject(raw.output) || raw.output === undefined
    ? { ...DEFAULTS.output, ...(raw.output || {}) }
    : raw.output;

  return {
    ...DEFAULTS,
    ...raw,
    output,
  };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function pushError(errors, code, field, message) {
  errors.push({ code, field, message });
}

function isValidRegex(pattern) {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Проверяет схему объекта rails.yaml (после парсинга YAML, до или после
 * применения дефолтов — обе формы допустимы, отсутствующие необязательные
 * поля не считаются ошибкой). §4.
 * @param {object} obj
 * @returns {{errors: Array<{code:string, field:string, message:string}>}}
 */
export function validateRailsConfig(obj) {
  const errors = [];

  if (!isPlainObject(obj)) {
    return { errors: [{ code: 'bad-type', field: '$', message: 'rails.yaml должен разбираться в объект' }] };
  }

  if (obj.version !== undefined && obj.version !== 1) {
    pushError(errors, 'bad-value', 'version', 'поддерживается только version: 1');
  }

  if (typeof obj.skill !== 'string' || obj.skill.trim() === '') {
    pushError(errors, 'missing-field', 'skill', 'skill обязателен и должен быть непустой строкой');
  }

  if (typeof obj.entry !== 'string' || obj.entry.trim() === '') {
    pushError(errors, 'missing-field', 'entry', 'entry обязателен и должен быть строкой (id E-узла)');
  }

  if (obj.terminal !== undefined && !isStringArray(obj.terminal)) {
    pushError(errors, 'bad-type', 'terminal', 'terminal должен быть массивом строк');
  }

  if (obj.pause_nodes !== undefined && !isStringArray(obj.pause_nodes)) {
    pushError(errors, 'bad-type', 'pause_nodes', 'pause_nodes должен быть массивом строк');
  }

  if (obj.fragments !== undefined && !isStringArray(obj.fragments)) {
    pushError(errors, 'bad-type', 'fragments', 'fragments должен быть массивом строк-glob');
  }

  if (obj.quote_min !== undefined && (!Number.isFinite(obj.quote_min) || obj.quote_min <= 0)) {
    pushError(errors, 'bad-type', 'quote_min', 'quote_min должен быть положительным числом');
  }

  if (obj.canary !== undefined && obj.canary !== null && typeof obj.canary !== 'string') {
    pushError(errors, 'bad-type', 'canary', 'canary должен быть строкой');
  }

  if (obj.write_scope !== undefined && !isStringArray(obj.write_scope)) {
    pushError(errors, 'bad-type', 'write_scope', 'write_scope должен быть массивом строк');
  }

  if (obj.allow_temp !== undefined && typeof obj.allow_temp !== 'boolean') {
    pushError(errors, 'bad-type', 'allow_temp', 'allow_temp должен быть булевым значением');
  }

  if (obj.write_deny !== undefined && !isStringArray(obj.write_deny)) {
    pushError(errors, 'bad-type', 'write_deny', 'write_deny должен быть массивом строк');
  }

  if (obj.deny_shell !== undefined) {
    if (!Array.isArray(obj.deny_shell)) {
      pushError(errors, 'bad-type', 'deny_shell', 'deny_shell должен быть массивом');
    } else {
      obj.deny_shell.forEach((item, i) => {
        if (!isPlainObject(item) || typeof item.pattern !== 'string') {
          pushError(errors, 'bad-type', `deny_shell[${i}]`, 'каждая запись — объект {pattern, reason}');
          return;
        }
        if (!isValidRegex(item.pattern)) {
          pushError(errors, 'bad-regex', `deny_shell[${i}].pattern`, `невалидное регулярное выражение: ${item.pattern}`);
        }
        if (item.reason !== undefined && typeof item.reason !== 'string') {
          pushError(errors, 'bad-type', `deny_shell[${i}].reason`, 'reason должен быть строкой');
        }
      });
    }
  }

  if (obj.deny_mcp !== undefined && !isStringArray(obj.deny_mcp)) {
    pushError(errors, 'bad-type', 'deny_mcp', 'deny_mcp должен быть массивом строк');
  }

  if (obj.stage_actions !== undefined) {
    if (!isPlainObject(obj.stage_actions)) {
      pushError(errors, 'bad-type', 'stage_actions', 'stage_actions должен быть объектом');
    } else {
      for (const [name, rule] of Object.entries(obj.stage_actions)) {
        const prefix = `stage_actions.${name}`;
        if (!isPlainObject(rule)) {
          pushError(errors, 'bad-type', prefix, 'правило должно быть объектом');
          continue;
        }
        if (!isStringArray(rule.kind) || rule.kind.length === 0) {
          pushError(errors, 'bad-type', `${prefix}.kind`, 'kind должен быть непустым массивом строк');
        } else {
          rule.kind.forEach((k, i) => {
            if (!VALID_KINDS.has(k)) {
              pushError(errors, 'bad-value', `${prefix}.kind[${i}]`, `kind «${k}» вне перечисления §6 (shell|edit|write|read|agent|mcp|other)`);
            }
          });
        }
        if (typeof rule.match !== 'string') {
          pushError(errors, 'bad-type', `${prefix}.match`, 'match должен быть строкой (glob или regex)');
        } else if (Array.isArray(rule.kind) && rule.kind.includes('shell') && !isValidRegex(rule.match)) {
          // §4: для kind: shell match — регулярное выражение по тексту команды.
          pushError(errors, 'bad-regex', `${prefix}.match`, `невалидное регулярное выражение: ${rule.match}`);
        }
        if (!Array.isArray(rule.stages) || rule.stages.some((s) => !Number.isFinite(s))) {
          pushError(errors, 'bad-type', `${prefix}.stages`, 'stages должен быть массивом чисел');
        }
        if (rule.max_per_session !== undefined && (!Number.isFinite(rule.max_per_session) || rule.max_per_session < 0)) {
          pushError(errors, 'bad-type', `${prefix}.max_per_session`, 'max_per_session должен быть неотрицательным числом');
        }
      }
    }
  }

  if (obj.cycles !== undefined) {
    if (!Array.isArray(obj.cycles)) {
      pushError(errors, 'bad-type', 'cycles', 'cycles должен быть массивом');
    } else {
      obj.cycles.forEach((c, i) => {
        const prefix = `cycles[${i}]`;
        if (!isPlainObject(c)) {
          pushError(errors, 'bad-type', prefix, 'запись цикла должна быть объектом {from, to, max, reason}');
          return;
        }
        if (!Number.isFinite(c.from)) pushError(errors, 'bad-type', `${prefix}.from`, 'from должен быть числом (номер этапа)');
        if (!Number.isFinite(c.to)) pushError(errors, 'bad-type', `${prefix}.to`, 'to должен быть числом (номер этапа)');
        if (!Number.isFinite(c.max) || c.max < 0) pushError(errors, 'bad-type', `${prefix}.max`, 'max должен быть неотрицательным числом');
        if (c.reason !== undefined && typeof c.reason !== 'string') pushError(errors, 'bad-type', `${prefix}.reason`, 'reason должен быть строкой');
      });
    }
  }

  if (obj.output !== undefined) {
    if (!isPlainObject(obj.output)) {
      pushError(errors, 'bad-type', 'output', 'output должен быть объектом');
    } else {
      // Четыре списка регулярок выходного слоя: требования и запреты, для терминала и
      // для узла-паузы. `*_forbids` добавлены 2026-09-23 (часть инвариантов скила — запрет
      // на форму ответа, а не требование наличия).
      for (const key of ['final_requires', 'final_forbids', 'pause_requires', 'pause_forbids']) {
        if (obj.output[key] === undefined) continue;
        if (!isStringArray(obj.output[key])) {
          pushError(errors, 'bad-type', `output.${key}`, `${key} должен быть массивом строк-регулярок`);
          continue;
        }
        obj.output[key].forEach((pattern, i) => {
          if (!isValidRegex(pattern)) {
            pushError(errors, 'bad-regex', `output.${key}[${i}]`, `невалидное регулярное выражение: ${pattern}`);
          }
        });
      }
      if (obj.output.max_stop_blocks !== undefined && (!Number.isFinite(obj.output.max_stop_blocks) || obj.output.max_stop_blocks < 0)) {
        pushError(errors, 'bad-type', 'output.max_stop_blocks', 'max_stop_blocks должен быть неотрицательным числом');
      }
    }
  }

  return { errors };
}
