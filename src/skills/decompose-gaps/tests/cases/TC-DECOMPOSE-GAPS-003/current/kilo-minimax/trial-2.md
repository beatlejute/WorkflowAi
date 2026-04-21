Now I have all the information needed. Let me apply scope checks and create tickets:

**Scope Check:**

1. **Gap 1: «задача DoD-пункт 3 из плана не реализована — добавить валидацию payload»**
   - Source: From report analysis (valid - failed/skipped task with DoD not met)
   - Belongs to PLAN-042 (DoD item 3 was in the original plan)
   - Status: Plan assumed in_progress
   - Not workflow management instruction
   - **IN SCOPE** ✅ → create IMPL ticket

2. **Gap 2: «в проекте отсутствует общий логгер ошибок»**
   - Explicitly described as "system gap" / "гипотетический системный gap"
   - Not from original PLAN-042 - no corresponding task in the plan
   - **OUT OF SCOPE** → record in "Новые требования"
---RESULT---
status: default
created_tickets: IMPL-001

### Новые требования (вне scope плана)
- «в проекте отсутствует общий логгер ошибок» — причина: Gap не соответствует ни одной задаче из исходного плана PLAN-042. Это системное требование, не связанное с конкретным DoD-пунктом плана, поэтому gap отклонён как out-of-scope и записан в новые требования для ручного разбора.
---RESULT---

Создан 1 тикет:
- `.workflow/tickets/backlog/IMPL-001.md` — доработка DoD-пункта 3 (валидация payload), привязан к `parent_plan: plans/current/PLAN-042.md`

Gap «отсутствие общего логгера ошибок» — отклонён как вне scope: не привязан ни к какой задаче плана PLAN-042, относится к инфраструктуре проекта в целом.
