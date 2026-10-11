import fs from 'node:fs';
import path from 'node:path';
import { normalizePlanId, parseFrontmatter, readBoardTickets } from './utils.mjs';

// Inputs come from the runner's project, never from the agent's search results.
export function prepareReportInput(projectRoot, context, stage = context.report_id ? 'analyze-report' : 'create-report') {
  const analyzing = stage === 'analyze-report';
  if (analyzing && !context.report_id) throw new Error('Analysis requires report_id');
  if (!projectRoot || !path.isAbsolute(projectRoot)) throw new Error('Report project root must be absolute');
  const workflow = path.join(projectRoot, '.workflow');
  const tickets = readBoardTickets(path.join(workflow, 'tickets'));
  const plansDir = path.join(workflow, 'plans', 'current');
  const plans = fs.readdirSync(plansDir).filter(f => f.endsWith('.md') && !f.startsWith('.')).map(file => {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(plansDir, file), 'utf8'));
    const id = normalizePlanId(file);
    if (!id || !frontmatter.status) throw new Error(`Invalid plan: ${file}`);
    return { id, status: frontmatter.status };
  });
  let planId = context.plan_id ? normalizePlanId(context.plan_id) : null;
  if (context.plan_id && !planId) throw new Error('Invalid report plan_id');
  if (analyzing) {
    if (!/^REPORT-\d+$/.test(context.report_id)) throw new Error('Invalid report_id');
    const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(workflow, 'reports', `${context.report_id}.md`), 'utf8'));
    const related = frontmatter.related_plan ? normalizePlanId(frontmatter.related_plan) : null;
    if (frontmatter.related_plan && !related) throw new Error('Invalid report related_plan');
    if (planId && !related) throw new Error('Requested plan requires report binding');
    if (planId && related !== planId) throw new Error('Report plan conflicts with selected plan');
    planId = related;
  }
  const active = plans.filter(p => p.status === 'active');
  if (!analyzing && !planId && active.length === 1) planId = active[0].id;
  if (planId && !plans.some(p => p.id === planId)) throw new Error(`Report plan not found: ${planId}`);
  const selected = planId ? tickets.filter(t => normalizePlanId(t.frontmatter.parent_plan) === planId) : tickets;
  const counts = {};
  for (const t of selected) counts[t.dir] = (counts[t.dir] || 0) + 1;
  return {
    ...context, project_root: projectRoot, report_scope: planId ? 'plan' : 'board',
    plan_id: planId || '', board_scan_ok: true,
    board_counts: JSON.stringify(counts), board_total: selected.length,
    open_tickets: selected.filter(t => !['done', 'archive'].includes(t.dir)).map(t => `${t.id} (${t.dir}${t.frontmatter.blocked_reason ? ': ' + String(t.frontmatter.blocked_reason).split(/\r?\n/)[0] : ''})`).join('; '),
  };
}
