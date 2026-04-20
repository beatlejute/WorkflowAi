Now let me read the ticket template and config:
**capabilities_registry**: `["text", "multimodal"]`

**Анализ плана:**
Задача: «Реализовать модалку «Выбор прокси по умолчанию» с тремя DoD-пунктами:
1. Компонент `src/popup/select-default-proxy-modal.ts` создан
2. Ключ i18n `selectDefaultProxyTitle` добавлен в locale-файлы
3. Юнит-тесты для модалки зелёные

Три DoD-пункта → три независимых объекта изменения → минимум 3 тикета.

**Чеклист атомарности:**

**Тикет 1 — IMPL-1: Создать модалку выбора прокси**
| Проверка | Результат | Evidence |
|----------|-----------|----------|
| 1. Одна задача | PASS | Title: «Создать модалку выбора прокси» — один глагол |
| 2. Один объект | PASS | Файл `select-default-proxy-modal.ts` — один модуль |
| 3. Один результат | PASS | DoD: компонент создан |
| 4. Нет скрытых подзадач | PASS | Внутри компонента — рендер, стили, хендлеры, но это атомарный тикет по реализации |
| 5. Размер | PASS | <200 строк TypeScript UI |
| 6. Независимая верификация | PASS | Можно проверить по файлу |
| 7. Один исполнитель | PASS | Один тип `impl` |

**Тикет 2 — IMPL-2: Добавить ключ i18n selectDefaultProxyTitle**
| Проверка | Результат | Evidence |
|----------|-----------|----------|
| 1. Одна задача | PASS | Один ключ |
| 2. Один объект | PASS | Один locale-файл |
| 3. Один результат | PASS | Один ключ добавлен |
| 4. Нет скрытых подзадач | PASS | |
| 5. Размер | PASS | Одна строка |
| 6. Независимая верификация | PASS | |
| 7. Один исполнитель | PASS | |

**Тикет 3 — IMPL-3: Написать юнит-тесты для модалки**
| Проверка | Результат | Evidence |
|----------|-----------|----------|
| 1. Одна задача | PASS | Тесты для модалки |
| 2. Один объект | PASS | Один test-файл |
| 3. Один результат | PASS | Тесты зелёные |
| 4. Нет скрытых подзадач | PASS | |
| 5. Размер | PASS | Реалистичный объём тестов |
| 6. Независимая верификация | PASS | Тесты проверяют компонент |
| 7. Один исполнитель | PASS | Один тип `impl` |

**Зависимости:** IMPL-3 зависит от IMPL-1 (нужен компонент для тестирования). IMPL-2 независим.

Создаю тикеты:
---

```
---RESULT---
status: default
tickets_created:
  - .workflow/tickets/backlog/IMPL-1.md
  - .workflow/tickets/backlog/IMPL-2.md
  - .workflow/tickets/backlog/IMPL-3.md
decomposition_summary:
  plan_tasks: 1
  tickets_created: 3
  breakdown:
    Задача 1 → [IMPL-1, IMPL-2, IMPL-3] (3 DoD-пункта → 3 тикета по атомарности)
ids_allocated_from:
  IMPL: 1
capabilities_registry: ["text", "multimodal"]
notes:
  - "config.yaml и pipeline.yaml не найдены в workspace; префикс IMPL выбран как наиболее подходящий для реализации кода browser extension"
  - "id_ranges_json не передан стадией allocate-ticket-ids; ID начинаются с 1"
---RESULT---
```

**Создано 3 тикета:**

| ID | Название | Зависимости | 
|----|----------|-------------|
| IMPL-1 | Создать модалку выбора прокси по умолчанию | — |
| IMPL-2 | Добавить ключ i18n selectDefaultProxyTitle | — |
| IMPL-3 | Написать юнит-тесты для модалки | IMPL-1 |

**capabilities_registry**: `["text", "multimodal"]` — все три тикета имеют `required_capabilities: []`, так как задача реализуема базовыми агентскими способностями (чтение/редактирование текста). Ключи `typescript`, `browser-extension`, `i18n` не являются capability агента и не включены в реестр.
