Каждый тикет существует в единственном экземпляре. Коллизий нет.

---

### Рекомендации для следующего плана (вне scope)

- Создать `shared/README.md` с реестром observable-инвариантов — причина: отсутствие реестра делает невозможным применение Условий Б и В (парные тикеты ручной проверки по observable-зоне) при декомпозиции будущих планов.

---

```
---RESULT---
status: default
tickets_created:
  - .workflow/tickets/backlog/FIX-1.md
  - .workflow/tickets/backlog/FIX-2.md
  - .workflow/tickets/backlog/QA-1.md
  - .workflow/tickets/backlog/ADMIN-1.md
decomposition_summary:
  plan_tasks: 2
  tickets_created: 4
  breakdown:
    Задача 1 → [FIX-1, FIX-2, QA-1]  (разбита по атомарности: 6/6 FAIL → 3 тикета)
    Задача 2 → [ADMIN-1]              (атомарна: 6/6 PASS)
ids_allocated_from:
  FIX: 1
  QA: 1
  ADMIN: 1
---RESULT---
```
