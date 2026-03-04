#!/usr/bin/env node

import { initProject } from './init.mjs';
import { runPipeline } from './runner.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');

const HELP_TEXT = `workflow-ai v1.0.0

Usage:
  workflow init [path] [--force]   Initialize .workflow/ in target directory
  workflow run [options]           Run the AI pipeline
  workflow help                    Show this help
  workflow version                 Show version

Run options:
  --plan <plan>      Plan ID to execute
  --config <path>    Config file path
  --project <path>   Project root (default: auto-detect)
`;

function showHelp() {
  console.log(HELP_TEXT);
}

function showVersion() {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    console.log(`workflow-ai v${pkg.version}`);
  } catch (err) {
    console.error('Error reading package.json:', err.message);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 2;
      } else {
        args[key] = true;
        i += 1;
      }
    } else {
      args._.push(arg);
      i += 1;
    }
  }
  return args;
}

async function runInit(args) {
  const targetPath = args._[0] || process.cwd();
  const force = args.force === true;
  const result = initProject(targetPath, { force });
  
  if (result.errors && result.errors.length > 0) {
    console.error('Errors:', result.errors.join(', '));
    process.exit(1);
  }
  
  console.log('✅ Initialization completed:');
  result.steps.forEach(step => console.log(`  • ${step}`));
  if (result.warnings && result.warnings.length > 0) {
    console.warn('Warnings:', result.warnings.join(', '));
  }
}

async function runRun(args) {
  // Expose wf's node_modules to child ESM scripts via a custom loader
  const loaderPath = join(__dirname, 'wf-loader.mjs');
  const loaderUrl = `file:///${loaderPath.replace(/\\/g, '/')}`;
  process.env.NODE_OPTIONS = process.env.NODE_OPTIONS
    ? `${process.env.NODE_OPTIONS} --import ${loaderUrl}`
    : `--import ${loaderUrl}`;

  const argv = [];
  if (args.plan) {
    argv.push('--plan', args.plan);
  }
  if (args.config) {
    argv.push('--config', args.config);
  }
  if (args.project) {
    argv.push('--project', args.project);
  }
  
  await runPipeline(argv);
}

export function run(argv) {
  const args = parseArgs(argv);
  const command = args._.shift();

  switch (command) {
    case 'init':
      runInit(args);
      break;
    case 'run':
      runRun(args);
      break;
    case 'help':
      showHelp();
      break;
    case 'version':
      showVersion();
      break;
    default:
      if (!command) {
        showHelp();
      } else {
        console.error(`Unknown command: ${command}`);
        console.error('Run "workflow help" for usage.');
        process.exit(1);
      }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2));
}