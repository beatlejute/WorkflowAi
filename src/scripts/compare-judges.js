#!/usr/bin/env node

/**
 * Сравнение судей тестов скилов по сохранённым записям попыток (PLAN-001).
 *
 * Раннер тестов пишет запись вызова судьи рядом с выводом исполнителя:
 * `src/skills/<skill>/tests/cases/<CASE>/current/<agent>/trial-<N>.judge.json`
 * (src/lib/skill-judge.mjs). Скрипт переоценивает каждую запись судьёй `--judge`
 * с тем же входом, без запуска исполнителей, и сравнивает с баллом записи.
 * Так согласие судей перемеряется на промптах текущего прогона, а не разбором
 * транскриптов, как в пилоте 2026-09-24.
 *
 * Судья `--judge` оценивает сам: без эскалации и без фоллбека (skill-judge.mjs,
 * noEscalation) — иначе сравнивался бы не он. Отказ судьи — строка «переоценка
 * не удалась». Записи с ошибкой судьи пропускаются и считаются отдельно.
 *
 * Выводы исполнителей уходят судье `--judge` — для судьи на внешней модели во
 * внешний сервис. Перед вызовами — оценка числа и цены вызовов и вопрос; `--yes`
 * его пропускает.
 *
 * Использование:
 *   node src/scripts/compare-judges.js --judge <агент> [--skill <name>] [--out <file.md>]
 *     [--disagreements <dir>] [--pipeline <pipeline.yaml>] [--concurrency 8] [--yes]
 *
 * Окружение: WORKFLOW_SKILLS_DIR — каталог скилов (по умолчанию <корень>/src/skills).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from '../lib/js-yaml.mjs';
import { findProjectRoot } from '../lib/find-root.mjs';
import { runJudge, createJudgeRunState, JUDGE_PASS_SCORE, DEFAULT_JUDGE_CALL_COST } from '../lib/skill-judge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = [0.7, 0.8, 0.95];
const DEFAULT_CONCURRENCY = 8;
const JUDGE_TIMEOUT_S = 180;

function usage() {
  return [
    'Usage: node compare-judges.js --judge <agent> [--skill <name>] [--out <file.md>]',
    '         [--disagreements <dir>] [--pipeline <pipeline.yaml>] [--concurrency N] [--yes]',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { concurrency: DEFAULT_CONCURRENCY, yes: false };
  const valueOf = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--judge') opts.judge = valueOf(i++, arg);
    else if (arg === '--skill') opts.skill = valueOf(i++, arg);
    else if (arg === '--out') opts.out = valueOf(i++, arg);
    else if (arg === '--disagreements') opts.disagreements = valueOf(i++, arg);
    else if (arg === '--pipeline') opts.pipeline = valueOf(i++, arg);
    else if (arg === '--concurrency') opts.concurrency = Number(valueOf(i++, arg));
    else if (arg === '--yes') opts.yes = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.help && !opts.judge) throw new Error('--judge is required');
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new Error('--concurrency must be an integer >= 1');
  return opts;
}

function projectRootOrCwd() {
  try {
    return findProjectRoot(process.cwd());
  } catch {
    return process.cwd();
  }
}

function loadAgents(pipelineOpt, root) {
  const candidates = pipelineOpt
    ? [path.resolve(pipelineOpt)]
    : [path.join(root, '.workflow', 'config', 'pipeline.yaml'), path.resolve(__dirname, '..', '..', 'configs', 'pipeline.yaml')];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`pipeline.yaml not found: ${candidates.join(', ')}`);
  const config = YAML.load(fs.readFileSync(file, 'utf8'));
  return { file, agents: (config.pipeline || config).agents || {} };
}

/** Записи судьи: `<skill>/tests/cases/<case>/current/<agent>/trial-<N>.judge.json`. */
function collectRecords(skillsDir, skillFilter = null) {
  const records = [];
  const list = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const skill of list(skillsDir)) {
    if (!skill.isDirectory() || (skillFilter && skill.name !== skillFilter)) continue;
    const casesDir = path.join(skillsDir, skill.name, 'tests', 'cases');
    for (const caseDir of list(casesDir)) {
      if (!caseDir.isDirectory()) continue;
      const current = path.join(casesDir, caseDir.name, 'current');
      for (const agentDir of list(current)) {
        if (!agentDir.isDirectory()) continue;
        for (const file of list(path.join(current, agentDir.name))) {
          const match = file.name.match(/^trial-(\d+)\.judge\.json$/);
          if (!match) continue;
          const full = path.join(current, agentDir.name, file.name);
          let record = null;
          let parseError = null;
          try {
            record = JSON.parse(fs.readFileSync(full, 'utf8'));
          } catch (err) {
            parseError = err.message;
          }
          records.push({
            skill: skill.name, caseId: caseDir.name, agent: agentDir.name, trial: Number(match[1]),
            file: full, record, parseError,
          });
        }
      }
    }
  }
  return records.sort((a, b) => a.file.localeCompare(b.file));
}

