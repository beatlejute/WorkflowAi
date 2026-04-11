#!/usr/bin/env node

/**
 * check-mcp.js — Проверяет доступность MCP-серверов из .mcp.json.
 *
 * Используется как stage-скрипт в pipeline: запускается перед execute-task для
 * тикетов определённых типов (см. require_for ниже). Если MCP-серверы недоступны,
 * stage возвращает status: fail и runner может пропустить выполнение задачи или
 * пометить её как заблокированную.
 *
 * Что делает:
 *   1. Парсит .mcp.json — список ожидаемых серверов.
 *   2. Сверяет с .claude/settings.local.json (enabledMcpjsonServers / enableAllProjectMcpServers).
 *   3. Для http(s)-эндпоинтов делает GET-пинг и сообщает reachability.
 *   4. Для stdio-серверов проверяет, что бинарь резолвится в PATH.
 *
 * ВАЖНО: «может ли сервер быть доступен» (эндпоинт жив + harness разрешает) ≠
 * «доступен ли он прямо сейчас в чате». Последнее знает только harness в момент
 * старта сессии. Скрипт отвечает на первый вопрос.
 *
 * Использование:
 *   Запускается runner'ом workflow-ai как stage-скрипт. Runner передаёт промпт
 *   (со встроенной секцией Context) одним аргументом — как и для check-relevance.
 *   Скрипт ищет в нём regexp'ами поля mcp_require_for и task_type.
 *
 *   Для ручного запуска можно передать те же поля:
 *     node check-mcp.js "mcp_require_for: qa\ntask_type: qa"
 *
 * Поля контекста, которые скрипт читает:
 *   mcp_require_for — comma-separated список типов тикетов, для которых нужна
 *                     проверка MCP. Задаётся в pipeline.yaml в секции
 *                     context.mcp_require_for. Пустая строка = всегда skipped.
 *   task_type       — тип текущего тикета. Задаётся runner'ом из контекста.
 *
 * Поведение по task_type:
 *   - task_type ∈ require_for → реальная проверка MCP → status: ok|fail
 *   - task_type ∉ require_for → пропуск               → status: skipped
 *
 * Отсутствие .mcp.json или пустой список серверов — это ok (нечего проверять).
 * Fail — только когда настроенные серверы недоступны или не разрешены.
 *
 * Вывод (для runner'а):
 *   ---RESULT---
 *   status: ok|skipped|fail
 *   reason: <короткое описание>
 *   ---RESULT---
 *
 * Exit code:
 *   0 — всегда (статус решает goto в pipeline.yaml).
 *   Runner workflow-ai при exitCode != 0 переписывает наш status на "failed",
 *   что ломает маршрутизацию. Поэтому валим логический результат через status,
 *   а не через exit code.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { execSync } from 'child_process';

const projectRoot = process.cwd();
const mcpConfigPath = path.join(projectRoot, '.mcp.json');
const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');

/**
 * Извлекает поле из промпта, который runner передаёт скрипту.
 * Промпт — это многострочный текст с секцией "Context:" внутри:
 *
 *   check-mcp
 *
 *   Context:
 *     mcp_require_for: qa
 *     task_type: qa
 *     ticket_id: QA-001
 *
 * Промпт может прилететь как один аргумент (process.argv[2]) или собран из
 * нескольких — поэтому склеиваем все argv в одну строку и ищем regexp.
 */
