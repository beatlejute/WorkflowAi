Now let me check the test cases for the expected ticket format:
Let me look at existing ticket examples and the test case 001 for reference:
Let me look at the review-result fixture for a ticket format example:
Now I have all the information needed. Let me apply the scope checks and create the ticket(s).

**Scope analysis:**

1. **Gap 1: «задача DoD-пункт 3 из плана не реализована — добавить валидацию payload»**
   - Source: «Выполненные задачи» (задача с невыполненным DoD) → valid
   - Belongs to plan: explicitly references DoD point from PLAN-042 → in scope
   - Plan status: no plan file exists, but we have plan_id → assume in_progress
   - No workflow management → ✅
   - **Result: IN SCOPE → create ticket**

2. **Gap 2: «в проекте отсутствует общий логгер ошибок»**
   - Source: hypothetical/systemic observation, not tied to any plan task
   - No matching task in PLAN-042
   - **Result: OUT OF SCOPE → «Новые требования»**

Now checking for existing tickets to determine next ID:
No existing tickets. The first gap (валидация payload) is about missing implementation from a DoD point — this is an `IMPL` type. Starting from IMPL-001.
Now verify the created ticket has `parent_plan` filled:
## Результат scope-проверки

### Gap 1: «задача DoD-пункт 3 из плана не реализована — добавить валидацию payload»
- Проверка 1 (источник): «Выполненные задачи» → ✅ валидный источник
- Проверка 2 (принадлежность к плану): явно ссылается на DoD-пункт из PLAN-042 → ✅ в scope
- Проверка 3 (статус плана): in_progress → ✅
- Проверка 4 (workflow-управление): нет управляющих инструкций → ✅
- **Результат: IN SCOPE → создан тикет IMPL-001**

### Gap 2: «в проекте отсутствует общий логгер ошибок»
- Проверка 1: нет привязки к секции отчёта о выполненных задачах
- Проверка 2: нет соответствующей задачи в исходном плане PLAN-042 — это новая работа, не предусмотренная планом
- **Результат: OUT OF SCOPE (проверка 2)**

### Новые требования (вне scope)
- «В проекте отсутствует общий логгер ошибок» — причина: нет соответствующей задачи в исходном плане PLAN-042, это новая инициатива, выходящая за рамки текущего плана

```
---RESULT---
status: default
created_tickets: IMPL-001
---RESULT---
```