const isPass = (score) => score >= JUDGE_PASS_SCORE;
const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);

/**
 * Сводка по сравнённым строкам: { baseline: балл записи, candidate: запись судьи --judge }.
 */
function summarize(rows) {
  const compared = rows.length;
  let exact = 0;
  let within1 = 0;
  let passFail = 0;
  const matrix = Array.from({ length: 5 }, () => Array(5).fill(0));
  const bySkill = new Map();
  for (const row of rows) {
    const a = row.baseline;
    const b = row.candidate.score;
    if (a === b) exact++;
    if (Math.abs(a - b) <= 1) within1++;
    const agree = isPass(a) === isPass(b);
    if (agree) passFail++;
    matrix[a - 1][b - 1]++;
    const skill = bySkill.get(row.skill) || { records: 0, exact: 0, passFail: 0 };
    skill.records++;
    if (a === b) skill.exact++;
    if (agree) skill.passFail++;
    bySkill.set(row.skill, skill);
  }
  const disagreements = rows.filter((row) => isPass(row.baseline) !== isPass(row.candidate.score));
  const withConfidence = rows.filter((row) => typeof row.candidate.confidence === 'number').length;
  const thresholds = withConfidence === 0 ? [] : THRESHOLDS.map((t) => {
    const low = (row) => row.candidate.confidence === null || row.candidate.confidence < t;
    const kept = rows.filter((row) => !low(row));
    return {
      threshold: t,
      escalated: compared - kept.length,
      kept: kept.length,
      keptAgree: kept.filter((row) => isPass(row.baseline) === isPass(row.candidate.score)).length,
      missed: disagreements.filter((row) => !low(row)).length,
    };
  });
  const costs = rows.map((row) => row.candidate.cost_usd).filter((c) => typeof c === 'number');
  return {
    compared, exact, within1, passFail, matrix, bySkill, disagreements, thresholds,
    cost: costs.reduce((sum, c) => sum + c, 0),
    unpriced: compared - costs.length,
  };
}

