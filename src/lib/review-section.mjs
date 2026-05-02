import fs from 'node:fs';

export function getLastReviewStatus(content) {
  if (typeof content !== 'string') {
    console.warn('getLastReviewStatus: content is not a string');
    return null;
  }

  // Find ALL ## Ревью sections, use the LAST one (most recent fallback/agent write)
  const reviewSectionRegex = /(?:^|\n)\s*##\s+Ревью\s*\r?\n([\s\S]*?)(?=\r?\n##\s+|$)/gi;
  const matches = [...content.matchAll(reviewSectionRegex)];
  if (matches.length === 0) {
    console.warn('getLastReviewStatus: ## Review section not found');
    return null;
  }
  const reviewSectionMatch = matches[matches.length - 1];

  const sectionBody = reviewSectionMatch[1];
  const lines = sectionBody.split('\n');
  let headerLine = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      headerLine = line;
      break;
    }
  }

  if (!headerLine) {
    console.warn('getLastReviewStatus: table header not found');
    return null;
  }

  const headerCells = headerLine.slice(1, -1).split(/(?<!\\)\|/).map(col => col.trim());
  const statusWhitelist = ['Статус', 'Status', 'Вердикт', 'Verdict'];
  let statusIndex = -1;
  for (let i = 0; i < headerCells.length; i++) {
    const colName = headerCells[i];
    if (statusWhitelist.some(w => w.toLowerCase() === colName.toLowerCase())) {
      statusIndex = i;
      break;
    }
  }

  if (statusIndex === -1) {
    console.warn('getLastReviewStatus: status column (from whitelist) not found in header');
    return null;
  }

  let lastDataLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '' || line === headerLine) continue;
    if (line.startsWith('|') && line.endsWith('|')) {
      if (/^\s*\|\s*[-:|\s]+\s*\|\s*$/.test(line)) continue;
      lastDataLine = line;
      break;
    }
  }

  if (!lastDataLine) {
    console.warn('getLastReviewStatus: no data rows found in table');
    return null;
  }

  const cells = lastDataLine.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());
  if (statusIndex >= cells.length) {
    console.warn('getLastReviewStatus: status column index out of bounds');
    return null;
  }

  const statusCell = cells[statusIndex].trim();
  if (/✅\s*(passed|пройден|ok)/i.test(statusCell)) return 'passed';
  if (/❌\s*(failed|не пройден|ошибка)/i.test(statusCell)) return 'failed';
  if (/⏭️\s*(skipped|пропущen)/i.test(statusCell)) return 'skipped';

  console.warn(`getLastReviewStatus: could not normalize status from cell: ${statusCell}`);
  return null;
}

const HEADER_NEW = '| Дата | Статус | Самари | Агент |';
const SEP_NEW    = '|------|--------|--------|-------|';

const STATUS_DISPLAY = {
  passed: '✅ passed',
  failed: '❌ failed',
  skipped: '⏭️ skipped',
};

/**
 * Append a review entry to the ## Ревью section of a ticket.
 * Column order (canonical, since 2026-05-02): Дата | Статус | Самари | Агент.
 * Auto-creates section if missing. Does NOT migrate legacy headers — those are handled by reorder script.
 */
export function appendReviewEntry(ticketPath, entry) {
  if (!fs.existsSync(ticketPath)) {
    return { ok: false, code: 'FILE_NOT_FOUND', error: `File not found: ${ticketPath}` };
  }

  const { date, agent, status, summary } = entry || {};
  if (!date || !status || summary === undefined) {
    return { ok: false, code: 'INVALID_ENTRY', error: 'Missing required fields: date, status, summary' };
  }

  const content = fs.readFileSync(ticketPath, 'utf8');
  const statusDisplay = STATUS_DISPLAY[status] || status;
  const agentDisplay = agent || 'unknown';
  const newRow = `| ${date} | ${statusDisplay} | ${summary} | ${agentDisplay} |`;

  const reviewSectionRegex = /(##\s+Ревью\s*\r?\n[\s\S]*?(?=\r?\n##\s+|$))/i;
  const match = content.match(reviewSectionRegex);

  let newContent;
  if (!match) {
    // Create new section after frontmatter or before first ##
    const newSection = `## Ревью\n\n${HEADER_NEW}\n${SEP_NEW}\n${newRow}\n`;
    const frontmatterMatch = content.match(/^(---[\s\S]*?---\r?\n)/);
    if (frontmatterMatch) {
      newContent = content.slice(0, frontmatterMatch[0].length) + newSection + content.slice(frontmatterMatch[0].length);
    } else {
      const firstSectionMatch = content.match(/^\s*##\s+/m);
      if (firstSectionMatch) {
        newContent = content.slice(0, firstSectionMatch.index) + newSection + content.slice(firstSectionMatch.index);
      } else {
        newContent = content + (content.endsWith('\n') ? '' : '\n') + newSection;
      }
    }
  } else {
    const existingSection = match[1];
    const sectionBody = existingSection.replace(/^##\s+Ревью\s*\r?\n/i, '').replace(/\r\n/g, '\n');
    const lines = sectionBody.split('\n');

    let headerIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith('|') && t.endsWith('|') && !/^\s*\|\s*[-:|\s]+\s*\|\s*$/.test(t)) {
        headerIndex = i;
        break;
      }
    }

    if (headerIndex === -1) {
      // Section exists but no table — recreate
      const newSection = `## Ревью\n\n${HEADER_NEW}\n${SEP_NEW}\n${newRow}\n`;
      newContent = content.replace(reviewSectionRegex, newSection);
    } else {
      // Append after last data row
      let lastDataIdx = headerIndex + 1; // sep line
      for (let i = lines.length - 1; i > headerIndex; i--) {
        const t = lines[i].trim();
        if (t.startsWith('|') && t.endsWith('|') && !/^\s*\|\s*[-:|\s]+\s*\|\s*$/.test(t)) {
          lastDataIdx = i;
          break;
        }
      }
      lines.splice(lastDataIdx + 1, 0, newRow);
      const newBody = lines.join('\n');
      const newSection = `## Ревью\n\n${newBody}`;
      newContent = content.replace(reviewSectionRegex, newSection.endsWith('\n') ? newSection : newSection + '\n');
    }
  }

  // Atomic write
  const tempPath = ticketPath + '.tmp.' + process.pid + '.' + Date.now();
  try {
    fs.writeFileSync(tempPath, newContent, 'utf8');
    fs.renameSync(tempPath, ticketPath);
    return { ok: true };
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    return { ok: false, code: 'WRITE_ERROR', error: err.message };
  }
}
