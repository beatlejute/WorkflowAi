# workflow-ai

AI Agent Workflow Coordinator — kanban-based pipeline for AI coding agents.

Система координации AI-агентов через файловую канбан-доску. Автоматически оркестрирует выполнение задач: берёт тикеты из очереди, запускает нужного агента, проверяет результат и генерирует отчёты.

## Install

```bash
npm install -g workflow-ai
```

## Quick Start

```bash
# Initialize workflow in your project
workflow init

# Run the workflow pipeline
workflow run
```

## Commands

| Command | Description |
|---------|-------------|
| `workflow init [path] [--force]` | Initialize `.workflow/` directory with kanban board structure |
| `workflow run [options]` | Execute the AI pipeline |
| `workflow update [path]` | Update global dir and recreate junctions/hardlinks |
| `workflow eject <skill> [path]` | Eject a skill (copy from global to project) |
| `workflow list [path]` | List skills with status (shared/ejected/project-only) |
| `workflow help` | Show help |
| `workflow version` | Show version |

### Run Options

| Option | Description |
|--------|-------------|
| `--plan <plan>` | Plan ID to execute |
| `--config <path>` | Config file path |
| `--project <path>` | Project root (default: auto-detect) |

## Init

The `workflow init` command creates the `.workflow/` directory structure:

```
.workflow/
├── config/
│   ├── config.yaml               # Workflow configuration
│   ├── pipeline.yaml             # Pipeline stages and agents
│   └── ticket-movement-rules.yaml
├── plans/
│   ├── current/                  # Current development plans
│   ├── templates/                # Plan templates with triggers (recurring plans)
│   └── archive/                  # Archived plans
├── tickets/
│   ├── backlog/                  # Awaiting conditions
│   ├── ready/                    # Ready to execute
│   ├── in-progress/              # Currently active
│   ├── blocked/                  # Blocked by dependencies
│   ├── review/                   # Awaiting review
│   └── done/                     # Completed
├── reports/                      # Generated reports
├── logs/                         # Pipeline execution logs
├── metrics/                      # Performance metrics
├── templates/                    # Ticket/plan/report templates
└── src/
    ├── skills/                   # Skill instructions (symlinks to global)
    └── scripts/                  # Automation scripts (hardlinks to global)
```

## Pipeline

The `workflow run` command executes a multi-stage pipeline:

1. **pick-first-task** — select ticket from ready queue
2. **check-plan-templates** — evaluate plan template triggers, create plans if fired
3. **check-plan-decomposition** — verify plan is decomposed into tickets
4. **decompose-plan** — break down plan into tickets (if needed)
5. **check-conditions** — validate ticket readiness conditions
6. **move-to-ready** — move tickets from backlog to ready
7. **pick-next-task** — select next ticket for execution
8. **move-to-in-progress** — start execution
9. **check-relevance** — verify ticket is still relevant
10. **execute-task** — perform the work via AI agent
11. **move-to-review** — submit for review
12. **review-result** — validate results against Definition of Done
13. **increment-task-attempts** — track retry attempts
14. **move-ticket** — move to done/blocked based on review
15. **create-report** — generate execution report
16. **analyze-report / decompose-gaps** — analyze results and iterate

### Supported Agents

| Agent | Description |
|-------|-------------|
| `claude-sonnet` | Claude Sonnet — fast model for simple tasks |
| `claude-opus` | Claude Opus — powerful model for complex tasks |
| `qwen-code` | Qwen Code — alternative agent |
| `kilo-code` | Kilo Code — multi-mode agent |

Agents are configured in `configs/pipeline.yaml`.

## Skills

Built-in skills for different task types:

| Skill | Description |
|-------|-------------|
| `analyze-report` | Report analysis |
| `check-relevance` | Ticket relevance verification |
| `coach` | Skill management and improvement |
| `create-plan` | Plan creation |
| `create-report` | Report generation |
| `decompose-gaps` | Gap decomposition |
| `decompose-plan` | Plan decomposition into tickets |
| `deep-research` | Deep research |
| `execute-task` | Task execution |
| `review-result` | Result review against DoD |

Skills are stored globally in `~/.workflow/skills/` and symlinked into projects.

Use `workflow eject <skill>` to copy a skill into the project for customization.

## Plan Templates

Plan templates allow recurring plans to be created automatically. Templates live in `.workflow/plans/templates/` and contain trigger conditions in their frontmatter.

### Template Format

```yaml
id: "TMPL-001"
title: "Daily manual testing"
type: template
trigger:
  type: daily          # daily | weekly | date_after | interval_days
  params: {}           # type-specific params
last_triggered: ""     # auto-updated on trigger
enabled: true
```

### Trigger Types

| Type | Params | Description |
|------|--------|-------------|
| `daily` | — | Once per day |
| `weekly` | `days_of_week: [1,3,5]` (0=Sun) | On specific weekdays |
| `date_after` | `date: "2026-04-01"` | Once after a specific date |
| `interval_days` | `days: 3` | Every N days |

When a trigger fires, the pipeline creates a plan in `plans/current/` with status `approved`, then the normal decomposition flow proceeds.

## Task Types

| Type | Prefix | Description |
|------|--------|-------------|
| `arch` | ARCH | Architecture & planning |
| `impl` | IMPL | Code implementation |
| `fix` | FIX | Bug fixes |
| `review` | REVIEW | Code/documentation review |
| `docs` | DOCS | Documentation |
| `admin` | ADMIN | Administrative tasks |

## Configuration

### `configs/config.yaml`

Main workflow configuration: project info, task types, priorities, statuses, condition types, paths, reporting settings.

### `configs/pipeline.yaml`

Pipeline definition: agents, stages, flow control, goto-logic, retry strategies.

### `configs/ticket-movement-rules.yaml`

Rules for automated ticket movement based on review status.

## Project Structure

```
workflow-ai/
├── bin/                    # CLI entry point
├── src/
│   ├── cli.mjs             # Command parsing
│   ├── runner.mjs           # Core pipeline orchestrator
│   ├── init.mjs             # Project initialization
│   ├── global-dir.mjs       # Global ~/.workflow/ management
│   ├── junction-manager.mjs # Symlink/hardlink management
│   ├── wf-loader.mjs        # Config loader
│   ├── lib/                 # Utility libraries
│   └── tests/               # Test suite
├── configs/                # Configuration files (source)
├── templates/              # Workflow templates (source)
├── agent-templates/        # AI agent instruction templates
└── package.json
```

## Requirements

- Node.js >= 18.0.0
- npm

## License

MIT
