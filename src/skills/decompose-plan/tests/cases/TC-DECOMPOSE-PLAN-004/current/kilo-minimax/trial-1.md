Now I understand the plan and requirements. Let me analyze and decompose:

**План:**
- Задача: Реализовать функцию buildTargetPrompt() в runner'е
- DoD содержит 4 пункта: реализация (IMPL), тест (QA), документация (DOCS), коммит (стейкхолдер)

**Анализ атомарности:**

| Проверка | Результат | Evidence |
|----------|-----------|----------|
| 1. Одна задача | FAIL | DoD содержит 3 разных действия: реализация функции, написание теста, обновление документа |
| 2. Один объект | FAIL | 3 разных модуля: код, тест, docs |
| 3. Один результат | FAIL | 3 независимых критерия готовности |
| 4. Нет скрытых подзадач | FAIL | Пункты DoD семантически независимы |
| 5. Размер | PASS | ~100-150 строк кода |
| 6. Независимая верификация | PASS | Каждый критерий проверяется отдельно |
| 7. Один исполнитель | FAIL | IMPL, QA, DOCS — разные типы по config.yaml |

**Решение: РАЗБИТЬ на 3 тикета + 1 рекомендация**
Созданы 3 тикета в `.workflow/tickets/backlog/`:

| ID | Тип | Описание | Зависимости |
|----|-----|----------|-------------|
| IMPL-001 | IMPL | Реализовать функцию buildTargetPrompt() | — |
| QA-001 | QA | Написать unit-тест TC-PROMPT-001 | IMPL-001 |
| DOCS-001 | DOCS | Обновить README разделом про prompt assembly | IMPL-001 |

---

### Рекомендации для следующего плана (вне scope)

- **Коммит feat(runner): buildTargetPrompt** — Git-операции (commit, merge, push) в этом проекте выполняет стейкхолдер, не агент-исполнитель

---

---RESULT---
status: default

ids_allocated_from:
  IMPL: 1
  QA: 1
  DOCS: 1

tickets_created:
  - IMPL-001
  - QA-001
  - DOCS-001

out_of_scope:
  - "Коммит feat(runner): buildTargetPrompt создан" — Git-операция выполняется стейкхолдером

---RESULT---
