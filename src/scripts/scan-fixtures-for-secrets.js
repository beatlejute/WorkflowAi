#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { findProjectRoot } from 'workflow-ai/lib/find-root.mjs';
import { printResult } from 'workflow-ai/lib/utils.mjs';

const PROJECT_DIR = findProjectRoot();

const DEFAULT_ALLOWLIST = [
  'localhost',
  '127.0.0.1',
  '::1',
  'example.com',
  'example.org',
  'example.net'
];

const BASE_PATTERNS = [
  { name: 'api[_-]?key', regex: /api[_-]?key\s*[:=]\s*\S+/gi },
  { name: 'bearer', regex: /bearer\s+[A-Za-z0-9._-]+/gi },
  { name: 'openai-key', regex: /sk-[a-zA-Z0-9]{20,}/gi },
  { name: 'jwt', regex: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+\./gi },
  { name: 'password', regex: /password\s*[:=]\s*\S+/gi },
  { name: 'token', regex: /token\s*[:=]\s*\S+/gi }
];

const STRICT_PATTERNS = [
  { name: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'github-token', regex: /(gh[pousr]_[a-zA-Z0-9_]{36,})/g },
  { name: 'slack-token', regex: /xox[baprs]-[0-9a-zA-Z-]+/g },
  { name: 'private-key', regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'google-api-key', regex: /AIza[0-9A-Za-z-_]{35}/g },
  { name: 'stripe-key', regex: /(sk|pk)_(test|live)_[0-9a-zA-Z]{24,}/g },
  { name: 'sendgrid-key', regex: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g },
  { name: 'mailchimp-key', regex: /[a-f0-9]{32}-us[0-9]{1,2}/g },
  { name: 'generic-secret', regex: /secret\s*[:=]\s*["']?\S+["']?/gi },
  { name: 'client-secret', regex: /client[_-]?secret\s*[:=]\s*\S+/gi }
];

let PATTERNS = [...BASE_PATTERNS];

const IP_PRIVATE_REGEX = /(^127\.)|(^10\.)|(^172\.(1[6-9]|2[0-9]|3[0-1])\.)|(^192\.168\.)|(^::1$)|(^fe80:)|(^fc)|(^fd)/i;
const DOMAIN_PRIVATE_REGEX = /(localhost|127\.[0-9]+\.[0-9]+\.[0-9]+|::1|example\.(com|org|net))$/i;

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    path: null,
    strict: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && args[i + 1]) {
      options.path = args[i + 1];
      i++;
    } else if (args[i] === '--strict') {
      options.strict = true;
    }
  }

  return options;
}

function getDefaultScanPaths() {
  const skillsDir = path.join(PROJECT_DIR, 'src', 'skills');
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const paths = [];
  try {
    const skills = fs.readdirSync(skillsDir);
    for (const skill of skills) {
      const fixturesPath = path.join(skillsDir, skill, 'tests', 'fixtures');
      if (fs.existsSync(fixturesPath)) {
        paths.push(fixturesPath);
      }
    }
  } catch (e) {
  }

  return paths;
}

function isPrivateIp(ip, allowlist) {
  if (!ip) return false;
  const normalized = ip.trim().toLowerCase();
  if (DEFAULT_ALLOWLIST.includes(normalized) || allowlist.includes(normalized)) {
    return false;
  }
  return IP_PRIVATE_REGEX.test(normalized);
}

function isPrivateDomain(domain, allowlist) {
  if (!domain) return false;
  const normalized = domain.trim().toLowerCase();
  if (DEFAULT_ALLOWLIST.includes(normalized) || allowlist.includes(normalized)) {
    return false;
  }
  return DOMAIN_PRIVATE_REGEX.test(normalized);
}

function scanFile(filePath, allowlist = []) {
  const findings = [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    for (const pattern of PATTERNS) {
      let match;
      pattern.regex.lastIndex = 0;
      while ((match = pattern.regex.exec(line)) !== null) {
        findings.push({
          file: filePath,
          line: lineNum,
          pattern: pattern.name,
          match: match[0]
        });
      }
    }

    const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
    let ipMatch;
    while ((ipMatch = ipRegex.exec(line)) !== null) {
      if (isPrivateIp(ipMatch[0], allowlist)) {
        findings.push({
          file: filePath,
          line: lineNum,
          pattern: 'private-ip',
          match: ipMatch[0]
        });
      }
    }

    const domainRegex = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g;
    let domainMatch;
    while ((domainMatch = domainRegex.exec(line)) !== null) {
      if (isPrivateDomain(domainMatch[0], allowlist)) {
        findings.push({
          file: filePath,
          line: lineNum,
          pattern: 'private-domain',
          match: domainMatch[0]
        });
      }
    }
  }

  return findings;
}

function scanDirectory(dirPath, allowlist = []) {
  const findings = [];

  if (!fs.existsSync(dirPath)) {
    return findings;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      findings.push(...scanDirectory(fullPath, allowlist));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const scannable = ['.js', '.json', '.yaml', '.yml', '.txt', '.log', '.md', '.env', '.sh', '.bash', '.ts', '.tsx'];
      if (scannable.includes(ext) || ext === '') {
        findings.push(...scanFile(fullPath, allowlist));
      }
    }
  }

  return findings;
}

function printFindings(findings) {
  if (findings.length === 0) {
    return;
  }

  console.log('---RESULT---');
  console.log('status: failed');
  console.log('findings:');

  for (const f of findings) {
    console.log(`  - file: ${f.file}`);
    console.log(`    line: ${f.line}`);
    console.log(`    pattern: "${f.pattern}"`);
    console.log(`    match: "${f.match}"`);
  }

  console.log('---RESULT---');
}

async function main() {
  const options = parseArgs();
  const allowlist = [...DEFAULT_ALLOWLIST];

  if (options.strict) {
    PATTERNS = [...BASE_PATTERNS, ...STRICT_PATTERNS];
    console.log('[Scanner] Running in STRICT mode');
  }

  let scanPaths = [];

  if (options.path) {
    const absolutePath = path.isAbsolute(options.path)
      ? options.path
      : path.join(PROJECT_DIR, options.path);
    scanPaths.push(absolutePath);
  } else {
    scanPaths = getDefaultScanPaths();
  }

  if (scanPaths.length === 0) {
    console.log('---RESULT---');
    console.log('status: passed');
    console.log('findings:');
    console.log('---RESULT---');
    return;
  }

  const allFindings = [];

  for (const scanPath of scanPaths) {
    const findings = scanDirectory(scanPath, allowlist);
    allFindings.push(...findings);
  }

  printFindings(allFindings);

  if (allFindings.length > 0) {
    process.exit(1);
  }

  printResult({ status: 'passed', findings: [] });
}

main().catch(e => {
  console.error(`[ERROR] ${e.message}`);
  process.exit(1);
});