function formatReport({ judge, found, skippedRecords, selfScored, failed, summary, baselineJudges, skill }) {
  const s = summary;
  const lines = [
    `# Согласие судей: ${judge} против записанных оценок`,
    '',
    `Записей судьи найдено: ${found}${skill ? ` (скил ${skill})` : ''}. Судьи записей: ${baselineJudges.join(', ') || '—'}.`,
    `Пропущено записей с ошибкой судьи: ${skippedRecords}. Пропущено записей, балл которых дал сам ${judge}: ${selfScored}. Переоценка не удалась: ${failed}. Сравнено: ${s.compared}.`,
    '',
    '## Совпадение',
    '',
    '| Показатель | Значение |',
    '|------------|----------|',
    `| Точное совпадение балла | ${s.exact} из ${s.compared} (${pct(s.exact, s.compared)}) |`,
    `| В пределах ±1 | ${s.within1} из ${s.compared} (${pct(s.within1, s.compared)}) |`,
    `| Совпадение pass/fail (порог ${JUDGE_PASS_SCORE}) | ${s.passFail} из ${s.compared} (${pct(s.passFail, s.compared)}) |`,
    `| Расхождений pass/fail | ${s.disagreements.length} |`,
    '',
    `## Матрица баллов (строки — запись, столбцы — ${judge})`,
    '',
    '| запись \\ судья | 1 | 2 | 3 | 4 | 5 |',
    '|---|---|---|---|---|---|',
    ...s.matrix.map((row, i) => `| ${i + 1} | ${row.join(' | ')} |`),
    '',
    '## По скилам',
    '',
    '| Скил | Записей | Точно | pass/fail |',
    '|------|---------|-------|-----------|',
    ...[...s.bySkill.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) =>
      `| ${name} | ${v.records} | ${v.exact} (${pct(v.exact, v.records)}) | ${v.passFail} (${pct(v.passFail, v.records)}) |`),
    '',
    '## Пороги уверенности',
    '',
  ];
  if (s.thresholds.length === 0) {
    lines.push(`Судья ${judge} не сообщает уверенность — таблица порогов не строится.`);
  } else {
    lines.push(
      '| Порог | Уходит на эскалацию | Совпадение pass/fail на оставшихся | Расхождений мимо порога |',
      '|-------|---------------------|------------------------------------|-------------------------|',
      ...s.thresholds.map((t) => `| ${t.threshold} | ${t.escalated} (${pct(t.escalated, s.compared)}) | ${t.keptAgree} из ${t.kept} (${pct(t.keptAgree, t.kept)}) | ${t.missed} из ${s.disagreements.length} |`),
    );
  }
  lines.push(
    '',
    '## Цена',
    '',
    `Судья ${judge}: $${s.cost.toFixed(4)} за ${s.compared - s.unpriced} вызовов с ценой; без цены в ответе: ${s.unpriced}.`,
    '',
  );
  return lines.join('\n');
}

/** Агент, чей балл стоит в записи: при эскалации и фоллбеке — `escalate_to`. */
function scorerOf(record) {
  if ((record.escalated || record.fallback) && record.escalation?.judge_agent) return record.escalation.judge_agent;
  return record.judge_agent;
}

/** Кто дал балл записи, для отчёта: при эскалации и фоллбеке — с пометкой, от кого перешла оценка. */
function scoredBy(record) {
  if ((record.escalated || record.fallback) && record.escalation?.judge_agent) {
    const why = record.fallback ? `фоллбек ${record.fallback}` : 'эскалация';
    return `${record.escalation.judge_agent} (${why} с ${record.judge_agent})`;
  }
  return record.judge_agent;
}

function disagreementFile(row) {
  const r = row.record;
  const c = row.candidate;
  return [
    `# ${row.skill} / ${row.caseId} / ${row.agent} / trial ${row.trial}`,
    '',
    `- Запись: ${scoredBy(r)} — балл ${row.baseline}`,
    `- ${c.judge_agent}: балл ${c.score}, уверенность ${c.confidence ?? '—'}, вероятности ${JSON.stringify(c.probabilities)}`,
    `- Рубрика: ${r.input?.rubric_file ?? '—'}`,
    '',
    '## Критерий',
    '',
    r.input?.criterion ?? '',
    '',
    '## Вывод исполнителя',
    '',
    '```',
    `${r.input?.agent_output ?? ''}${r.input?.ticket_files ?? ''}`,
    '```',
    '',
    `## Ответ записи (${scoredBy(r)})`,
    '',
    '```',
    r.escalation?.raw_output ?? r.raw_output ?? '',
    '```',
    '',
    `## Ответ ${c.judge_agent}`,
    '',
    '```',
    c.raw_output ?? '',
    '```',
    '',
  ].join('\n');
}

