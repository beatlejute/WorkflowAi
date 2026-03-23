#!/usr/bin/env node

import { initProject } from './init.mjs';
import { runPipeline } from './runner.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGlobalDir, refreshGlobalDir, ensureGlobalDir } from './global-dir.mjs';
import { createSkillJunctions, createScriptHardlinks, ejectSkill, listSkillsWithStatus } from './junction-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');

const HELP_TEXT = `workflow-ai v1.0.0

Usage:
  workflow init [path] [--force]   Initialize .workflow/ in target directory
  workflow run [options]           Run the AI pipeline
  workflow update [path]           Update global dir and recreate junctions/hardlinks
  workflow eject <skill> [path]    Eject a skill (copy from global to project)
  workflow list [path]             List skills with status (shared/ejected/project-only)
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

function getPackageRoot() {
  return resolve(__dirname, '..');
}

function getWorkflowRoot(projectRoot) {
  return join(projectRoot, '.workflow');
}

function runUpdate(args) {
  const projectRoot = resolve(args._[0] || process.cwd());
  const workflowRoot = getWorkflowRoot(projectRoot);
  const packageRoot = getPackageRoot();
  const globalDir = getGlobalDir();

  refreshGlobalDir(packageRoot);
  console.log('✅ Global dir updated (~/.workflow/)');

  const skillsDir = join(workflowRoot, 'src', 'skills');
  createSkillJunctions(globalDir, skillsDir);
  console.log('✅ Skill junctions recreated');

  const scriptsDir = join(workflowRoot, 'src', 'scripts');
  createScriptHardlinks(globalDir, scriptsDir);
  console.log('✅ Script hardlinks recreated');
}

function runEject(args) {
  const skillName = args._[0];
  if (!skillName) {
    console.error('Error: skill name is required. Usage: workflow eject <skill>');
    process.exit(1);
  }
  const projectRoot = resolve(args._[1] || process.cwd());
  const workflowRoot = getWorkflowRoot(projectRoot);
  const globalDir = getGlobalDir();
  const skillsDir = join(workflowRoot, 'src', 'skills');

  ejectSkill(skillName, globalDir, skillsDir);
  console.log(`✅ Skill "${skillName}" ejected (copied to project)`);
}

function runList(args) {
  const projectRoot = resolve(args._[0] || process.cwd());
  const workflowRoot = getWorkflowRoot(projectRoot);
  const globalDir = getGlobalDir();
  const skillsDir = join(workflowRoot, 'src', 'skills');

  const skills = listSkillsWithStatus(globalDir, skillsDir);

  if (skills.length === 0) {
    console.log('No skills found.');
    return;
  }

  const maxName = Math.max(...skills.map(s => s.name.length), 4);
  const maxStatus = Math.max(...skills.map(s => s.status.length), 6);

  console.log(`${'Skill'.padEnd(maxName)}  ${'Status'.padEnd(maxStatus)}`);
  console.log(`${'─'.repeat(maxName)}  ${'─'.repeat(maxStatus)}`);
  for (const skill of skills) {
    console.log(`${skill.name.padEnd(maxName)}  ${skill.status.padEnd(maxStatus)}`);
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
    case 'update':
      runUpdate(args);
      break;
    case 'eject':
      runEject(args);
      break;
    case 'list':
      runList(args);
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