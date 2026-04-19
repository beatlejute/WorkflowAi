Тест пройден. Relevant case TC-DECOMPOSE-PLAN-004: **passed**.

**Verdict: `no_baseline_failures`** (режим no-baseline — история отсутствует, это первый прогон). Все 4 статических assertion прошли.

---

## Итог анализа пайплайна PLAN-003

### Findings

| # | Приоритет | Проблема | Статус |
|---|-----------|---------|--------|
| 1 | CRITICAL | ID-коллизия IMPL-002/IMPL-003: заархивированы из PLAN-002, пересозданы для PLAN-003 | ✅ Fix в пайплайне (`allocate-ticket-ids`) |
| 2 | CRITICAL | STOP-GATE 9.B нарушен: декомпозитор назначил ID «из головы» при отсутствии `id_ranges_json` | ✅ STOP-GATE уже добавлен в `decompose.md` |
| 3 | HIGH | `ids_allocated_from` отсутствует в RESULT | ✅ Требование зафиксировано в `decompose.md` |
| 4 | MEDIUM | STOP-GATE не определял явный формат вывода ошибки — пайплайн не мог отличить infra-ошибку от нормального завершения | **CHG-2026-04-19-001: добавлен `status: infra_error`** |

### Ключевой паттерн коллизии

```
16:36:02  auto-correction: IMPL-002 (PLAN-002) → archive/
16:36:02  auto-correction: IMPL-003 (PLAN-002) → archive/
          [check-plan-decomposition → decompose-plan БЕЗ allocate-ticket-ids]
16:40:31  decompose-plan создаёт IMPL-002 для PLAN-003 → backlog/
16:40:31  decompose-plan создаёт IMPL-003 для PLAN-003 → backlog/
          ↑ tasks_completed в pick-next-task.js находит старый IMPL-002 в archive/
            и ошибочно считает зависимость QA-001 выполненной
```

### Правка скила (CHG-2026-04-19-001)

**Файл:** `skills/decompose-plan/workflows/decompose.md`, шаг 9.B пункт 3

**Добавлен явный формат вывода при срабатывании STOP-GATE:**
```
---RESULT---
status: infra_error
error: <описание: что отсутствует или некорректно в id_ranges_json>
---RESULT---
```

**Тест:** `TC-DECOMPOSE-PLAN-004` — verdict `no_baseline_failures`, relevant case passed.

### Рекомендуемый тикет (вне scope коуча)

Добавить в `pipeline.yaml` обработчик `infra_error` для стадии `decompose-plan`:
```yaml
decompose-plan:
  goto:
    default: check-atomicity-limit
    infra_error: check-conditions  # ← добавить
```

**Затронутые файлы:**
- `D:/Dev/workflowAi/src/skills/decompose-plan/workflows/decompose.md`
- `D:/Dev/workflowAi/src/skills/decompose-plan/tests/cases/TC-DECOMPOSE-PLAN-004-stopgate-infra-error-format.yaml` (новый)
- `D:/Dev/workflowAi/src/skills/decompose-plan/tests/index.yaml`
- `.workflow/coach-backlog.yaml`
