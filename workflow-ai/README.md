# workflow-ai

AI Agent Workflow Coordinator — kanban-based pipeline for AI coding agents.

## Pipeline Singleton Semantics

The workflow system enforces a singleton pattern for pipeline execution: only one active pipeline instance is allowed per project at any given time.

### Singleton Semantics

When attempting to start a second pipeline while one is already running, the system will refuse with error `PIPELINE_ALREADY_RUNNING`.

### `.workflow/logs/.pipeline.lock` Structure

The lock file contains the following fields:

- `pid`: Process ID of the running pipeline
- `started_at`: Timestamp when the pipeline was started
- `started_by`: Entity that started the pipeline (`cli` | `mcp` | `extension`)
- `run_id`: Unique identifier for this pipeline run
- `pipeline_log`: Path to the pipeline log file
- `project_root`: Root directory of the project
- `pipeline_version`: Version of the pipeline being executed

### Commands

- `workflow run --project <path> [--started-by cli|mcp|extension] [--force]` — Start a pipeline for the specified project
- `workflow stop --project <path> [--grace-sec N]` — Gracefully stop the pipeline (SIGTERM → SIGKILL after N seconds)
- `--force` flag — Escape hatch that ignores the live lock marker (only for debugging when a process is stuck)

### Recovery

If the lock marker becomes stale (process died but lock wasn't cleaned up):

1. Verify the process is dead: `workflow stop --project <path>` (automatically detects stale locks)
2. If standard stop doesn't resolve the issue: `workflow run --force --project <path>`
