## Проблемы

### ⏭ QA-001 — пропущен в итерации

**Статус:** `skipped`
**Root cause:** стейдж `check-relevance` вернул `status="irrelevant"`, `reason="dependencies_inactive"`

**Источник:** `.workflow/logs/pipeline_2026-04-06_12-00-00.log`, строка 2166:
```
[check-relevance] COMPLETE stage="check-relevance" ticket_id="QA-001" status="irrelevant" reason="dependencies_inactive"
```

**Атрибуция:** стейдж `check-relevance` — зависимости тикета неактивны на момент прогона пайплайна.

> ⚠️ **Корректировка:** в REPORT-002 root cause QA-001 ошибочно приписан стейджу `check-conditions`. Текущий лог однозначно указывает на `check-relevance`. Данные REPORT-002 по этому тикету считать недостоверными.

**Рекомендация аналитику:** проверить состояние зависимостей QA-001 перед следующей итерацией.
