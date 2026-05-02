## [1.5.0] — 2026-05-02

### Added
- **Audit log агентов в тикетах**: каждая попытка агента (включая fallback) пишет строку в секцию `## История работы` тикета: `| Дата/время | Скил | Агент | Статус |`. 10 классов статуса (ok, error, timeout, empty_response, rate_limit, network_error, auth_error, aborted, blocked, skipped_relevance) детектируются автоматически.
- **Колонка Агент в `## Ревью`**: миграция 3→4 колонки. Видно кто проставил вердикт.
- **Agent history aggregation в metrics**: ключ `agent_history` в `metrics/review-metrics.json` с разрезами by_status/by_agent/by_skill/by_skill_by_agent + fallback_stats. Incremental update от runner.
- New helpers: `lib/agent-history.mjs`, `lib/review-section.mjs`, `lib/metrics-incremental.mjs`.

### Changed
- `getLastReviewStatus` parsing теперь header-based (whitelist: Статус/Status/Вердикт/Verdict). Поддержка legacy 3-колоночных таблиц через `unknown` placeholder в Agent при first append.
- `verify-artifacts.js`, `move-ticket.js` fallback, `check-relevance.js` теперь пишут review через `appendReviewEntry` helper.

## [1.3.0] — 2026-04-30

### Добавлено
- **Новый тип стейджа: `mark-blocked` и расширение frontmatter** — Добавлены поля `auto_blocked_reason`, `auto_blocked_attempts`, `auto_blocked_at` для автоматического отслеживания причин и попыток блокировки тикетов. Стейдж `mark-blocked` позволяет устанавливать эти поля в зависимости от условий бизнес-логики.
- **Новый тип стейджа: `manual-gate-human`** — Добавлен статус `human_ready` в `pick-next-task.js`. При достижении этого статуса задача ожидает ручного решения оператора перед продолжением выполнения.
- **Хук одобрения в `move-ticket.js`** — Добавлен approval-hook, проверяющий наличие ожидающих решения одобрений перед перемещением тикета в терминальные состояния.
- **Расширение START-лога полем `ticket="X"`** — Добавлено поле с идентификатором тикета в стартовый лог для улучшенной трассировки и связывания логов с конкретными задачами.
- **Исправление `approval-pending.mjs` (поле `created_at`)** — Исправлено некорректное заполнение поля `created_at` при создании файлов ожидающих решения.

> **Примечание:** версия 1.2.0 не была опубликована в npm. При выполнении `npm publish`
> сработал prepublishOnly/postversion скрипт, автоматически поднявший версию до 1.2.1.
> Git-тег `v1.2.0` (коммит 179d52b) соответствует состоянию до publish; `v1.2.1` (коммит 83d1b70) —
> фактически опубликованной версии.

### New Features
- **New built-in stage type: `manual-gate`** — Adds support for manual approval steps in pipelines. When a stage with `type: manual-gate` is encountered, the runner creates a pending approval file in `.workflow/approvals/{step_id}.json` and enters a polling loop, waiting for an external decision (`approved`/`rejected`).

  **Key capabilities:**
  - Deterministic `step_id` generation: `{ticket_id}_{stageId}_{attempt}` (e.g., `QA-12_manual-approve_0`)
  - Idempotent file creation — pending file is not overwritten on retry/restart
  - Configurable polling interval (`poll_interval_ms`, default 2000ms) and optional timeout (`timeout_seconds`)
  - Graceful handling of SIGTERM/runner stop (returns `aborted`)
  - Immediate return if file already has `approved`/`rejected` status (crash recovery)
  - JSON approval file format with full audit trail (`created_at`, `updated_at`, `decided_by`, `comment`, `context_snapshot`)

  **Pipeline configuration example:**
  ```yaml
  stages:
    manual-approve-deploy:
      type: manual-gate
      poll_interval_ms: 2000
      timeout_seconds: 86400
      goto:
        approved: continue-deploy
        rejected: rollback
        timeout: notify-stuck
        aborted: end
  ```

  **Two approval methods (both opt-in):**
  1. **External MCP/client**: tools like `workflow-mcp` can write to approval files programmatically
  2. **Direct file edit**: users can simply edit `.workflow/approvals/{step_id}.json` and change `status` to `approved` or `rejected`

  **Important:** `manual-gate` is **opt-in** — pipelines without such stages work identically to previous versions. No breaking changes.

### Changed
- No breaking changes. All existing pipelines without `manual-gate` stages are fully backward compatible.

### Fixes
- Исправлено сохранение временной метки `created_at` в файлах одобрений (approval-pending.mjs)

### Technical Notes
- Approval files are stored in `<project_root>/.workflow/approvals/`
- Runner validates `manual-gate` stages on startup — requires `goto.approved` and `goto.rejected`, validates numeric parameters
- New methods added to `PipelineRunner`: `computeStepId()`, `writeApprovalPending()`, `readApprovalFile()`, `executeManualGate()`

### References
- PLAN-009: workflow-ai 1.2 — manual-gate stage and approval files for workflow-mcp Sprint 2 integration
- IMPL-55, IMPL-56, IMPL-57, IMPL-58: Implementation tickets
- QA-35, QA-36, QA-37: Test coverage
- IMPL-51, QA-55 in workflow-mcp: Dependent consumer work
