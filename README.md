# workflow-ai

AI Agent Workflow Coordinator — kanban-based pipeline for AI coding agents.

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
| `workflow init` | Initialize `.workflow/` directory with kanban board structure |
| `workflow run` | Execute the workflow pipeline (process tickets from in-progress to done) |

## Init

The `workflow init` command creates the `.workflow/` directory structure:

```
.workflow/
├── config/
│   └── config.yaml          # Workflow configuration
├── plans/
│   └── current/             # Current development plans
├── tickets/
│   ├── backlog/             # Pending tickets
│   ├── in-progress/         # Active tickets
│   └── done/                # Completed tickets
├── reports/                  # Generated reports
└── logs/                     # Pipeline execution logs
```

## Run

The `workflow run` command executes the pipeline:

1. Reads tickets from `in-progress/`
2. Executes each task based on its type (IMPL, FIX, DOCS, REVIEW, etc.)
3. Moves completed tickets to `done/`
4. Generates reports in `reports/`

## Configuration

### `.workflow/config/config.yaml`

Main workflow configuration:

```yaml
# Workflow settings
id_counter: 1
settings:
  auto_move_tickets: true
  generate_reports: true
```

## Requirements

- Node.js >= 18.0.0
- npm

## License

MIT
