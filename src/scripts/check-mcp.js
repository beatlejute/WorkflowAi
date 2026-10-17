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
 *   5. Требует, чтобы весь набор серверов давал один хост: серверы, доступные
 *      только разным хостам по отдельности, успешной проверкой не считаются.
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
 * Fail — когда настроенные серверы недоступны или не разрешены, а также когда каждый
 * сервер доступен, но весь набор не даёт ни один хост (см. п. 5 выше).
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
import os from 'os';
import http from 'http';
import https from 'https';
import { exec } from 'child_process';

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

// Адрес http-сервера: поле url самой записи (встроенный транспорт http) или строка-адрес в
// args — так адрес передаёт обёртка вроде mcp-remote, у которой своей команды запуска нет.
function findHttpUrl(args, url) {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
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

// Поиск асинхронный: пинги http-серверов идут параллельно, а их таймаут — таймер
// этого же процесса. execSync останавливал цикл событий, пока отрабатывали cmd.exe и
// where: соединение не шло, таймер тикал, и при поиске дольше 3 с живой сервер
// получал «timeout 3000ms» (воспроизведено медленным PATH). Вероятная причина
// падений check-mcp.test.mjs на windows-latest; полного лога CI нет.
function commandExists(cmd) {
  if (!cmd) return Promise.resolve(false);
  const probe = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
  return new Promise((resolve) => exec(probe, (err) => resolve(!err)));
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

/**
 * Каталог агента pi: `PI_CODING_AGENT_DIR` или `~/.pi/agent` — как считает сам pi.
 * Оттуда он берёт глобальный `mcp.json`, а проектный `.pi/mcp.json` — только в
 * доверенном проекте (запись в `trust.json`, ближайший предок каталога).
 */
function piAgentDir() {
  const override = typeof process.env.PI_CODING_AGENT_DIR === 'string' ? process.env.PI_CODING_AGENT_DIR.trim() : '';
  return override || path.join(os.homedir(), '.pi', 'agent');
}

/** Доверен ли проект pi: ближайшая запись `trust.json` со значением true. */
function piProjectTrusted(projectRoot, agentDir) {
  const trust = readJson(path.join(agentDir, 'trust.json')).data;
  if (!trust || typeof trust !== 'object' || Array.isArray(trust)) return false;
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  let dir = path.resolve(projectRoot);
  for (;;) {
    const key = Object.keys(trust).find((k) => same(path.resolve(k), dir));
    if (key !== undefined && typeof trust[key] === 'boolean') return trust[key];
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Серверы MCP из конфигов pi: глобальный `mcp.json` и проектный `.pi/mcp.json`. */
function piServers(projectRoot, agentDir) {
  const global = readJson(path.join(agentDir, 'mcp.json')).data;
  const globalServers = global && global.mcpServers && typeof global.mcpServers === 'object' ? global.mcpServers : {};
  const project = piProjectTrusted(projectRoot, agentDir)
    ? readJson(path.join(projectRoot, '.pi', 'mcp.json')).data
    : null;
  const projectServers = project && project.mcpServers && typeof project.mcpServers === 'object' ? project.mcpServers : {};
  return { globalServers, projectServers };
}

/**
 * Разрешение сервера в конфигах pi: запись проекта перекрывает глобальную, а запись
 * без команды, адреса и типа — только переопределение `enabled`. Отключённый сервер
 * (`enabled: false`) не подключается, даже если он есть в проекте.
 *
 * `entry` — та же запись, по которой вынесено разрешение: у pi своя команда и свои
 * args, и проверять доступность по чужому конфигу нельзя.
 */
function piEnabled(name, { globalServers, projectServers }) {
  const project = projectServers[name];
  const global = globalServers[name];
  const isServer = (e) => Boolean(e && (e.command || e.url || e.type));
  if (project && typeof project === 'object' && project.enabled === false) {
    return { enabled: false, source: '.pi/mcp.json: enabled false', entry: project };
  }
  if (isServer(project)) return { enabled: true, source: '.pi/mcp.json', entry: project };
  if (project && typeof project === 'object') {
    // Переопределение без собственного сервера: работает поверх глобальной записи.
    if (isServer(global)) return { enabled: global.enabled !== false, source: 'глобальный mcp.json pi', entry: global };
    return { enabled: false, source: '.pi/mcp.json: сервер не описан', entry: null };
  }
  if (isServer(global)) {
    return global.enabled === false
      ? { enabled: false, source: 'глобальный mcp.json pi: enabled false', entry: global }
      : { enabled: true, source: 'глобальный mcp.json pi', entry: global };
  }
  return { enabled: false, source: 'нет в конфигах pi', entry: null };
}

/** Доступность одной записи сервера: пинг адреса http или поиск stdio-команды в PATH. */
async function probeRecord(record) {
  const httpUrl = findHttpUrl(record.args, record.url);
  if (httpUrl) {
    // Пинг стартует следующим витком цикла, когда поиски stdio-команд уже запущены:
    // сам запуск процесса синхронный, и его пауза иначе попала бы в таймаут пинга.
    await new Promise((resolve) => setImmediate(resolve));
    const ping = await pingHttp(httpUrl);
    return { transport: 'http', url: httpUrl, reachable: ping.ok, detail: ping.ok ? `HTTP ${ping.status}` : ping.reason };
  }
  const ok = await commandExists(record.command);
  return { transport: 'stdio', url: null, reachable: ok, detail: ok ? 'command found in PATH' : 'command not in PATH' };
}

async function checkServer(name, cfg, settings, pi) {
  const claude = isEnabled(name, settings);
  const piState = piEnabled(name, pi);
  // Хосты стадии бывают разные (claude и pi): сервер считается доступным, если его
  // разрешает хотя бы один из них — иначе сервер, разрешённый только для pi, блокировал бы
  // тикет. Запись для проверки берётся от того хоста, что разрешил сервер: у pi своя
  // команда и свои args, и чужая запись дала бы вердикт о сервере, которого у этого хоста
  // нет. Если разрешают оба, вердикт берётся по первой рабочей записи: неудача одного хоста
  // не должна скрывать рабочую запись другого. Когда не разрешает никто, причина остаётся
  // прежней (от Claude): она привычнее и по ней видно, чего не хватает в настройках проекта.
  const candidates = [];
  if (claude.enabled) candidates.push({ host: 'claude', state: claude, record: cfg });
  if (piState.enabled) candidates.push({ host: 'pi', state: piState, record: piState.entry });
  if (candidates.length === 0) candidates.push({ host: 'claude', state: claude, record: cfg });

  // Проверяются все кандидаты, а не до первой доступной записи: строка берёт вердикт
  // первой доступной (как раньше), а свод по хостам — вердикт каждой записи отдельно.
  const probes = [];
  for (const c of candidates) probes.push({ c, probe: await probeRecord(c.record) });

  const chosen = probes.find((p) => p.probe.reachable) || probes[0];
  const { c: host, probe } = chosen;

  // hostOk — хост даёт сервер целиком: запись хоста и разрешена, и доступна. Запись
  // хоста, который сервер не разрешает (в том числе запасная запись Claude, взятая
  // только ради причины отказа), сервер не даёт, даже если команда резолвится.
  const hostOk = { claude: false, pi: false };
  for (const p of probes) {
    if (p.c.state.enabled && p.probe.reachable) hostOk[p.c.host] = true;
  }

  return {
    name,
    hostOk,
    enabled: host.state.enabled,
    enabledSource: host.state.source,
    transport: probe.transport,
    command: host.record.command,
    url: probe.url,
    reachable: probe.reachable,
    detail: probe.detail,
  };
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
  const pi = piServers(projectRoot, piAgentDir());
  const names = Object.keys(servers);

  console.log(`[check-mcp] task_type=${taskType}, проверяю ${names.length} MCP-серверов:\n`);

  const results = await Promise.all(
    names.map((n) => checkServer(n, servers[n], settings, pi))
  );
  for (const r of results) console.log(formatRow(r));

  const failed = results.filter((r) => !r.enabled || !r.reachable);
  // Итог — по набору целиком, а не по сумме вердиктов: сервер A может быть доступен
  // только Claude, сервер B — только pi, и тогда «все OK» не значит, что хоть один
  // исполнитель получит набор. Проверка проходит, только если весь набор даёт один хост.
  const hostNames = [...new Set(results.flatMap((r) => Object.keys(r.hostOk)))];
  const hosts = hostNames.map((host) => ({
    host,
    missing: results.filter((r) => !r.hostOk[host]).map((r) => r.name),
  }));
  const covering = hosts.filter((h) => h.missing.length === 0);
  // Свод по хостам печатается, когда в наборе участвуют оба: при одном хосте он
  // повторял бы строки серверов.
  const inPlay = hosts.filter((h) => h.missing.length < results.length);
  const printCoverage = () => {
    if (inPlay.length < 2) return;
    console.log('[check-mcp] Покрытие набора по хостам:');
    for (const h of hosts) {
      const have = results.length - h.missing.length;
      const gaps = h.missing.length ? `, нет: ${h.missing.join(', ')}` : '';
      console.log(`  ${h.host}: ${have}/${results.length}${gaps}`);
    }
  };
  console.log('');

  if (covering.length > 0) {
    console.log(`[check-mcp] Все ${results.length} серверов OK`);
    emitResult('ok', `${results.length} servers reachable (host: ${covering.map((h) => h.host).join(', ')})`);
    process.exit(0);
  }

  // Набора нет ни у одного хоста. Каждый сервер при этом доступен кому-то — иначе
  // ветка ниже назвала бы недоступные; здесь порознь доступные серверы собраны разными
  // хостами, и ни один исполнитель не получает набор целиком.
  if (failed.length === 0) {
    printCoverage();
    console.log(`[check-mcp] Ни один хост не располагает набором целиком (${results.length} серверов).`);
    const gaps = hosts.map((h) => `${h.host} lacks ${h.missing.join(', ')}`).join('; ');
    emitResult('fail', `incomplete coverage: ${gaps}`);
    process.exit(0);
  }

  printCoverage();
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
