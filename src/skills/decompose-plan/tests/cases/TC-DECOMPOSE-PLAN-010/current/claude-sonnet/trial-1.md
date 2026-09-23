Оба тикета созданы в `.workflow/tickets/backlog/`.

### Рекомендации / эскалации (не тикеты)
- `.workflow/templates/ticket-template.md` в проекте отсутствует. Тикеты собраны по документированной схеме `execute-task/knowledge/ticket-structure.md` и по формату реальных fixture-тикетов репозитория (совпадающие поля/секции) — стейкхолдеру стоит восстановить файл шаблона.
- `.workflow/src/skills/shared/README.md` отсутствует — нет реестра observable-инвариантов. Условия Б/В workflow (парный тикет по файловым триггерам, regression sweep) не применялись из-за пробела shared, а не из-за анализа задачи.
- Зависимость «Задача 6» из плана не перенесена в `dependencies` IMPL-041 — её тикет-ID не входит в переданный фрагмент декомпозиции; связать вручную после декомпозиции Задачи 6.

---RESULT---
status: default
ids_allocated_from:
  IMPL: 41
  QA: 18
tickets_created:
  - IMPL-041
  - QA-018
dod_synthesized_from_plan_level_criteria:
  - ticket: QA-018
    note: "DoD перенесён дословно из общего раздела плана «Критерии успеха» — задача 7 не имела собственного критерия"
---RESULT---
