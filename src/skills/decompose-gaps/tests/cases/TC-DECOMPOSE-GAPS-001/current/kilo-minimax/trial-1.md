По алгоритму `scope-check.md` (шаг 2a):

**Анализ gap:**
- Gap: «Нужно исправить дефект маппинга полей»
- План содержит секцию: «Исключено из scope: исправление дефектов»

**Результат проверки scope:**
- `in_scope: false`
- `reason: Gap подпадает под исключение из scope плана: 'исправление дефектов'`
- `check_failed: 2a`

Gap **вне scope** — план явно исключает исправление дефектов.

---RESULT---
status: has_gaps
created_tickets: []
rejected_gaps: 1
gaps_out_of_scope:
  - gap: "Нужно исправить дефект маппинга полей"
    reason: "Gap подпадает под исключение из scope плана: 'исправление дефектов'"
    check_failed: "2a"
new_requirements: []
---RESULT---
