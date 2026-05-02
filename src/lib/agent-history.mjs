import fs from 'node:fs';
import path from 'node:path';

const HISTORY_HEADER_4COL = '| Дата/время | Скил | Агент | Статус |';
const HISTORY_SEP_4COL = '|------------|------|-------|--------|';

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

export function appendAgentRun(ticketPath, entry) {
  if (!ticketPath || !entry) {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  const { timestamp, skill, agent, status } = entry;
  if (!timestamp || !skill || !agent || !status) {
    return { ok: false, code: 'INVALID_ENTRY' };
  }

  let content;
  try {
    content = fs.readFileSync(ticketPath, 'utf8');
  } catch (err) {
    return { ok: false, code: 'READ_ERROR', error: err.message };
  }

  const newRow = `| ${escapeCell(timestamp)} | ${escapeCell(skill)} | ${escapeCell(agent)} | ${escapeCell(status)} |`;
  const sectionRegex = /(^|\n)## История работы\s*\n([\s\S]*?)(?=\n## |\n*$)/;
  const match = content.match(sectionRegex);

  let updated;
  if (!match) {
    // No section — append new section at end of file
    const trailing = content.endsWith('\n') ? '' : '\n';
    updated = `${content}${trailing}\n## История работы\n\n${HISTORY_HEADER_4COL}\n${HISTORY_SEP_4COL}\n${newRow}\n`;
  } else {
    const sectionBody = match[2];
    const lines = sectionBody.split('\n');
    // Find header line (starts with `|` and contains text)
    const headerIdx = lines.findIndex(l => /^\s*\|.*\|/.test(l) && !/^\s*\|[\s\-|]+\|\s*$/.test(l));
    if (headerIdx === -1) {
      // Section exists but no table — create table fresh
      const beforeBlank = lines.slice(0, headerIdx === -1 ? lines.length : headerIdx);
      updated = content.replace(sectionRegex, `$1## История работы\n\n${HISTORY_HEADER_4COL}\n${HISTORY_SEP_4COL}\n${newRow}\n`);
    } else {
      const headerLine = lines[headerIdx];
      const headerCols = headerLine.split('|').filter(c => c.trim() !== '').length;
      const sepIdx = headerIdx + 1;
      let needMigration = headerCols === 3;

      if (needMigration) {
        // Migrate header
        lines[headerIdx] = HISTORY_HEADER_4COL;
        if (sepIdx < lines.length && /^\s*\|[\s\-|]+\|\s*$/.test(lines[sepIdx])) {
          lines[sepIdx] = HISTORY_SEP_4COL;
        }
        // Migrate data rows: append unknown
        for (let i = sepIdx + 1; i < lines.length; i++) {
          const ln = lines[i];
          if (!ln.trim()) break;
          if (!/^\s*\|/.test(ln)) break;
          const cells = ln.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim());
          if (cells.length === 3) {
            lines[i] = `| ${cells[0]} | ${cells[1]} | ${cells[2]} | unknown |`;
          }
        }
      }

      // Find end of table (last `|...|` line in section)
      let lastTableIdx = headerIdx;
      for (let i = sepIdx + 1; i < lines.length; i++) {
        if (/^\s*\|/.test(lines[i])) {
          lastTableIdx = i;
        } else if (lines[i].trim() === '') {
          continue;
        } else {
          break;
        }
      }
      lines.splice(lastTableIdx + 1, 0, newRow);

      const newSection = lines.join('\n');
      updated = content.replace(sectionRegex, `$1## История работы\n${newSection}`);
    }
  }

  // Atomic write: temp file + rename
  const dir = path.dirname(ticketPath);
  const tmp = path.join(dir, `.${path.basename(ticketPath)}.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmp, updated, 'utf8');
    fs.renameSync(tmp, ticketPath);
    return { ok: true };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, code: 'WRITE_ERROR', error: err.message };
  }
}

export function parseAgentHistory(content) {
  const sectionMatch = content.match(/## История работы[\s\S]*?\n\s*\|.*\|.*\|.*\|.*\n([\s\S]*?)(?=\n\s*\|\s*-{3,}|$)/);
  if (!sectionMatch) return [];
  const rows = sectionMatch[1].trim().split(/\n/).filter(r => r.trim() && !/^\s*\|[\s\-|]+\|\s*$/.test(r));
  const result = [];
  rows.forEach(row => {
    const cells = row.split(/(?<!\\)\|/).map(c => c.trim()).filter(c => c !== '').map(c => c.replace(/\\\|/g, '|'));
    if (cells.length === 3) {
      cells.push('unknown');
    }
    if (cells.length !== 4) {
      console.warn('Invalid row: ' + row);
      return;
    }
    result.push({ timestamp: cells[0], skill: cells[1], agent: cells[2], status: cells[3] });
  });
  return result;
}

export function classifyAgentResult({ exitCode, stderr, stdout, timedOut, signal, parsedResult, agentType }) {
  if (timedOut === true) {
    return 'timeout';
  }
  if (signal === 'SIGTERM' || signal === 'SIGKILL' || [130,137,143].includes(exitCode)) {
    return 'aborted';
  }
  if (parsedResult?.status === 'blocked') {
    return 'blocked';
  }
  if (parsedResult?.status === 'irrelevant') {
    return 'skipped_relevance';
  }
  if (/\b429\b|rate.?limit|quota.?exceeded|too many requests/i.test(stderr)) {
    return 'rate_limit';
  }
  if (/ECONNREFUSED|ENETUNREACH|ETIMEDOUT|EHOSTUNREACH|getaddrinfo|network/i.test(stderr)) {
    return 'network_error';
  }
  if (/\b401\b|\b403\b|invalid api key|unauthor|permission denied/i.test(stderr)) {
    return 'auth_error';
  }
  if (exitCode === 0 && agentType === 'ai' && (stdout.trim().length === 0 || !parsedResult)) {
    return 'empty_response';
  }
  if (exitCode === 0) {
    return 'ok';
  }
  return 'error';
}
