#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import YAML from '../lib/js-yaml.mjs';
import { findProjectRoot } from '../lib/find-root.mjs';
import { spawnAgent } from '../lib/agent-spawner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = findProjectRoot(process.cwd());

import os from 'os';
import { execSync } from 'child_process';

function createTestWorkdir(skillName) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `wf-test-${skillName}-`));
  const workflowDir = path.join(tmpRoot, '.workflow');
  fs.mkdirSync(workflowDir, { recursive: true });
  for (const sub of ['tickets/backlog', 'tickets/ready', 'tickets/in-progress', 'tickets/review', 'tickets/done', 'tickets/archive', 'plans/current', 'plans/archive', 'reports', 'logs']) {
    fs.mkdirSync(path.join(workflowDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(workflowDir, 'coach-backlog.yaml'), 'version: 1\nanalyzed_tickets: []\naudited_skills: {}\n', 'utf8');

  const srcDir = path.join(workflowDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const realSkills = path.join(projectRoot, 'src', 'skills');
  const realScripts = path.join(projectRoot, 'src', 'scripts');
  const linkSkills = path.join(srcDir, 'skills');
  const linkScripts = path.join(srcDir, 'scripts');
  const configDir = path.join(workflowDir, 'config');
  const realConfigs = path.join(projectRoot, 'configs');

  // Skills are COPIED (not junctioned) so that agents cannot write to real source files.
  fs.cpSync(realSkills, linkSkills, { recursive: true, dereference: true });

  // Scripts and configs are junctioned — read-only for agents in practice.
  if (process.platform === 'win32') {
    try { execSync(`mklink /J "${linkScripts}" "${realScripts}"`, { stdio: 'pipe', shell: true }); } catch {}
    try { execSync(`mklink /J "${configDir}" "${realConfigs}"`, { stdio: 'pipe', shell: true }); } catch {}
  } else {
    try { fs.symlinkSync(realScripts, linkScripts, 'dir'); } catch {}
    try { fs.symlinkSync(realConfigs, configDir, 'dir'); } catch {}
  }

  return tmpRoot;
}

function cleanupTestWorkdir(tmpRoot) {
  if (!tmpRoot || !fs.existsSync(tmpRoot)) return;
  // Remove junctions first so that their targets are not touched by rmSync.
  if (process.platform === 'win32') {
    for (const link of ['src/scripts', 'config']) {
      const p = path.join(tmpRoot, '.workflow', link);
      try { execSync(`rmdir "${p}"`, { stdio: 'pipe', shell: true }); } catch {}
    }
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    skill: null,
    caseId: null,
    tag: null,
    layer: null,
    relevant: null,
    all: false,
    agent: null,
    primaryOnly: false,
    skipSecretScan: false,
    fast: false,
    yes: false,
    baselineRef: null,
    establishBaseline: false,
    calibrate: false,
    severity: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--calibrate') {
      opts.calibrate = true;
    } else if (arg === '--skill' && args[i + 1]) {
      opts.skill = args[i + 1];
      i++;
    } else if (arg === '--case' && args[i + 1]) {
      opts.caseId = args[i + 1];
      i++;
    } else if (arg === '--tag' && args[i + 1]) {
      opts.tag = args[i + 1];
      i++;
    } else if (arg === '--layer' && args[i + 1]) {
      opts.layer = args[i + 1];
      i++;
    } else if (arg === '--relevant' && args[i + 1]) {
      opts.relevant = args[i + 1];
      i++;
    } else if (arg === '--baseline-ref' && args[i + 1]) {
      opts.baselineRef = args[i + 1];
      i++;
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--agent' && args[i + 1]) {
      opts.agent = args[i + 1];
      i++;
    } else if (arg === '--primary-only') {
      opts.primaryOnly = true;
    } else if (arg === '--skip-secret-scan') {
      opts.skipSecretScan = true;
    } else if (arg === '--fast') {
      opts.fast = true;
    } else if (arg === '--yes') {
      opts.yes = true;
    } else if (arg === '--establish-baseline') {
      opts.establishBaseline = true;
    } else if (arg === '--pipeline' && args[i + 1]) {
      opts.pipeline = args[i + 1];
      i++;
    } else if (arg === '--severity' && args[i + 1]) {
      opts.severity = args[i + 1];
      i++;
    }
  }

  return opts;
}

function findSkillsDir() {
  return path.join(projectRoot, 'src', 'skills');
}

function findSkillTestsDir(skillName) {
  return path.join(findSkillsDir(), skillName, 'tests');
}

function loadIndexYaml(skillName) {
  const testsDir = findSkillTestsDir(skillName);
  const indexPath = path.join(testsDir, 'index.yaml');
  
  if (!fs.existsSync(indexPath)) {
    throw new Error(`index.yaml not found for skill: ${skillName}`);
  }
  
  const content = fs.readFileSync(indexPath, 'utf8');
  return YAML.load(content);
}

function getBaselineRef(skillName, explicitRef) {
  if (explicitRef) {
    return explicitRef;
  }
  
  const index = loadIndexYaml(skillName);
  return index.baseline_ref || 'origin/main';
}

function gitShow(baselineRef, filePath) {
  if (process.env.TEST_GIT_MOCK) {
    return new Promise((resolve) => {
      try {
        const mocks = JSON.parse(fs.readFileSync(process.env.TEST_GIT_MOCK, 'utf8'));
        // Нормализируем путь для кроссплатформности (Windows использует \, но mocks используют /)
        const normalizedPath = filePath.replace(/\\/g, '/');
        const key = `${baselineRef}:${normalizedPath}`;
        if (mocks[key]) {
          resolve(mocks[key]);
        } else if (mocks.__error && mocks.__error[key]) {
          throw new Error(mocks.__error[key]);
        } else {
          resolve(null);
        }
      } catch (e) {
        resolve(null);
      }
    });
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['show', `${baselineRef}:${filePath}`], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else if (stderr.includes('does not exist') || code === 128) {
        resolve(null);
      } else {
        reject(new Error(`git show failed: ${stderr}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function loadBaselineMeta(skillName, caseId, baselineRef) {
  const casesDir = path.join('src', 'skills', skillName, 'tests', 'cases', caseId);
  const metaPath = path.join(casesDir, 'current', 'meta.json');
  
  const gitMetaContent = await gitShow(baselineRef, metaPath);
  
  if (!gitMetaContent) {
    return null;
  }
  
  try {
    return JSON.parse(gitMetaContent);
  } catch {
    return null;
  }
}

async function analyzeGitHeadComparison(skillName, cases, baselineRef, currentRunStatuses = {}) {
  console.error(`[DEBUG] analyzeGitHeadComparison called`);
  console.log(`[Runner] analyzeGitHeadComparison called with ${cases.length} cases, skillName=${skillName}`);

  const comparison = {
    previously_green: 0,
    previously_green_still_green: 0,
    previously_green_now_red: 0,
    previously_red: 0,
    previously_red_still_red: 0,
    previously_red_now_green: 0,
    new_cases: 0
  };

  let hasBaselineHistory = false;

  console.log(`[Runner] Starting to iterate ${cases.length} cases`);
  for (const caseDef of cases) {
    console.log(`[Runner] Checking case ${caseDef.id} for git history`);
    let baselineMeta = null;
    try {
      baselineMeta = await loadBaselineMeta(skillName, caseDef.id, baselineRef);
      console.log(`[Runner] loadBaselineMeta result for ${caseDef.id}:`, baselineMeta ? 'found' : 'not found');

      if (!baselineMeta) {
        comparison.new_cases++;
        continue;
      }

      hasBaselineHistory = true;

      const prevStatus = baselineMeta.status;
      // Используем текущий статус из памяти (результат прогона), а не с диска
      const currentStatus = currentRunStatuses[caseDef.id] || 'unknown';

      if (prevStatus === 'passed') {
        comparison.previously_green++;
        if (currentStatus === 'passed') {
          comparison.previously_green_still_green++;
        } else if (currentStatus === 'failed' || currentStatus === 'error') {
          comparison.previously_green_now_red++;
        }
      } else if (prevStatus === 'failed' || prevStatus === 'error') {
        comparison.previously_red++;
        if (currentStatus === 'failed' || currentStatus === 'error') {
          comparison.previously_red_still_red++;
        } else if (currentStatus === 'passed') {
          comparison.previously_red_now_green++;
        }
      }
    } catch (err) {
      console.error(`[Runner] Error loading baseline meta for ${caseDef.id}:`, err.message);
      throw err;
    }
  }
  
  const mode = hasBaselineHistory ? 'no-regression' : 'no-baseline';
  console.log(`[Runner] analyzeGitHeadComparison: hasBaselineHistory=${hasBaselineHistory}, mode=${mode}, cases_checked=${Object.keys(comparison).reduce((sum, key) => sum + (comparison[key] || 0), 0)}`);

  return { comparison, mode };
}

function computeVerdict(comparison, mode, relevantCaseStatus, establishBaseline) {
  // Priority 1: Check relevant case status first
  if (relevantCaseStatus !== null && relevantCaseStatus !== 'passed') {
    return 'relevant_case_failed';
  }

  // Priority 2: Check for regression
  if (comparison.previously_green_now_red > 0) {
    return 'regression_detected';
  }

  // Priority 3: Check for no-baseline mode
  if (mode === 'no-baseline') {
    if (establishBaseline) {
      return 'baseline_established';
    }
    return 'no_baseline_failures';
  }

  // Default: ready for user review
  return 'ready_for_user_review';
}

function generateOutcomeMessage(result) {
  const { verdict, comparison, mode, relevantCase } = result;
  
  let msg = `Verdict: ${verdict}. `;
  
  if (mode === 'no-baseline') {
    msg += `Mode: no-baseline (no baseline history found). `;
  } else {
    msg += `Mode: no-regression. `;
  }
  
  msg += `Green→Red: ${comparison.previously_green_now_red}/${comparison.previously_green}. `;
  msg += `Red→Green: ${comparison.previously_red_now_green}/${comparison.previously_red}. `;
  msg += `New cases: ${comparison.new_cases}.`;
  
  if (relevantCase) {
    msg += ` Relevant case (${relevantCase.id}): ${relevantCase.status}.`;
  }
  
  return msg;
}

function resolvePipelineYaml(overridePath = null) {
  if (overridePath) {
    const resolved = path.resolve(overridePath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    throw new Error(`Pipeline not found: ${overridePath}`);
  }

  const projectRootDir = findProjectRoot(process.cwd());
  const workflowConfigPath = path.join(projectRootDir, '.workflow', 'config', 'pipeline.yaml');
  const packageRoot = path.dirname(projectRootDir);
  const packageConfigPath = path.join(packageRoot, 'configs', 'pipeline.yaml');

  if (fs.existsSync(workflowConfigPath)) {
    return workflowConfigPath;
  }

  if (fs.existsSync(packageConfigPath)) {
    return packageConfigPath;
  }

  throw new Error('pipeline.yaml not found in .workflow/config/ or configs/');
}

function loadPipelineConfig(pipelinePath = null) {
  const resolvedPath = resolvePipelineYaml(pipelinePath);
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const config = YAML.load(content);
  console.log(`[Runner] Using pipeline.yaml: ${resolvedPath}`);
  return config.pipeline || config;
}

function validateAgents(agentIds, pipelineConfig) {
  const availableAgents = Object.keys(pipelineConfig.agents || {});
  const invalid = [];
  
  for (const agentId of agentIds) {
    if (!availableAgents.includes(agentId)) {
      invalid.push(agentId);
    }
  }
  
  if (invalid.length > 0) {
    throw new Error(`Agent(s) '${invalid.join(', ')}' from target_agents[] not found in pipeline.yaml → agents[]`);
  }
  
  return true;
}

function loadTestCase(skillName, caseFile) {
  const testsDir = findSkillTestsDir(skillName);
  const casePath = path.join(testsDir, caseFile);
  
  if (!fs.existsSync(casePath)) {
    throw new Error(`Test case not found: ${casePath}`);
  }
  
  const content = fs.readFileSync(casePath, 'utf8');
  return YAML.load(content);
}

function filterCasesByTag(cases, tag) {
  if (!tag) return cases;
  return cases.filter(c => c.tags && c.tags.includes(tag));
}

function filterCasesBySeverity(cases, severity) {
  if (!severity) return cases;
  return cases.filter(c => c.severity === severity);
}

function getAllSkillNamesWithTests() {
  const skillsDir = findSkillsDir();
  const entries = fs.readdirSync(skillsDir);
  const skillNames = [];
  for (const entry of entries) {
    const fullPath = path.join(skillsDir, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const indexPath = path.join(fullPath, 'tests', 'index.yaml');
        if (fs.existsSync(indexPath)) {
          skillNames.push(entry);
        }
      }
    } catch (e) {
      // ignore
    }
  }
  return skillNames;
}

function runSecretScan() {
  return new Promise((resolve) => {
    const scannerPath = path.join(projectRoot, 'src', 'scripts', 'scan-fixtures-for-secrets.js');
    console.log('[Runner] Running secret scan before L2...');
    
    const proc = spawn(process.execPath, [scannerPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });
    
    proc.on('close', (code) => {
      if (code === 0 || stdout.includes('status: passed')) {
        console.log('[Runner] Secret scan passed');
        resolve({ passed: true });
      } else {
        console.log('[Runner] Secret scan FAILED - secrets detected:');
        console.log(stdout);
        if (stderr) console.error(stderr);
        resolve({ passed: false, output: stdout });
      }
    });
    
    proc.on('error', (err) => {
      console.error('[Runner] Secret scan error:', err.message);
      resolve({ passed: true });
    });
  });
}

function runL0Assertions(skillName, testCase) {
  const assertions = testCase.assertions?.static || [];
  const results = [];
  
  for (const assertion of assertions) {
    if (assertion.kind === 'skill_contains') {
      const skillFile = path.join(findSkillsDir(), skillName, assertion.file || 'SKILL.md');
      
      if (!fs.existsSync(skillFile)) {
        results.push({
          passed: false,
          kind: assertion.kind,
          reason: assertion.reason,
          error: `Skill file not found: ${skillFile}`
        });
        continue;
      }
      
      const skillContent = fs.readFileSync(skillFile, 'utf8');
      const regex = new RegExp(assertion.pattern, 'i');
      const matches = regex.test(skillContent);
      
      results.push({
        passed: matches,
        kind: assertion.kind,
        reason: assertion.reason,
        pattern: assertion.pattern
      });
    }
  }
  
  return results;
}

function runL1Assertions(output, testCase) {
  const assertions = testCase.assertions?.deterministic || [];
  const results = [];
  
  const outputDependentKinds = ['output_contains_all', 'output_matches', 'output_does_not_contain', 'output_yaml_shape'];
  if (!output && assertions.some(a => outputDependentKinds.includes(a.kind))) {
    return assertions.map(a => ({
      passed: true,
      skipped: true,
      kind: a.kind,
      reason: 'No agent output available (L2 not run)'
    }));
  }
  
  for (const assertion of assertions) {
    if (assertion.kind === 'output_contains_all') {
      const missing = [];
      for (const val of assertion.values || []) {
        if (!output.includes(val)) {
          missing.push(val);
        }
      }
      results.push({
        passed: missing.length === 0,
        kind: assertion.kind,
        missing,
        values: assertion.values
      });
    } else if (assertion.kind === 'output_matches') {
      const regex = new RegExp(assertion.regex);
      const matches = regex.test(output);
      results.push({
        passed: matches,
        kind: assertion.kind,
        regex: assertion.regex
      });
    } else if (assertion.kind === 'output_does_not_contain') {
      const found = [];
      for (const val of assertion.values || []) {
        if (output.includes(val)) {
          found.push(val);
        }
      }
      results.push({
        passed: found.length === 0,
        kind: assertion.kind,
        found,
        values: assertion.values
      });
    } else if (assertion.kind === 'output_yaml_shape') {
      try {
        const parsed = YAML.load(output);
        const hasKeys = assertion.required_keys?.every(k => parsed && typeof parsed[k] !== 'undefined');
        results.push({
          passed: hasKeys,
          kind: assertion.kind,
          required_keys: assertion.required_keys
        });
      } catch (e) {
        results.push({
          passed: false,
          kind: assertion.kind,
          error: e.message
        });
      }
    } else if (assertion.kind === 'is_json') {
      try {
        JSON.parse(output);
        results.push({
          passed: true,
          kind: assertion.kind
        });
      } catch (e) {
        results.push({
          passed: false,
          kind: assertion.kind,
          error: e.message
        });
      }
    } else {
      results.push({
        passed: false,
        kind: assertion.kind,
        error: `Unknown assertion kind: ${assertion.kind}`
      });
    }
  }
  
  return results;
}

function getSkillSha(skillName) {
  const skillsDir = findSkillsDir();
  const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
  
  if (!fs.existsSync(skillFile)) {
    return 'unknown';
  }
  
  const content = fs.readFileSync(skillFile, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 7);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadRubric(skillName, rubricName) {
  const rubricPath = path.join(findSkillsDir(), skillName, 'tests', 'rubrics', `${rubricName}.md`);
  if (!fs.existsSync(rubricPath)) {
    throw new Error(`Rubric not found: ${rubricPath}`);
  }
  return fs.readFileSync(rubricPath, 'utf8');
}

function findCalibrationFiles(skillName) {
  const rubricsDir = path.join(findSkillsDir(), skillName, 'tests', 'rubrics', 'calibration');
  if (!fs.existsSync(rubricsDir)) {
    return [];
  }

  const files = fs.readdirSync(rubricsDir);
  const calibrationMap = {};

  for (const file of files) {
    const match = file.match(/^(.+)-good\.md$/);
    if (match) {
      const rubricName = match[1];
      const goodPath = path.join(rubricsDir, file);
      const badPath = path.join(rubricsDir, `${rubricName}-bad.md`);
      const rubricPath = path.join(findSkillsDir(), skillName, 'tests', 'rubrics', `${rubricName}.md`);

      if (fs.existsSync(badPath) && fs.existsSync(rubricPath)) {
        calibrationMap[rubricName] = {
          good: goodPath,
          bad: badPath,
          rubric: rubricPath
        };
      }
    }
  }

  return calibrationMap;
}

function extractPassThreshold(rubricContent) {
  const match = rubricContent.match(/score\s*≥\s*(\d+)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return 4;
}

async function runCalibrationCheck(skillName, rubricName, calibrationFiles, pipelineConfig, judgeAgentId) {
  const judgeAgentConfig = pipelineConfig.agents[judgeAgentId];
  if (!judgeAgentConfig) {
    throw new Error(`Judge agent not found: ${judgeAgentId}`);
  }

  const rubricContent = fs.readFileSync(calibrationFiles.rubric, 'utf8');
  const threshold = extractPassThreshold(rubricContent);

  const goodContent = fs.readFileSync(calibrationFiles.good, 'utf8');
  const badContent = fs.readFileSync(calibrationFiles.bad, 'utf8');

  const judgePrompt = (agentOutput, task) => `You are a judge evaluating the output of an AI agent.

## Rubric
${rubricContent}

## Target Agent Output
${agentOutput}

## Task
${task}

Please evaluate the output according to the rubric and provide a score from 1 to 5.
Output format:
---RESULT---
score: <number 1-5>
reason: <brief explanation>
---RESULT---`;

  const extractGoodResponse = (content) => {
    const match = content.match(/## Ответ агента[\s\S]*?^---$/m);
    return match ? match[0] : content;
  };

  const goodOutput = extractGoodResponse(goodContent);
  const badOutput = extractGoodResponse(badContent);

  const [goodResult, badResult] = await Promise.all([
    spawnAgent(judgeAgentConfig, judgePrompt(goodOutput, 'Evaluate the good response'), { timeout: 60 }),
    spawnAgent(judgeAgentConfig, judgePrompt(badOutput, 'Evaluate the bad response'), { timeout: 60 })
  ]);

  const goodScore = parseJudgeResult(goodResult.output)?.score || 3;
  const badScore = parseJudgeResult(badResult.output)?.score || 3;

  return {
    rubricName,
    threshold,
    goodScore,
    badScore,
    goodPassed: goodScore >= threshold,
    badPassed: badScore < threshold
  };
}

async function runCalibrationGate(skillName, pipelineConfig) {
  const judgeAgent = loadIndexYaml(skillName).execution?.judge_agent;
  if (!judgeAgent) {
    console.log('[Runner] No judge_agent configured, skipping calibration gate');
    return { passed: true, calibrations: [] };
  }

  const calibrationMap = findCalibrationFiles(skillName);

  if (Object.keys(calibrationMap).length === 0) {
    console.log('[Runner] No calibration files found, skipping calibration gate');
    return { passed: true, calibrations: [], warnings: ['calibration files absent'] };
  }

  const results = [];
  const warnings = [];

  for (const [rubricName, files] of Object.entries(calibrationMap)) {
    console.log(`[Runner] Calibrating rubric: ${rubricName}`);
    const result = await runCalibrationCheck(skillName, rubricName, files, pipelineConfig, judgeAgent);
    results.push(result);

    if (!result.goodPassed) {
      console.error(`[Runner] ABORT: judge miscalibrated — rubric '${rubricName}' requires fix (good score=${result.goodScore}, expected ≥${result.threshold})`);
      return {
        passed: false,
        calibrations: results,
        error: `judge miscalibrated — rubric '${rubricName}' requires fix (good score=${result.goodScore}, expected ≥${result.threshold})`
      };
    }

    if (!result.badPassed) {
      console.error(`[Runner] ABORT: judge miscalibrated — rubric '${rubricName}' requires fix (bad score=${result.badScore}, expected <${result.threshold})`);
      return {
        passed: false,
        calibrations: results,
        error: `judge miscalibrated — rubric '${rubricName}' requires fix (bad score=${result.badScore}, expected <${result.threshold})`
      };
    }

    console.log(`[Runner] ${rubricName}: good=${result.goodScore} (≥${result.threshold}), bad=${result.badScore} (<${result.threshold}) ✓`);
  }

  return { passed: true, calibrations: results, warnings };
}

async function writeTrialOutput(skillName, caseId, agentId, trialNum, output) {
  const skillsDir = findSkillsDir();
  const trialDir = path.join(skillsDir, skillName, 'tests', 'cases', caseId, 'current');
  ensureDir(trialDir);
  
  const trialFile = path.join(trialDir, `${agentId}/trial-${trialNum}.md`);
  const agentDir = path.join(trialDir, agentId);
  ensureDir(agentDir);
  
  fs.writeFileSync(trialFile, output, 'utf8');
  return trialFile;
}

async function writeJudgeResults(skillName, caseId, results) {
  const skillsDir = findSkillsDir();
  const caseDir = path.join(skillsDir, skillName, 'tests', 'cases', caseId, 'current');
  ensureDir(caseDir);

  const judgePath = path.join(caseDir, 'judge.json');
  let judgeData = { per_model: {}, rubric_scores: [], timestamp: new Date().toISOString() };
  if (fs.existsSync(judgePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(judgePath, 'utf8'));
      judgeData.per_model = existing.per_model || {};
      judgeData.rubric_scores = existing.rubric_scores || [];
    } catch {}
  }

  const newAgentIds = new Set(Object.keys(results.per_model || {}));
  judgeData.rubric_scores = judgeData.rubric_scores.filter(r => !newAgentIds.has(r.agentId));
  for (const r of (results.rubric_scores || [])) {
    judgeData.rubric_scores.push(r);
  }

  for (const [agentId, modelData] of Object.entries(results.per_model || {})) {
    judgeData.per_model[agentId] = {
      pass_count: modelData.pass_count,
      total: modelData.total,
      trials: (modelData.trials || []).map(t => ({
        trial: t.trial,
        score: t.score,
        passed: t.passed
      }))
    };
  }

  judgeData.timestamp = new Date().toISOString();

  fs.writeFileSync(judgePath, JSON.stringify(judgeData, null, 2), 'utf8');
}

async function preFlightApproval(numCases, numModels, trials, judgeAgentCost = 0.02, targetAgentCost = 0.01) {
  const totalLlms = numCases * numModels * trials;
  const judgeCalls = numCases * numModels * trials;
  const targetCalls = numCases * numModels * trials;
  const estimatedCost = (judgeCalls * judgeAgentCost) + (targetCalls * targetAgentCost);
  
  console.log(`[Runner] Estimated LLM calls: ${totalLlms} (target: ${targetCalls}, judge: ${judgeCalls})`);
  console.log(`[Runner] Estimated cost: ~$${estimatedCost.toFixed(2)}`);
  
  if (!process.argv.includes('--yes')) {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    
    return new Promise((resolve) => {
      rl.question(`Estimated ${totalLlms} LLM calls ($${estimatedCost.toFixed(2)}). Continue? [y/N] `, (answer) => {
        rl.close();
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
          resolve(true);
        } else {
          console.log('[Runner] Aborted by user');
          process.exit(0);
        }
      });
    });
  }
  
  return true;
}

async function runL2Evaluation(skillName, testCase, caseDef, targetAgents, judgeAgentId, pipelineConfig, options = {}) {
  const { trials = 3, concurrency = 2, timeout = 300, testWorkdir = null } = options;
  
  const judgeAgentConfig = pipelineConfig.agents[judgeAgentId];
  if (!judgeAgentConfig) {
    throw new Error(`Judge agent not found: ${judgeAgentId}`);
  }

  let rubricName = 'default';
  if (testCase.assertions?.rubric && testCase.assertions.rubric.length > 0) {
    const rubricPath = testCase.assertions.rubric[0].rubric_file;
    if (rubricPath) {
      rubricName = path.basename(rubricPath, '.md');
    }
  }
  
  const rubric = loadRubric(skillName, rubricName);
  const results = {
    per_model: {},
    rubric_scores: [],
    tokens: null
  };

  const caseId = caseDef?.id || 'unknown';
  
  function buildTargetPrompt() {
    let targetPrompt = '';
    const testsDir = findSkillTestsDir(skillName);
    const caseDir = caseDef?.file ? path.dirname(caseDef.file) : '';
    
    if (testCase.scenario?.system_prompt_file) {
      const systemPromptPath = path.join(testsDir, caseDir, testCase.scenario.system_prompt_file);
      if (fs.existsSync(systemPromptPath)) {
        targetPrompt += fs.readFileSync(systemPromptPath, 'utf8') + '\n\n';
      }
    }

    if (testCase.scenario?.extra_instructions) {
      targetPrompt += testCase.scenario.extra_instructions + '\n\n';
    }

    if (testCase.scenario?.inputs) {
      for (const input of testCase.scenario.inputs) {
        if (input.kind === 'file') {
          const fixturePath = path.join(testsDir, caseDir, input.path);
          if (fs.existsSync(fixturePath)) {
            targetPrompt += `## ${input.as || 'Input'}\n`;
            targetPrompt += fs.readFileSync(fixturePath, 'utf8') + '\n\n';
          }
        }
      }
    }

    if (!targetPrompt.trim()) {
      targetPrompt = testCase.prompt || testCase.input || '';
    }
    
    return targetPrompt;
  }
  
  const allTasks = [];
  for (const agentId of targetAgents) {
    const agentConfig = pipelineConfig.agents[agentId];
    if (!agentConfig) {
      throw new Error(`Target agent not found: ${agentId}`);
    }
    results.per_model[agentId] = {
      trials: [],
      pass_count: 0,
      total: trials
    };
    for (let trial = 1; trial <= trials; trial++) {
      allTasks.push({ agentId, trial, agentConfig, judgeAgentConfig, rubric, testCase });
    }
  }

  const allResults = await Promise.all(
    allTasks.map(async (task) => {
      try {
        const targetPrompt = buildTargetPrompt();
        const targetOutput = await spawnAgent(task.agentConfig, targetPrompt, {
          timeout,
          stageId: `${caseId}-${task.agentId}-trial-${task.trial}`,
          projectRoot: testWorkdir || undefined
        });

        const judgePrompt = `You are a judge evaluating the output of an AI agent.

## Rubric
${rubric}

## Target Agent Output
${targetOutput.output || targetOutput.status || 'No output'}

## Task
${testCase.description || testCase.name || 'Evaluate the response'}

Please evaluate the output according to the rubric and provide a score from 1 to 5.
Output format:
---RESULT---
score: <number 1-5>
reason: <brief explanation>
---RESULT---`;

        const judgeResult = await spawnAgent(task.judgeAgentConfig, judgePrompt, {
          timeout: 60,
          stageId: `${caseId}-judge-${task.agentId}-trial-${task.trial}`
        });

        let score = 3;
        const parsed = parseJudgeResult(judgeResult.output);
        if (parsed && parsed.score) {
          score = parsed.score;
        }

        await writeTrialOutput(skillName, caseId, task.agentId, task.trial, targetOutput.output || '');

        return {
          trial: task.trial,
          agentId: task.agentId,
          score,
          output: targetOutput.output || '',
          judge_output: judgeResult.output || '',
          passed: score >= 4
        };
      } catch (err) {
        console.error(`[Runner] Trial failed: ${task.agentId} trial ${task.trial}`, err.message);
        return {
          trial: task.trial,
          agentId: task.agentId,
          score: 1,
          error: err.message,
          passed: false
        };
      }
    })
  );

  for (const result of allResults) {
    results.per_model[result.agentId].trials.push(result);
    if (result.passed) {
      results.per_model[result.agentId].pass_count++;
    }
    results.rubric_scores.push({
      agentId: result.agentId,
      trial: result.trial,
      score: result.score
    });
  }
  for (const agentId of Object.keys(results.per_model)) {
    results.per_model[agentId].trials.sort((a, b) => a.trial - b.trial);
  }
  results.rubric_scores.sort((a, b) =>
    a.agentId === b.agentId ? a.trial - b.trial : a.agentId.localeCompare(b.agentId)
  );

  return results;
}

