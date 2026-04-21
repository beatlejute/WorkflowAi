По одному совпадению для каждого тикета — коллизий нет. ✅

---

## Итог декомпозиции

Исходная задача содержала **8 пунктов DoD** — превышение hard-порога `verify-atomicity.js` (`DOD_THRESHOLD_FAIL = 7`). Проверка 5 (Оценка размера) → **FAIL**. Задача разбита на 2 тикета по группам независимых DoD-пунктов:

| ID | Тип | Название | DoD (пунктов) | Зависимости |
|----|-----|----------|---------------|-------------|
| IMPL-1 | impl | Создать scaffold select-default-proxy-modal.ts с контрактом функции | **5** | — |
| IMPL-2 | impl | Реализовать рендеринг списка прокси и обработку закрытия в select-default-proxy-modal | **3** | IMPL-1 |

**Шов разбиения:** IMPL-1 — scaffold и контрактные ограничения (создание файла, экспорт функции, I18n-заголовок, запреты на Storage); IMPL-2 — поведение UI в runtime (рендеринг элементов, обработка закрытия, guard на пустой список). Оба тикета проходят все 7 проверок атомарности.

### Рекомендации для следующего плана (вне scope)

- Автотесты для `showSelectDefaultProxyModal` (happy path, пустой список, закрытие через Esc) — отдельный QA-тикет после завершения IMPL-2.

---

```
---RESULT---
status: default
tickets_created:
  - .workflow/tickets/backlog/IMPL-1.md
  - .workflow/tickets/backlog/IMPL-2.md
decomposition_summary:
  plan_tasks: 1
  tickets_created: 2
  breakdown:
    Задача 1 → [IMPL-1, IMPL-2] (разбита: DoD содержит 8 пунктов, порог 7 — FAIL на Проверке 5)
ids_allocated_from:
  IMPL: 1
---RESULT---
```
