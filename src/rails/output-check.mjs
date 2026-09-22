/**
 * Rails — выходной слой (спецификация §8).
 *
 * `check(text, config, state)` — соответствие финального ответа
 * `rails.yaml.output.final_requires` (все регулярки обязаны совпасть,
 * флаг `i`) и положению (`state.node` обязан быть в `terminal` или
 * `pause_nodes`).
 */

import fs from 'node:fs';

/**
 * Открытый вопрос: спецификация не задаёт форму элементов `missing[]` для
 * нарушения положения (она задана только для `final_requires` — исходный
 * текст паттерна). Выбрано простое решение: положение представлено такой
 * же строкой-«требованием», отличимой по префиксу `position:`.
 */
const POSITION_MISSING_PREFIX = 'position:';

/**
 * @param {string} text финальный ответ агента
 * @param {object} config распарсенный `rails.yaml` (используется `config.output`)
 * @param {object} state состояние сессии (используется `state.node`)
 * @returns {{ok: boolean, missing: string[]}}
 */
export function check(text, config, state) {
  const missing = [];
  const output = config?.output ?? {};
  const terminalList = Array.isArray(config?.terminal) ? config.terminal : [];
  const pauseList = Array.isArray(config?.pause_nodes) ? config.pause_nodes : [];
  // В узле вопроса стейкхолдеру (pause_nodes) ответ — вопрос, а не отчёт:
  // требования к нему — `output.pause_requires` (по умолчанию пусто), а не
  // `final_requires` (verdict, список файлов). В терминале — `final_requires`.
  const atPause = pauseList.includes(state?.node) && !terminalList.includes(state?.node);
  const requires = atPause
    ? (Array.isArray(output.pause_requires) ? output.pause_requires : [])
    : (Array.isArray(output.final_requires) ? output.final_requires : []);
  const value = String(text ?? '');

  for (const pattern of requires) {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      // Невалидный regex в rails.yaml — не наш вопрос здесь (это дело
      // валидации конфига в rails-config.mjs); трактуем как несовпадение.
      missing.push(pattern);
      continue;
    }
    if (!re.test(value)) missing.push(pattern);
  }

  const terminal = Array.isArray(config?.terminal) ? config.terminal : [];
  const pauseNodes = Array.isArray(config?.pause_nodes) ? config.pause_nodes : [];
  const node = state?.node;
  const positionOk = terminal.includes(node) || pauseNodes.includes(node);
  if (!positionOk) {
    missing.push(`${POSITION_MISSING_PREFIX}${node ?? ''} не входит в terminal/pause_nodes`);
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Текст последнего сообщения ассистента из transcript jsonl (§9.1:
 * `Stop` читает `transcript_path`). Формат строки — как в стандартном
 * транскрипте Claude Code: `{ type: "assistant", message: { content: [...] } }`,
 * `content` — блоки Anthropic Messages API, берутся блоки `type: "text"`.
 *
 * Настоящий транскрипт Claude Code пишет каждый content-блок сообщения
 * отдельной строкой `type: "assistant"` с общим `message.id` — если
 * финальный ответ разбит на несколько text-блоков, они приходят несколькими
 * подряд идущими строками. Берётся не только последняя строка, а все
 * хвостовые `assistant`-строки с тем же `message.id`, что у последней
 * (пока назад по файлу id совпадает), и их text-блоки склеиваются в порядке
 * файла. Если у последней записи `message.id` нет (не Claude Code формат,
 * либо старый транскрипт) — берётся только она, как раньше.
 *
 * Нечитаемый файл или отсутствие ассистентских сообщений — пустая строка
 * (терпимо, как остальные читатели состояния в этом репозитории).
 *
 * @param {string} transcriptPath
 * @returns {string}
 */
export function lastAssistantText(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }

  let lastIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === 'assistant') {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) return '';

  const lastId = entries[lastIdx]?.message?.id;
  let startIdx = lastIdx;
  if (typeof lastId === 'string' && lastId.length > 0) {
    let i = lastIdx - 1;
    while (i >= 0 && entries[i]?.type === 'assistant' && entries[i]?.message?.id === lastId) {
      startIdx = i;
      i -= 1;
    }
  }

  const texts = [];
  for (let i = startIdx; i <= lastIdx; i++) {
    const content = entries[i]?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  return texts.join('');
}