function extractField(text, field) {
  const re = new RegExp(`(?:^|\\n)\\s*${field}\\s*:\\s*([^\\n]*)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function emitResult(status, reason) {
  console.log('---RESULT---');
  console.log(`status: ${status}`);
  if (reason) console.log(`reason: ${reason}`);
  console.log('---RESULT---');
}

function readJson(p) {
  if (!fs.existsSync(p)) return { missing: true };
  try {
    return { data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    return { error: e.message };
  }
}

function findHttpUrl(args) {
  if (!Array.isArray(args)) return null;
  return args.find((a) => typeof a === 'string' && /^https?:\/\//.test(a)) || null;
}

function pingHttp(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return finish({ ok: false, reason: 'invalid url' });
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        timeout: timeoutMs,
      },
      (res) => {
        finish({ ok: true, status: res.statusCode });
        res.resume();
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, reason: `timeout ${timeoutMs}ms` });
    });
    req.on('error', (err) => finish({ ok: false, reason: err.code || err.message }));
    req.end();
  });
}

function commandExists(cmd) {
  if (!cmd) return false;
  const probe = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
  try {
    execSync(probe, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isEnabled(name, settings) {
  if (!settings) return { enabled: true, source: 'no settings file' };
  if (settings.enableAllProjectMcpServers === true) {
    return { enabled: true, source: 'enableAllProjectMcpServers' };
  }
  const list = settings.enabledMcpjsonServers;
  if (Array.isArray(list) && list.includes(name)) {
    return { enabled: true, source: 'enabledMcpjsonServers' };
  }
  return { enabled: false, source: 'not in enabledMcpjsonServers' };
}

async function checkServer(name, cfg, settings) {
  const enabled = isEnabled(name, settings);
  const httpUrl = findHttpUrl(cfg.args);
  const result = {
    name,
    enabled: enabled.enabled,
    enabledSource: enabled.source,
    transport: httpUrl ? 'http' : 'stdio',
    command: cfg.command,
    url: httpUrl,
  };

  if (httpUrl) {
    const ping = await pingHttp(httpUrl);
    result.reachable = ping.ok;
    result.detail = ping.ok ? `HTTP ${ping.status}` : ping.reason;
  } else {
    const ok = commandExists(cfg.command);
    result.reachable = ok;
    result.detail = ok ? 'command found in PATH' : 'command not in PATH';
  }
  return result;
}

function formatRow(r) {
  const flag = r.enabled && r.reachable ? 'OK  ' : 'FAIL';
  const enabled = r.enabled ? 'enabled' : 'disabled';
  const target = r.url || r.command;
  return `  [${flag}] ${r.name.padEnd(20)} ${enabled.padEnd(9)} ${r.transport.padEnd(6)} ${target}\n         → ${r.detail} (${r.enabledSource})`;
}

(async () => {
  // Runner передаёт промпт (с секцией Context) одним или несколькими аргументами.
  // Склеиваем всё в одну строку для извлечения полей.
  const promptText = process.argv.slice(2).join('\n');
  const taskType = extractField(promptText, 'task_type');
  const requireForRaw = extractField(promptText, 'mcp_require_for');
  const requireFor = new Set(
    requireForRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  // Skip-ветка: список пуст (mcp_require_for не задан в context) или task_type не входит.
  if (requireFor.size === 0) {
    console.log(
      '[check-mcp] mcp_require_for пуст — проверка отключена. Задайте список типов в pipeline.yaml (context.mcp_require_for).'
    );
    emitResult('skipped', 'mcp_require_for is empty');
    process.exit(0);
  }
  if (!requireFor.has(taskType)) {
    console.log(
      `[check-mcp] task_type="${taskType}" не входит в mcp_require_for=[${[...requireFor].join(', ')}]. Пропуск.`
    );
    emitResult('skipped', `task_type=${taskType || 'unknown'} not in mcp_require_for`);
    process.exit(0);
  }

  // Реальная проверка.
  const mcpRead = readJson(mcpConfigPath);
  if (mcpRead.missing) {
    console.log('[check-mcp] .mcp.json отсутствует — нет серверов для проверки.');
    emitResult('ok', 'no mcp.json — nothing to check');
    process.exit(0);
  }
  if (mcpRead.error) {
    console.error(`[check-mcp] не удалось распарсить .mcp.json: ${mcpRead.error}`);
    emitResult('fail', `mcp.json parse error: ${mcpRead.error}`);
    process.exit(0);
  }
  const servers = mcpRead.data && mcpRead.data.mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    console.log('[check-mcp] .mcp.json не содержит серверов — нечего проверять.');
    emitResult('ok', 'no mcp servers — nothing to check');
    process.exit(0);
  }

  const settings = readJson(settingsPath).data || null;
  const names = Object.keys(servers);

  console.log(`[check-mcp] task_type=${taskType}, проверяю ${names.length} MCP-серверов:\n`);

  const results = await Promise.all(
    names.map((n) => checkServer(n, servers[n], settings))
  );
  for (const r of results) console.log(formatRow(r));

  const failed = results.filter((r) => !r.enabled || !r.reachable);
  console.log('');

  if (failed.length === 0) {
    console.log(`[check-mcp] Все ${results.length} серверов OK`);
    emitResult('ok', `${results.length} servers reachable`);
    process.exit(0);
  }

  console.log(`[check-mcp] Проблемы: ${failed.length}/${results.length}`);
  for (const f of failed) {
    const reasons = [];
    if (!f.enabled) reasons.push(`не разрешён (${f.enabledSource})`);
    if (!f.reachable) reasons.push(f.detail);
    console.log(`  - ${f.name}: ${reasons.join('; ')}`);
  }
  const failNames = failed.map((f) => f.name).join(', ');
  emitResult('fail', `unavailable: ${failNames}`);
  process.exit(0);
})();
