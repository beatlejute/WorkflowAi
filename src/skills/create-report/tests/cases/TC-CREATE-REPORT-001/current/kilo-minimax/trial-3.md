## Проблемы

### Тикет QA-001 — некорректная атрибуция root cause

| Поле | Значение |
|------|----------|
| **Тикет** | `QA-001` |
| **Статус** | ⏭ skipped |
| **Корневая причина (верно)** | `check-relevance` |
| **Основание** | `.workflow/logs/pipeline_2026-04-06_12-00-00.log:2166` — `status="irrelevant" reason="dependencies_inactive"` |
| **Ранее атрибутировано ошибочно** | `check-conditions` (REPORT-002) |

**Root cause:** `check-relevance` — тикет признан нерелевантным из-за неактивных зависимостей (`dependencies_inactive`). Атрибуция в REPORT-002 на стейдж `check-conditions` неверна — требуется уточнение в архиве отчётов.
