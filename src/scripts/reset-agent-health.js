#!/usr/bin/env node

import { loadHealth, markHealthy, unhealthy } from '../lib/agent-health-registry.mjs';

const projectRoot = process.cwd();

function getState() {
  return loadHealth(projectRoot);
}

function showState() {
  const state = getState();
  console.log('---RESULT---');
  console.log(JSON.stringify(state, null, 2));
  console.log('---RESULT---');
}

function resetAgent(agentId) {
  const state = getState();
  const agent = state.agents[agentId];
  
  if (!agent) {
    console.log(`Agent "${agentId}" not found in health registry`);
    return;
  }
  
  markHealthy(projectRoot, agentId);
  console.log(`Reset health status for agent "${agentId}"`);
}

function resetAll() {
  const unhealthyAgents = unhealthy(projectRoot);
  
  if (unhealthyAgents.length === 0) {
    console.log('No unhealthy agents to reset');
    return;
  }
  
  const resetList = unhealthyAgents.map(a => a.agentId);
  
  for (const agentId of resetList) {
    markHealthy(projectRoot, agentId);
  }
  
  console.log(`Reset ${resetList.length} agent(s): ${resetList.join(', ')}`);
}

const args = process.argv.slice(2);

if (args.length === 0) {
  showState();
} else if (args[0] === '--agent' && args[1]) {
  resetAgent(args[1]);
} else if (args[0] === '--all') {
  resetAll();
} else {
  console.log('Usage:');
  console.log('  node reset-agent-health.js              # Show current state');
  console.log('  node reset-agent-health.js --agent <id> # Reset single agent');
  console.log('  node reset-agent-health.js --all   # Reset all unhealthy');
  process.exit(1);
}