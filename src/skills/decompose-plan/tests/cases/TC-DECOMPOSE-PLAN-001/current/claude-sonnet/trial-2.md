---

### Итоговая карта декомпозиции

| Задача плана | Тикеты | Обоснование разбиения |
|-------------|--------|----------------------|
| Задача 1: fix-A + fix-B + smoke | FIX-1, FIX-2, QA-1 | Три независимых объекта работы: маппинг полей, валидация, прогон TC. Каждый верифицируется независимо. Три разных исполнителя по типу. |
| Задача 2: обновить CI | ADMIN-1 | Атомарна: один объект (конфиг CI), один результат (pipeline зелёный). |

Задача 1 разбита на 3 тикета по результатам чеклиста атомарности (7 проверок: 7 FAIL → 3 тикета). Маппинг «одна задача плана = один тикет» не применён — это антипаттерн: задача 1 содержит три независимых объекта работы с разными исполнителями.

---

### Рекомендации для следующего плана (вне scope)

- Создать `.workflow/src/skills/shared/README.md` с реестром observable-инвариантов — причина: без реестра Условия Б и В (парные тикеты ручной проверки по observable-зоне) не применяются, декомпозиция пропускает этот контроль.

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
    Задача 1 → [FIX-1, FIX-2, QA-1]  (разбита: 7/7 FAIL → 3 тикета)
    Задача 2 → [ADMIN-1]              (атомарна: 7/7 PASS)
ids_allocated_from:
  FIX: 1
  QA: 1
  ADMIN: 1
warnings:
  - id_ranges_json не передан; стартовые номера взяты как 1 для каждого нового префикса (fallback, недопустим в продакшне)
  - config.yaml не найден; префиксы FIX/QA/ADMIN выведены из конвенции проекта
  - pipeline.yaml не найден; capabilities_registry пуст; required_capabilities: [] для всех тикетов
---RESULT---
```
