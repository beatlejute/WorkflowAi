Тест прошёл. Финальный вывод:

---

## Результат анализа

### Временны́е диаграммы — ID с коллизиями

**IMPL-002:**
| 16:36:02 | done → archive (PLAN-002 archived) | pick-next-task auto-correction |
| 16:40:31 | **CREATED NEW** для PLAN-003 | decompose-plan |
→ **Коллизия**: два разных тикета с одним ID в разных планах.

**IMPL-003:**
| 16:36:02 | done → archive (PLAN-002 archived) | pick-next-task auto-correction |
| 16:40:31 | **CREATED NEW** для PLAN-003 | decompose-plan |
→ **Коллизия**.

**Ключевое доказательство из лога:** контекст, переданный в `decompose-plan` на шаге 4, содержал только `plan_id` и `plan_file`. `id_ranges_json` — отсутствует. Стадии `allocate-ticket-ids` в пайплайне на тот момент не было.

---

### Findings

| # | Severity | Описание | Статус |
|---|----------|---------|--------|
| F1 | CRITICAL | Стадия `allocate-ticket-ids` отсутствовала → `decompose-plan` не получил `id_ranges_json` → нумерация с 001 → коллизия с архивными IMPL-002, IMPL-003 | **Уже исправлено** (pipeline.yaml + шаг 9.B decompose.md) |
| F2 | CRITICAL | Агент не остановился при отсутствии `id_ranges_json` (нарушение шаг 9.B) + output без `ids_allocated_from` | **Уже исправлено** (стоп-гейт 9.B, инцидент 2026-04-08/PLAN-008) |
| F3 | HIGH | **TC-DECOMPOSE-PLAN-002 инвертирован:** assertion `output_contains_all:["get-next-id"]` проваливал правильно работающего агента | **ИСПРАВЛЕНО CHG-079** |
| F4 | MEDIUM | `verify-atomicity.js` не проверяет наличие `ids_allocated_from` в выводе декомпозитора — нет машинного гейта | Зафиксировано, инфраструктура |

---

### CHG-079: правка TC-DECOMPOSE-PLAN-002

**Проблема:** тест тестировал старый контракт (агент *должен* вызывать `get-next-id.js`), тогда как с момента введения `allocate-ticket-ids` стадии контракт противоположен (агент *не должен* вызывать скрипт — получает готовые диапазоны через `id_ranges_json`).

**Изменения:**
- Заменён `output_contains_all: ["get-next-id"]` → `output_contains_all: ["ids_allocated_from"]`
- Заменены static assertions: проверяют `id_ranges_json`, `не вызывает.*get-next-id`, `ids_allocated_from`
- Добавлен `output_does_not_contain` на прямой вызов скрипта
- Обновлён сценарий: теперь предоставляет `id_ranges_json` на входе + минимальный план

---

### Verdict теста

```
status: passed
skill: decompose-plan
total: 1
current_run.passed: 1
verdict: no_baseline_failures
```

**Затронутые файлы:**
- `src/skills/decompose-plan/tests/cases/TC-DECOMPOSE-PLAN-002-get-next-id-mandatory.yaml`
- `src/skills/decompose-plan/tests/cases/TC-DECOMPOSE-PLAN-002/current/meta.json`
