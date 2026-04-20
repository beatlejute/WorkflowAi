## Секция «Проблемы» — фрагмент по QA-001

```markdown
### ⏭ Пропущенные тикеты

| Тикет | Статус | Стейдж принятия решения | Причина | Источник |
|-------|--------|------------------------|---------|----------|
| QA-001 | skipped | `check-relevance` | `dependencies_inactive` | pipeline_2026-04-06_12-00-00.log:2166 |

**QA-001** — пропущен на стейдже `check-relevance`.

- **Решение:** `status="irrelevant"`, `reason="dependencies_inactive"`
- **Лог:** `pipeline_2026-04-06_12-00-00.log`, строка 2166
  ```
  [check-relevance] COMPLETE stage="check-relevance" ticket_id="QA-001" status="irrelevant" reason="dependencies_inactive"
  ```
- **Root cause:** зависимости тикета неактивны → стейдж `check-relevance` признал тикет нерелевантным для текущей итерации и выдал skip.
- **Коррекция атрибуции:** в REPORT-002 причина пропуска была ошибочно отнесена к стейджу `check-conditions`. По текущему логу решение принято на стейдже `check-relevance` — до `check-conditions`. Атрибуция исправлена.
```

---

**Пояснение по атрибуции:**

Стейджи в пайплайне выполняются последовательно: `check-relevance` предшествует `check-conditions`. Поскольку `check-relevance` завершил обработку QA-001 со статусом `irrelevant`, до `check-conditions` выполнение не дошло. REPORT-002 содержал ошибку атрибуции — текущий отчёт её исправляет со ссылкой на конкретную строку лога.
