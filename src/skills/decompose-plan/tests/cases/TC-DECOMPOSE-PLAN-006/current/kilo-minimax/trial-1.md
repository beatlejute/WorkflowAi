Now I understand the task and the format. The plan has 8 DoD items, which exceeds the hard threshold of 7 from `verify-atomicity.js`. The decomposition needs to split into multiple atomic tickets.

Let me create the directory structure and the tickets:
Let me check if there's a pipeline config and look at the existing decompose-plan test for the actual ticket content:
Now I'll create the two atomic tickets based on the decomposition analysis. The 8 DoD items exceed the hard threshold of 7, requiring split into 2 tickets:
---RESULT---
status: default
tickets_created: 2
ids_allocated_from:
  IMPL: 1
decomposition:
  plan_items: 1
  tickets_created: 2
  reason_for_split: "DoD содержит 8 пунктов, превышает hard-порог verify-atomicity.js (DOD_THRESHOLD_FAIL = 7)"
split_analysis:
  IMPL-001:
    title: "Создать модальную компоненту выбора прокси (скелет + API)"
    dod_count: 6
    items: "[1, 2, 3, 5, 6, 7]"
  IMPL-002:
    title: "Реализовать рендеринг списка прокси и обработку пустого списка"
    dod_count: 2
    items: "[4, 8]"
    dependencies: ["IMPL-001"]
atomicity_checks_passed: true
---RESULT---

## Результат декомпозиции

**План:** `select-default-proxy-modal` (8 DoD пунктов)

| Тикет | Название | DoD | Зависимости |
|-------|----------|-----|-------------|
| IMPL-001 | Создать модальную компоненту выбора прокси (скелет + API) | 6 | — |
| IMPL-002 | Реализовать рендеринг списка прокси и обработку пустого списка | 2 | IMPL-001 |

**Причина разбиения:** DoD содержит 8 пунктов — превышает hard-порог `verify-atomicity.js` (DOD_THRESHOLD_FAIL = 7). Разбиение выполнено по группам независимых критериев.

**Рекомендации для следующего плана (вне scope):**
- QA-тикет на автотесты для `select-default-proxy-modal` — после реализации IMPL-001 и IMPL-002
- DOCS-тикет на обновление документации компонента — после реализации
