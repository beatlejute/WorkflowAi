Now I have all the information I need. Let me analyze the plan's 8 DoD items and decompose them.

**Analysis of plan DoD (8 items):**
1. Файл создан через ModalHelper
2. showSelectDefaultProxyModal(proxies) экспорт и resolve
3. Закрытие крестиком/Esc → null
4. Edge case: пустой список → null сразу, без DOM
5. Заголовок из I18n
6. НЕ вызывает Storage.setDefaultProxy()
7. НЕ читает из storage — принимает готовый список
8. Каждый элемент: имя, host:port, флаг страны

**Atomicity check for single ticket (all 8 items):**
- P1: 8 items — FAIL (>7 DoD items = hard FAIL per verify-atomicity.js DOD_THRESHOLD_FAIL=7)
- **Must split**

**Natural decomposition (grouping by concern):**
- Items 1,2,3,8 → Core modal: создание + функция + закрытие + отображение элементов (5 items)
- Items 4,5 → Одинокая модалка: edge case пустого списка + i18n заголовок (2 items)
- Items 6,7 → Constraints: модалка не пишет/не читает storage (2 items)

**capabilities_registry:** `[text, multimodal]` (from pipeline.yaml agents)

Now creating tickets:
---RESULT---
status: default
tickets_created: 2
id_ranges_allocated: IMPL-001..IMPL-002

## Декомпозиция плана

**Задача плана:** Реализовать компонент `select-default-proxy-modal` (8 DoD-пунктов)

### Чеклист атомарности (план как единый тикет)

| Проверка | Результат | Evidence |
|----------|-----------|----------|
| 1. Одна задача | PASS | Один глагол "реализовать" |
| 2. Один объект | PASS | Один файл модалки |
| 3. Один результат | PASS | Единое observable-поведение |
| 4. Нет скрытых подзадач | PASS | Линейная реализация |
| 5. Размер | **FAIL** | DoD содержит **8 пунктов** (>7, hard-порог verify-atomicity.js DOD_THRESHOLD_FAIL=7). Разбиение обязательно |
| 6. Независимая верификация | PASS | Результат проверяем независимо |
| 7. Один исполнитель | PASS | Все IMPL |

**Решение: РАЗБИТЬ на 2 тикета** (группировка по предметному ядру, ≤7 пунктов DoD в каждом)

---

### IMPL-001 — Реализовать select-default-proxy-modal: создание, функция выбора, закрытие, отображение

**DoD (6 пунктов, ≤7 ✓):**
1. Файл создан через ModalHelper по образцу `public-proxies-modal.ts`
2. `showSelectDefaultProxyModal(proxies)` экспорт и resolve `id` выбранного прокси
3. Закрытие крестиком/Esc → `null`
4. Каждый элемент списка: имя, host:port, флаг страны
5. Модалка НЕ вызывает `Storage.setDefaultProxy()` внутри
6. Модалка НЕ читает прокси из storage — принимает готовый список

**Атомарность:** 7 проверок → все PASS ✓

---

### IMPL-002 — Добавить в select-default-proxy-modal: edge case пустого списка и i18n-заголовок

**DoD (2 пункта, ≤7 ✓):**
1. Edge case: пустой список → модалка не рендерит DOM, резолвит `null` сразу
2. Заголовок из `I18n.getMessage('selectDefaultProxyTitle')`

**Dependencies:** `IMPL-001`

**Атомарность:** 7 проверок → все PASS ✓

---

### Рекомендации для следующего плана (вне scope)

Отсутствуют — все 8 DoD-пунктов плана покрыты тикетами IMPL-001 (6) и IMPL-002 (2).

### Итоговая проверка DoD-счётчика

| Тикет | DoD-пунктов | Порог | Статус |
|-------|-------------|-------|--------|
| IMPL-001 | 6 | ≤7 | PASS |
| IMPL-002 | 2 | ≤7 | PASS |
| **Σ** | **8** | — | **Полное покрытие плана** |

---RESULT---
