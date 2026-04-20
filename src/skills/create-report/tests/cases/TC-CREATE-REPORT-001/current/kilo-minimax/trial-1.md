## Проблемы

### 4.1. Skipped-тикеты

| Тикет | Стейдж | Root Cause | Примечание |
|-------|--------|------------|------------|
| QA-001 | `check-relevance` | `dependencies_inactive` | Ранее ошибочно атрибутирован стейджу `check-conditions` (REPORT-002) |

**Root Cause для QA-001:**
- **Стейдж:** `check-relevance`
- **Причина:** `dependencies_inactive`
- **Основание:** лог пайплайна, строка 2166: `[check-relevance] COMPLETE stage="check-relevance" ticket_id="QA-001" status="irrelevant" reason="dependencies_inactive"`
