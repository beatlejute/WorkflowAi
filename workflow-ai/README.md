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

## История работы

Каждый тикет содержит таблицу `## История работы`, которая отслеживает все попытки выполнения агентами. Таблица используется для аудита, анализа паттернов переиспользования и отладки.

### Формат таблицы История работы

```markdown
## История работы

| Дата/время | Скил | Агент | Статус |
|------------|------|-------|--------|
| 2026-05-02 16:34:12 | execute-task | openrouter-free | ok |
| 2026-05-02 16:45:33 | execute-task | openrouter-free | timeout |
| 2026-05-02 17:00:45 | execute-task | claude-sonnet | ok |
```

**Колонки:**
- **Дата/время** — ISO timestamp выполнения (YYYY-MM-DD HH:MM:SS)
- **Скил** — имя скила, который выполнял задачу (execute-task, review-result, etc.)
- **Агент** — идентификатор агента (модель ИИ или сервис: openrouter-free, claude-sonnet, local-llama, etc.)
- **Статус** — результат выполнения (см. раздел ниже)

### 10 enum-статусов выполнения

| Статус | Описание |
|--------|----------|
| `ok` | Успешное выполнение: exit code 0, результат парсится, проверка passed |
| `error` | Ошибка выполнения: exit code ≠ 0, не попадает в специфичные категории |
| `timeout` | Истекло время ожидания (execution timeout) |
| `empty_response` | Exit code 0, но результат пуст или не парсится (missing `---RESULT---` block) |
| `rate_limit` | Лимит API (429 HTTP, rate limiting, quota exceeded) |
| `network_error` | Сетевая ошибка (ECONNREFUSED, ENETUNREACH, ETIMEDOUT, getaddrinfo fail) |
| `auth_error` | Ошибка аутентификации (401/403 HTTP, invalid API key, permission denied) |
| `aborted` | Процесс прерван сигналом (SIGTERM/SIGKILL, exit code 130/137/143) |
| `blocked` | Агент отметил result status как `blocked` (нехватает ресурсов, заблокирован другой тикет) |
| `skipped_relevance` | Агент отметил result status как `irrelevant` (задача не применима контекстом) |

### Агрегация по статусам в review-metrics.json

Все попытки выполнения агентами записываются в метрики проекта (`.workflow/metrics/review-metrics.json`) в структуру `agent_history`:

```json
{
  "agent_history": {
    "total_attempts": 245,
    "tickets_with_history_count": 239,
    "by_status": {
      "ok": 150,
      "error": 45,
      "timeout": 18,
      "rate_limit": 12,
      "blocked": 10,
      "network_error": 8,
      "auth_error": 2,
      "empty_response": 0,
      "aborted": 0,
      "skipped_relevance": 0
    },
    "by_agent": {
      "openrouter-free": {
        "ok": 85,
        "error": 20,
        "timeout": 8
      },
      "claude-sonnet": {
        "ok": 65,
        "error": 25,
        "timeout": 10
      }
    },
    "by_skill": {
      "execute-task": {
        "ok": 120,
        "error": 35,
        "timeout": 15
      },
      "review-result": {
        "ok": 30,
        "error": 10,
        "timeout": 3
      }
    },
    "by_skill_by_agent": {
      "execute-task": {
        "openrouter-free": {
          "ok": 70,
          "error": 12
        },
        "claude-sonnet": {
          "ok": 50,
          "error": 23
        }
      }
    },
    "fallback_stats": {
      "tickets_with_fallback": 28,
      "fallback_attempts_total": 45,
      "ok_attempts_with_prior_failure": 22
    },
    "last_updated": "2026-05-02T17:45:30.123Z"
  }
}
```

**Структура:**
- **`total_attempts`** — общее число попыток выполнения (сумма по всем статусам)
- **`tickets_with_history_count`** — число уникальных тикетов с историей выполнения
- **`by_status`** — агрегация по статусам (какой статус встретился сколько раз)
- **`by_agent`** — агрегация по агентам (какой агент сколько раз выполнил с каким статусом)
- **`by_skill`** — агрегация по скилам (какой скил сколько раз выполнен с каким статусом)
- **`by_skill_by_agent`** — двухуровневая агрегация (скил → агент → статусы)
- **`fallback_stats`** — статистика повторов и fallback-механизмов:
  - `tickets_with_fallback` — число тикетов, переданных на повтор
  - `fallback_attempts_total` — общее число повторных попыток
  - `ok_attempts_with_prior_failure` — число успешных попыток после предыдущего отказа
- **`last_updated`** — время последнего обновления метрик (ISO 8601)

### Практическое применение

**Отладка:** Анализируя историю работы тикета, можно понять, почему задача выполнялась несколько раз (timeout → retry → ok), какой агент справился успешно, какие ошибки происходили.

**Качество:** По `by_status` можно видеть percentage успешных выполнений для каждого скила и каждого агента. Высокий процент `empty_response` для скила X указывает на проблему в скилу.

**Оптимизация:** `fallback_stats` показывает сколько было повторов и сколько из них завершилось успешно — это помогает оценить эффективность retry-логики и timeout-значений.
