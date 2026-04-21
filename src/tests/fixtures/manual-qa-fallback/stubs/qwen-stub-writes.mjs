#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const ticketDir = '.workflow/tickets/backlog';
const ticketPath = join(ticketDir, 'FEAT-TEST.md');

try {
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(ticketPath, '# FEAT-TEST\n\nTest artifact created by qwen-stub-writes\n');
} catch (err) {
  process.stderr.write(`Failed to write file: ${err.message}\n`);
}

process.stderr.write('Qwen OAuth quota exceeded\n');
process.exit(1);
