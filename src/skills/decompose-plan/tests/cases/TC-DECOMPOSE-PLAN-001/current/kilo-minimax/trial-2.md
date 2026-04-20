Based on the knowledge modules and the plan, I'll decompose it into tickets. The plan has 2 tasks that need to be broken down:

**Analysis:**
- Task 1 contains 3 distinct things (fix A, fix B, smoke test) - violates atomicity
- Task 2 (CI config) is independent

**Atomicity checklist results:**

**Ticket candidates for Task 1:**
**Декомпозиция плана завершена.**

Создано 4 тикета в `.workflow/tickets/backlog/`:

| ID | Название | Тип | Исполнитель | Зависимости |
|----|----------|-----|-------------|-------------|
| FIX-001 | Исправить дефект А: неверный маппинг полей | fix | agent | — |
| FIX-002 | Исправить дефект Б: отсутствие валидации | fix | agent | — |
| QA-001 | Провести smoke-тест (6 TC) после исправления дефектов А и Б | qa | human | FIX-001, FIX-002 |
| ADMIN-001 | Обновить конфигурацию CI | admin | agent | — |

**Декомпозиция Task 1 (атомарность):**
Исходная задача содержала 3 независимых предмета работы (fix A, fix B, smoke test) → разбита на 3 тикета. Каждый тикет прошёл 6 проверок атомарности.

**Scope-guard:** Все 4 тикета в scope плана. Дубликаты не обнаружены.

---
**Рекомендации для следующего плана (вне scope)**  
Нет задач вне scope текущего плана.

---RESULT---
status: default
---RESULT---
