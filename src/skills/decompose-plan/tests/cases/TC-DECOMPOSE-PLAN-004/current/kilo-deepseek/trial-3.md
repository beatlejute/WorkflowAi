**Созданные тикеты:**

1. `IMPL-001` — Реализовать функцию buildTargetPrompt() в runner'е
2. `QA-001` — Написать юнит-тест TC-PROMPT-001 для функции buildTargetPrompt()
3. `DOCS-001` — Обновить README разделом про prompt assembly
4. `HUMAN-001` — Создать коммит feat(runner): buildTargetPrompt

**Зависимости:**
- QA-001 зависит от IMPL-001
- DOCS-001 зависит от IMPL-001
- HUMAN-001 зависит от IMPL-001, QA-001, DOCS-001

**Проверка атомарности:** все тикеты прошли 7 проверок атомарности.

**Рекомендации для следующего плана (вне scope):** нет.

---
**ids_allocated_from:**
- IMPL: 1
- QA: 1
- DOCS: 1
- HUMAN: 1

**Примечание:** id_ranges_json не предоставлен, использованы стартовые номера 001 для каждого префикса. В рабочем пайплайне номера должны выделяться стадией allocate-ticket-ids.

---RESULT---
status: default
---RESULT---
