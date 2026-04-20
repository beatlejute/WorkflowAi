Let me look for the ticket template and also check the structure of an example ticket:
Based on the test scenario TC-DECOMPOSE-PLAN-003, the plan contains a task with DoD criterion: "Кнопка визуально соответствует макету Figma". I'll create the expected tickets following the workflow.

**Проверка атомарности для тикета-кандидата "Реализовать стили кнопки согласно макету Figma":**

| Проверка | Результат | Evidence |
|----------|-----------|----------|
| 1. Одна задача | PASS | Title: одна задача — реализовать стили кнопки |
| 2. Один объект | PASS | Один модуль — стили кнопки |
| 3. Один результат | PASS | DoD проверяет одно: визуальное соответствие макету |
| 4. Нет скрытых подзадач | PASS | Один шаг реализации |
| 5. Размер | PASS | ≤ 2 часа |
| 6. Независимая верификация | PASS | Парный HUMAN-тикет создан |

**Проверка дедупликации:**
- Архив пуст, тикетов с аналогичным scope нет → CREATE
Создано **2 тикета** в `.workflow/tickets/backlog/`:

| Тикет | Тип | Исполнитель | Зависимости | DoD (дословно из плана) |
|-------|-----|-------------|-------------|------------------------|
| IMPL-1 | impl | agent | — | Кнопка **визуально соответствует макету Figma** |
| HUMAN-1 | human | human | IMPL-1 | Кнопка **визуально соответствует макету Figma** |

**Цепочка:** IMPL-1 → HUMAN-1

---RESULT---
status: default
ids_allocated_from:
  IMPL: 1
  HUMAN: 1
---RESULT---