async function confirm(question) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^(y|yes)$/i.test(answer.trim()));
    });
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  const root = projectRootOrCwd();
  const skillsDir = process.env.WORKFLOW_SKILLS_DIR
    ? path.resolve(process.env.WORKFLOW_SKILLS_DIR)
    : path.join(root, 'src', 'skills');
  const { file: pipelineFile, agents } = loadAgents(opts.pipeline, root);
  const agent = agents[opts.judge];
  if (!agent) throw new Error(`Judge agent '${opts.judge}' not found in ${pipelineFile}`);
  if ((agent.kind ?? 'cli') !== 'cli') {
    throw new Error(`Judge agent '${opts.judge}' must be an agent with a command (kind: cli), got kind: ${agent.kind}`);
  }

  const found = collectRecords(skillsDir, opts.skill);
  const valid = found.filter((r) => r.record && !r.record.error && Number.isInteger(r.record.score) && r.record.input);
  const skippedRecords = found.length - valid.length;
  // Балл записи, который дал сам --judge, сравнивать не с чем: судья совпал бы
  // сам с собой. Когда записи сделаны судьёй с переоценкой, перемер делает его
  // `escalate_to`: сравниваются оценки судьи, не ушедшие на переоценку.
  const usable = valid.filter((r) => scorerOf(r.record) !== opts.judge);
  const selfScored = valid.length - usable.length;
  console.log(`[compare-judges] ${pipelineFile}; записей судьи: ${found.length}, к переоценке: ${usable.length}, с ошибкой: ${skippedRecords}, балл дал сам ${opts.judge}: ${selfScored}`);

  const price = typeof agent.cost_per_call === 'number' ? agent.cost_per_call : DEFAULT_JUDGE_CALL_COST;
  console.log(`[compare-judges] Estimated judge calls: ${usable.length} × $${price.toFixed(4)} = ~$${(usable.length * price).toFixed(2)}`);
  if (usable.length > 0 && !opts.yes && !(await confirm('Continue? [y/N] '))) {
    console.log('[compare-judges] Aborted by user');
    return 0;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-compare-judges-'));
  const state = createJudgeRunState();
  let rows;
  try {
    rows = await mapLimit(usable, opts.concurrency, async (entry) => {
      const candidate = await runJudge(opts.judge, entry.record.input, {
        agents,
        timeoutS: JUDGE_TIMEOUT_S,
        stageId: `compare-${entry.caseId}-${entry.agent}-trial-${entry.trial}`,
        env: { WORKFLOW_SANDBOX_ROOT: sandbox },
        state,
        noEscalation: true,
        log: (line) => console.log(line),
      });
      return { ...entry, baseline: entry.record.score, candidate };
    });
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  const failedRows = rows.filter((row) => row.candidate.error || !Number.isInteger(row.candidate.score));
  for (const row of failedRows) {
    console.log(`[compare-judges] переоценка не удалась: ${row.file} — ${row.candidate.error}`);
  }
  const compared = rows.filter((row) => !failedRows.includes(row));
  const summary = summarize(compared);
  const report = formatReport({
    judge: opts.judge,
    found: found.length,
    skippedRecords,
    selfScored,
    failed: failedRows.length,
    summary,
    baselineJudges: [...new Set(usable.map((r) => scoredBy(r.record)))].sort(),
    skill: opts.skill,
  });
  console.log(report);

  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, report, 'utf8');
    console.log(`[compare-judges] отчёт: ${opts.out}`);
  }
  if (opts.disagreements) {
    fs.mkdirSync(opts.disagreements, { recursive: true });
    for (const row of summary.disagreements) {
      const name = `${row.skill}__${row.caseId}__${row.agent}__trial-${row.trial}.md`;
      fs.writeFileSync(path.join(opts.disagreements, name), disagreementFile(row), 'utf8');
    }
    console.log(`[compare-judges] расхождений: ${summary.disagreements.length} → ${opts.disagreements}`);
  }
  // Записи были, а сравнить не удалось ни одну — это не замер (нет ключа, все
  // записи с ошибкой судьи или с баллом самого --judge).
  if (found.length > 0 && compared.length === 0) {
    console.error(`[compare-judges] ни одна из ${found.length} записей не сравнена с судьёй ${opts.judge}`);
    return 1;
  }
  return 0;
}

// Без проверки «запущен ли файл напрямую»: в проектах каталог скриптов —
// junction (.workflow/src/scripts), и argv[1] не совпадает с import.meta.url,
// разрешённым в настоящий путь. Модуль ничего не экспортирует.
main().then((code) => process.exit(code), (err) => {
  console.error(`[compare-judges] ${err.message}`);
  console.error(usage());
  process.exit(1);
});
