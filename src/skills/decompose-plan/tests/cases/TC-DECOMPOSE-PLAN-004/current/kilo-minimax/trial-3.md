I'll decompose the plan into tickets. Let me first explore the workspace and load required knowledge files.
Plan given in Instructions — not a file. Creating tickets based on DoD items.

**Анализ задачи:**

| DoD | Объект | Префикс | Зависимость |
|-----|--------|---------|-------------|
| Функция buildTargetPrompt() реализована | Код runner'а | IMPL | — |
| Юнит-тест TC-PROMPT-001 | Тест | QA | От IMPL |
| README обновлён | Документация | DOCS | От IMPL |
| Коммит feat(runner) | Git-операция | — | Стейкхолдер (не тикет) |

**Проверка атомарности для IMPL-001:**
- 1 задача: «Реализовать buildTargetPrompt()» — PASS
- 1 объект: `src/scripts/run-skill-tests.js` — PASS
- 1 результат: DoD содержит 1 пункт — PASS
- Скрытых подзадач нет: 1 функция = 1 задача — PASS
- Размер: реализация 1 функции ≤ 2 часов — PASS
- Независимая верификация: можно протестировать отдельно — PASS
- Один исполнитель: IMPL-префикс, код — PASS

**Проверка атомарности для QA-001:**
- 1 задача: «Написать TC-PROMPT-001» — PASS
- 1 объект: тестовый файл — PASS
- 1 результат: 1 тест — PASS
- Зависимость от IMPL-001 эксплицитна через conditions — PASS

**Проверка атомарности для DOCS-001:**
- 1 задача: «Обновить README» — PASS
- 1 объект: README — PASS
- 1 результат: 1 раздел — PASS

**Scope-guard:** Все задачи из DoD плана, в scope.

**Дедупликация:** backlog пуст, тикетов нет.

Создаю тикеты:
---RESULT---
status: default
ids_allocated_from:
  IMPL: 1
  QA: 1
  DOCS: 1

tickets_created:
  - id: IMPL-001
    title: "Реализовать функцию buildTargetPrompt() в runner'е"
    prefix: IMPL
    status: backlog
    priority: 2
    executor_type: agent
    dependencies: []
    conditions: []
    scope_guard: PASS (задача входит в план, связана с критериями успеха)

  - id: QA-001
    title: "Написать юнит-тест TC-PROMPT-001 для buildTargetPrompt()"
    prefix: QA
    status: backlog
    priority: 2
    executor_type: agent
    dependencies: [IMPL-001]
    conditions:
      - type: tasks_completed
        tasks: [IMPL-001]
    scope_guard: PASS

  - id: DOCS-001
    title: "Обновить README разделом про prompt assembly"
    prefix: DOCS
    status: backlog
    priority: 3
    executor_type: agent
    dependencies: [IMPL-001]
    conditions:
      - type: tasks_completed
        tasks: [IMPL-001]
    scope_guard: PASS

notes:
  - "Git-коммит создан stakeholder'ом (не агент), поэтому тикет не создаётся"
  - "DoD 'Функция реализована' покрывается IMPL-001; QA-001 зависит от него"
  - "Декомпозиция полная — все 3 компонента DoD получили тикеты"---RESULT---