function parseJudgeResult(output) {
  if (!output) return null;
  
  const scoreMatch = output.match(/score:\s*(\d+)/i);
  const reasonMatch = output.match(/reason:\s*(.+)/i);
  
  if (scoreMatch) {
    return {
      score: parseInt(scoreMatch[1], 10),
      reason: reasonMatch ? reasonMatch[1].trim() : ''
    };
  }
  
  return null;
}

function aggregateResults(results, testCase) {
  const aggregate = testCase.aggregate || 'auto';
  const severity = testCase.severity || 'normal';
  
  let useAll = aggregate === 'all';
  if (aggregate === 'auto') {
    useAll = severity === 'critical';
  }
  
  const perModelResults = {};
  
  for (const [agentId, modelData] of Object.entries(results.per_model)) {
    const passCount = modelData.pass_count;
    const total = modelData.total;
    const threshold = Math.ceil(total / 2);
    
    let passed;
    if (useAll) {
      passed = passCount === total;
    } else {
      passed = passCount >= threshold;
    }
    
    perModelResults[agentId] = {
      passed,
      pass_count: passCount,
      total,
      threshold: useAll ? total : threshold
    };
  }
  
  const allModelsPassed = Object.values(perModelResults).every(m => m.passed);
  
  return {
    per_model: perModelResults,
    overall_passed: allModelsPassed
  };
}

async function writeMetaJson(caseId, skillName, status, durationMs, l2Results = null, l1_skipped = null) {
  const skillsDir = findSkillsDir();
  const caseDir = path.join(skillsDir, skillName, 'tests', 'cases', caseId, 'current');
  ensureDir(caseDir);

  const metaPath = path.join(caseDir, 'meta.json');
  let existing = null;
  if (fs.existsSync(metaPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {}
  }

  const meta = {
    date: new Date().toISOString(),
    skill_sha: getSkillSha(skillName),
    status,
    duration_ms: durationMs
  };

  if (l1_skipped) {
    meta.l1_skipped = true;
  }

  const mergedPerModel = (existing && existing.per_model) ? { ...existing.per_model } : {};
  let mergedRubricScores = (existing && existing.rubric_scores) ? [...existing.rubric_scores] : [];

  if (l2Results) {
    const aggregated = aggregateResults(l2Results, {});
    const newAgentIds = new Set(Object.keys(aggregated.per_model || {}));
    for (const [agentId, data] of Object.entries(aggregated.per_model || {})) {
      mergedPerModel[agentId] = data;
    }
    mergedRubricScores = mergedRubricScores.filter(r => !newAgentIds.has(r.agentId));
    for (const r of (l2Results.rubric_scores || [])) {
      mergedRubricScores.push(r);
    }
    if (l2Results.tokens) {
      meta.tokens = l2Results.tokens;
    }
  }

  if (Object.keys(mergedPerModel).length > 0) {
    meta.per_model = mergedPerModel;
  }
  if (mergedRubricScores.length > 0) {
    meta.rubric_scores = mergedRubricScores;
  }

  const allPassed = Object.values(mergedPerModel).every(m => m.passed);
  if (Object.keys(mergedPerModel).length > 0) {
    meta.status = allPassed ? 'passed' : 'failed';
  }

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

async function runTestsForSkill(skillName, opts) {
  const testWorkdir = createTestWorkdir(skillName);
  console.log(`[Runner] Isolated test workdir: ${testWorkdir}`);
  const result = {
    skill: skillName,
    status: 'passed',
    total: 0,
    current_run: { passed: 0, failed: 0 },
    baseline_ref: 'origin/main',
    target_agents: [],
    judge_agent: null
  };
  let cases = [];
  const currentRunStatuses = {};

  try {
    const index = loadIndexYaml(skillName);
    const pipelineConfig = loadPipelineConfig(opts.pipeline || null);

    const defaultTargetAgents = index.execution?.target_agents || [];
    const judgeAgent = index.execution?.judge_agent || null;

    if (defaultTargetAgents.length > 0) {
      validateAgents(defaultTargetAgents, pipelineConfig);
      console.log(`[Runner] target_agents from index.yaml: ${defaultTargetAgents.join(', ')}`);
    }

    if (judgeAgent) {
      validateAgents([judgeAgent], pipelineConfig);
      console.log(`[Runner] judge_agent from index.yaml: ${judgeAgent}`);
    }

    let effectiveTargetAgents = defaultTargetAgents;

    if (opts.agent) {
      validateAgents([opts.agent], pipelineConfig);
      effectiveTargetAgents = [opts.agent];
      console.log(`[Runner] Override target_agents via --agent: ${opts.agent}`);
    } else if (opts.primaryOnly && defaultTargetAgents.length > 0) {
      effectiveTargetAgents = [defaultTargetAgents[0]];
      console.log(`[Runner] Using only primary agent: ${effectiveTargetAgents[0]}`);
    }

    result.target_agents = effectiveTargetAgents;
    result.judge_agent = judgeAgent;

    if (opts.calibrate) {
      console.log(`[Runner] Running calibration gate only...`);
      const calibrationResult = await runCalibrationGate(skillName, pipelineConfig);

      if (!calibrationResult.passed) {
        console.error(`[Runner] Calibration FAILED: ${calibrationResult.error}`);
        result.status = 'calibration_failed';
        result.error = calibrationResult.error;
        result.calibration = calibrationResult;
        return result;
      }

      console.log('[Runner] Calibration gate PASSED');
      result.calibration = calibrationResult;
      result.status = 'calibration_passed';
      return result;
    }

    cases = index.cases || [];

    if (opts.tag) {
      cases = filterCasesByTag(cases, opts.tag);
    }

    if (opts.severity) {
      cases = filterCasesBySeverity(cases, opts.severity);
    }

    if (opts.caseId) {
      const caseDef = cases.find(c => c.id === opts.caseId);
      if (caseDef) {
        const testCase = loadTestCase(skillName, caseDef.file);
        if (testCase.execution?.target_agents) {
          validateAgents(testCase.execution.target_agents, pipelineConfig);
          effectiveTargetAgents = testCase.execution.target_agents;
          console.log(`[Runner] Override target_agents in case ${opts.caseId}: ${effectiveTargetAgents.join(', ')}`);
        }
        if (testCase.execution?.judge_agent) {
          const caseJudgeAgent = testCase.execution.judge_agent;
          validateAgents([caseJudgeAgent], pipelineConfig);
          console.log(`[Runner] Override judge_agent in case ${opts.caseId}: ${caseJudgeAgent}`);
        }
        cases = [caseDef];
      } else {
        throw new Error(`Case not found: ${opts.caseId}`);
      }
    }

    result.total = cases.length;

    const startTime = Date.now();

    const runL2 = !opts.layer || opts.layer === 'l2';

    if (runL2 && effectiveTargetAgents.length > 0 && judgeAgent) {
      const trials = opts.fast ? 1 : 3;
      const totalModels = effectiveTargetAgents.length;
      const llmEstimate = cases.length * totalModels * trials * 2;
      await preFlightApproval(cases.length, totalModels, trials);
    }

    let secretScanFailed = false;
    let calibrationFailedResult = null;

    const anyRunL1 = !opts.layer || opts.layer === 'deterministic';
    const anyRunL2 = !opts.layer || opts.layer === 'l2';
    const anyHasRubric = cases.some(cd => {
      try {
        const tc = loadTestCase(skillName, cd.file);
        return tc.assertions?.rubric && tc.assertions.rubric.length > 0;
      } catch { return false; }
    });

    if (anyRunL1 && !opts.skipSecretScan) {
      const scanResult = await runSecretScan();
      if (!scanResult.passed) {
        secretScanFailed = true;
        result.error = 'Secret scan failed - secrets detected in fixtures';
      }
    }

    if (anyRunL2 && effectiveTargetAgents.length > 0 && judgeAgent && anyHasRubric && !secretScanFailed) {
      const calibrationResult = await runCalibrationGate(skillName, pipelineConfig);
      if (!calibrationResult.passed) {
        console.error(`[Runner] Calibration gate FAILED: ${calibrationResult.error}`);
        calibrationFailedResult = calibrationResult;
        result.status = 'calibration_failed';
        result.error = calibrationResult.error;
        result.calibration = calibrationResult;
        return { ...result, cases, currentRunStatuses };
      }
      if (calibrationResult.warnings && calibrationResult.warnings.length > 0) {
        console.log(`[Runner] Calibration warnings: ${calibrationResult.warnings.join(', ')}`);
      }
      console.log('[Runner] Calibration gate PASSED');
    }

    await Promise.all(cases.map(async (caseDef) => {
      const caseStart = Date.now();

      try {
        const testCase = loadTestCase(skillName, caseDef.file);
        
        const hasRubric = testCase.assertions?.rubric && testCase.assertions.rubric.length > 0;
        
        const runL0 = !opts.layer || opts.layer === 'static' || opts.layer === 'deterministic';
        const runL1 = !opts.layer || opts.layer === 'deterministic';
        const runL2 = !opts.layer || opts.layer === 'l2';

        // Secret scan result propagated from pre-loop
        if (runL1 && !opts.skipSecretScan && secretScanFailed) {
          result.current_run.failed++;
          result.status = 'failed';
          currentRunStatuses[caseDef.id] = 'failed';
          await writeMetaJson(caseDef.id, skillName, 'failed', Date.now() - caseStart);
          return;
        }

        // L0 static assertions
        if (runL0) {
          const l0Results = runL0Assertions(skillName, testCase);
          const l0Failed = l0Results.filter(r => !r.passed);
          if (l0Failed.length > 0) {
            result.current_run.failed++;
            result.status = 'failed';
            currentRunStatuses[caseDef.id] = 'failed';
            await writeMetaJson(caseDef.id, skillName, 'failed', Date.now() - caseStart);
            return;
          }
        }

        if (runL1) {
          const mockOutput = '';
          const l1Results = runL1Assertions(mockOutput, testCase);
          const l1Failed = l1Results.filter(r => !r.passed);
          const l1Skipped = l1Results.some(r => r.skipped);

          const caseStatus = l1Failed.length === 0 ? 'passed' : 'failed';
          currentRunStatuses[caseDef.id] = caseStatus;

          if (l1Failed.length > 0) {
            result.current_run.failed++;
            result.status = 'failed';
          } else {
            result.current_run.passed++;
          }

          if (l1Skipped) {
            result.l1_skipped = true;
          }

          let l2Results = null;
          if (runL2 && effectiveTargetAgents.length > 0 && judgeAgent && hasRubric) {
            const trials = opts.fast ? 1 : 3;
            const index = loadIndexYaml(skillName);
            const defaultTimeout = index.execution?.default_timeout_s || 300;
            const timeout = testCase.execution?.timeout_s || defaultTimeout;
            try {
              l2Results = await runL2Evaluation(
                skillName,
                testCase,
                caseDef,
                effectiveTargetAgents,
                judgeAgent,
                pipelineConfig,
                { trials, concurrency: 2, timeout, testWorkdir }
              );

              const aggregated = aggregateResults(l2Results, testCase);
              console.log(`[Runner] L2 Results for ${caseDef.id}:`, JSON.stringify(aggregated, null, 2));

              await writeJudgeResults(skillName, caseDef.id, l2Results);

              if (!aggregated.overall_passed) {
                result.status = 'failed';
                currentRunStatuses[caseDef.id] = 'failed';
              }
            } catch (l2Err) {
              console.error(`[Runner] L2 evaluation failed:`, l2Err.message);
              result.status = 'failed';
              currentRunStatuses[caseDef.id] = 'failed';
            }
          }

          await writeMetaJson(caseDef.id, skillName, caseStatus, Date.now() - caseStart, l2Results, result.l1_skipped);
        } else if (runL2 && effectiveTargetAgents.length > 0 && judgeAgent && hasRubric) {
          const trials = opts.fast ? 1 : 3;
          const defaultTimeout = index.execution?.default_timeout_s || 300;
          const timeout = testCase.execution?.timeout_s || defaultTimeout;
          let l2Results = null;
          let caseStatus = 'passed';
          try {
            l2Results = await runL2Evaluation(
              skillName,
              testCase,
              caseDef,
              effectiveTargetAgents,
              judgeAgent,
              pipelineConfig,
              { trials, concurrency: 2, timeout }
            );

            const aggregated = aggregateResults(l2Results, testCase);
            console.log(`[Runner] L2 Results for ${caseDef.id}:`, JSON.stringify(aggregated, null, 2));

            await writeJudgeResults(skillName, caseDef.id, l2Results);

            if (!aggregated.overall_passed) {
              result.status = 'failed';
              result.current_run.failed++;
              caseStatus = 'failed';
            } else {
              result.current_run.passed++;
            }
          } catch (l2Err) {
            console.error(`[Runner] L2 evaluation failed:`, l2Err.message);
            result.status = 'failed';
            result.current_run.failed++;
            caseStatus = 'failed';
          }

          currentRunStatuses[caseDef.id] = caseStatus;
          await writeMetaJson(caseDef.id, skillName, caseStatus, Date.now() - caseStart, l2Results);
        } else {
          result.current_run.passed++;
          currentRunStatuses[caseDef.id] = 'passed';
          await writeMetaJson(caseDef.id, skillName, 'passed', Date.now() - caseStart);
        }
      } catch (e) {
        result.current_run.failed++;
        result.status = 'failed';
        currentRunStatuses[caseDef.id] = 'error';
        await writeMetaJson(caseDef.id, skillName, 'error', Date.now() - caseStart);
      }
    }));
  } catch (e) {
    result.status = 'error';
    result.error = e.message;
  } finally {
    cleanupTestWorkdir(testWorkdir);
  }

  return {
    ...result,
    cases,
    currentRunStatuses
  };
}

async function runSkillTests(opts) {
  // Validate options
  if (!opts.all && !opts.skill) {
    throw new Error('Either --skill or --all must be specified');
  }

  const results = {
    status: 'passed',
    skill: opts.skill || 'unknown',
    mode: 'deterministic',
    total: 0,
    current_run: { passed: 0, failed: 0 },
    baseline_ref: 'origin/main',
    git_head_comparison: null,
    verdict: 'ready_for_user_review',
    outcome_message: ''
  };

  try {
    if (opts.skill) {
      const skillResult = await runTestsForSkill(opts.skill, opts);

      // Merge skill results
      results.skill = skillResult.skill;
      results.total = skillResult.total;
      results.current_run.passed = skillResult.current_run.passed;
      results.current_run.failed = skillResult.current_run.failed;
      results.status = skillResult.status;
      results.target_agents = skillResult.target_agents;
      results.judge_agent = skillResult.judge_agent;
      if (skillResult.error) results.error = skillResult.error;
      if (skillResult.calibration) results.calibration = skillResult.calibration;

      // Prepare for git comparison (if applicable)
      const cases = skillResult.cases;
      const currentRunStatuses = skillResult.currentRunStatuses;

      // Git comparison and verdict (skip for calibration or no cases)
      if (cases && cases.length > 0 && !opts.calibrate && !skillResult.status.startsWith('calibration_')) {
        try {
          const baselineRef = getBaselineRef(opts.skill, opts.baselineRef);
          results.baseline_ref = baselineRef;

          console.log(`[Runner] Computing git head comparison for ${cases.length} cases with baselineRef=${baselineRef}`);
          const gitResult = await analyzeGitHeadComparison(opts.skill, cases, baselineRef, currentRunStatuses);
          const { comparison, mode } = gitResult;
          results.mode = mode;
          results.git_head_comparison = comparison;
          console.log(`[Runner] Git head comparison complete: mode=${mode}`);

          let relevantCaseStatus = null;
          if (opts.relevant) {
            const relevantCaseDir = path.join(findSkillTestsDir(opts.skill), 'cases', opts.relevant, 'current', 'meta.json');
            if (fs.existsSync(relevantCaseDir)) {
              try {
                const meta = JSON.parse(fs.readFileSync(relevantCaseDir, 'utf8'));
                relevantCaseStatus = meta.status;
              } catch {}
            }
          }

          if (relevantCaseStatus) {
            results.relevant_case_status = relevantCaseStatus;
          }

          results.verdict = computeVerdict(comparison, mode, relevantCaseStatus, opts.establishBaseline);
          results.outcome_message = generateOutcomeMessage({
            verdict: results.verdict,
            comparison,
            mode,
            relevantCase: opts.relevant ? { id: opts.relevant, status: relevantCaseStatus } : null
          });
        } catch (verdictErr) {
          console.error('[Runner] Verdict computation failed:', verdictErr.message);
          console.error('[Runner] Stack:', verdictErr.stack);
        }
      }
    } else if (opts.all) {
      const skillNames = getAllSkillNamesWithTests();
      let total = 0;
      let passed = 0;
      let failed = 0;
      let overallStatus = 'passed';

      for (const skillName of skillNames) {
        const skillResult = await runTestsForSkill(skillName, opts);
        total += skillResult.total;
        passed += skillResult.current_run.passed;
        failed += skillResult.current_run.failed;
        if (skillResult.status !== 'passed') {
          overallStatus = 'failed';
        }
      }

      results.total = total;
      results.current_run.passed = passed;
      results.current_run.failed = failed;
      results.status = overallStatus;
      results.skill = 'all';
      results.mode = 'aggregated';
      results.verdict = overallStatus === 'passed' ? 'all_passed' : 'aggregated_failed';
      results.outcome_message = overallStatus === 'passed' ? 'All skills passed' : 'Some skills failed';
      results.baseline_ref = null;
    }
  } catch (e) {
    results.status = 'error';
    results.error = e.message;
  }

  return results;
}

function printResult(result) {
  console.log('---RESULT---');
  console.log(`status: ${result.status}`);
  console.log(`skill: ${result.skill}`);
  console.log(`mode: ${result.mode}`);
  console.log(`total: ${result.total}`);
  console.log(`current_run.passed: ${result.current_run.passed}`);
  console.log(`current_run.failed: ${result.current_run.failed}`);

  if (result.baseline_ref) {
    console.log(`baseline_ref: ${result.baseline_ref}`);
  }

  if (result.git_head_comparison) {
    const c = result.git_head_comparison;
    console.log(`git_head_comparison.previously_green: ${c.previously_green}`);
    console.log(`git_head_comparison.previously_green_still_green: ${c.previously_green_still_green}`);
    console.log(`git_head_comparison.previously_green_now_red: ${c.previously_green_now_red}`);
    console.log(`git_head_comparison.previously_red: ${c.previously_red}`);
    console.log(`git_head_comparison.previously_red_still_red: ${c.previously_red_still_red}`);
    console.log(`git_head_comparison.previously_red_now_green: ${c.previously_red_now_green}`);
    console.log(`git_head_comparison.new_cases: ${c.new_cases}`);
  }

  if (result.relevant_case_status) {
    console.log(`relevant_case_status: ${result.relevant_case_status}`);
  }

  if (result.verdict) {
    console.log(`verdict: ${result.verdict}`);
  }

  if (result.outcome_message) {
    console.log(`outcome_message: ${result.outcome_message}`);
  }

  console.log('---RESULT---');
}

function showHelp() {
  console.log('run-skill-tests.js - Runner for skill tests');
  console.log('');
  console.log('Usage:');
  console.log('  node run-skill-tests.js --skill <name>     Run all tests for a skill');
  console.log('  node run-skill-tests.js --case TC-XXX-NNN  Run a single test case');
  console.log('  node run-skill-tests.js --tag <tag>      Filter tests by tag');
  console.log('  node run-skill-tests.js --severity <level>  Filter tests by severity (e.g., critical, normal)');
  console.log('  node run-skill-tests.js --layer static|deterministic|l2  Run only L0, L1 or L2');
  console.log('  node run-skill-tests.js --relevant TC-XXX-NNN  Mark relevant case for coach');
  console.log('  node run-skill-tests.js --baseline-ref <ref>  Override baseline ref (default: origin/main)');
  console.log('  node run-skill-tests.js --establish-baseline  Allow reds in no-baseline mode');
  console.log('  node run-skill-tests.js --all             Run all skills');
  console.log('  node run-skill-tests.js --agent <id>      Run only on specific model from target_agents[]');
  console.log('  node run-skill-tests.js --primary-only    Run only on first model from target_agents[]');
  console.log('  node run-skill-tests.js --skip-secret-scan  Skip secret scanning before L2');
  console.log('  node run-skill-tests.js --fast            Run with trials=1 for all cases');
  console.log('  node run-skill-tests.js --yes             Skip pre-flight approval gate');
  console.log('  node run-skill-tests.js --calibrate       Run only calibration gate (no full suite)');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  const opts = parseArgs();
  const result = await runSkillTests(opts);
  printResult(result);
  
  if (result.status === 'error') {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});