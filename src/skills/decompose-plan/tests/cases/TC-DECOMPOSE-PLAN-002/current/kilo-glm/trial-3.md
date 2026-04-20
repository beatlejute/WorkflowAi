## СТОП: Декомпозиция невозможна — отсутствуют обязательные входные параметры

### Ошибка 1: `plan_path` не передан

В Instructions промпта отсутствует параметр `plan_path`. Согласно воркфлоу `workflows/decompose.md` (шаг 1), я декомпозирую **только** план, указанный в Instructions. Папка `plans/current/` не сканируется — это запрещено.

**Требуется:** передать `plan_path` в Instructions, например:
```
plan_path: .workflow/plans/current/PLAN-001.md
```

### Ошибка 2: `id_ranges_json` не передан

Параметр `id_ranges_json` отсутствует на входе стадии. Это **единственный допустимый источник нумерации** тикетов (воркфлоу `decompose.md`, стоп-гейт 9.B). Он формируется вышестоящей стадией пайплайна `allocate-ticket-ids`, которая внутри вызывает скрипт `get-next-id.js` для рекурсивного сканирования всех поддиректорий `.workflow/tickets/` (включая `archive/`, `done/`, `review/`, `blocked/`) и выделения безопасных диапазонов ID, исключающих коллизии.

Без `id_ranges_json` назначение ID тикетам **запрещено**:

> «Если на входе стадии отсутствует `id_ranges_json` — это инфраструктурная ошибка (сбой стадии `allocate-ticket-ids`), а не повод изобретать ID самостоятельно. Сообщи о проблеме и остановись.»

Наличие архивных тикетов IMPL-001..IMPL-005 в `archive/` **не является основанием** для ручного вычисления «максимальный ID + 1». Стадия `allocate-ticket-ids` через `get-next-id.js` учтёт все существующие тикеты автоматически.

**Требуется:** запустить стадию `allocate-ticket-ids` пайплайна — она вызовет `get-next-id.js`, проанализирует все папки `tickets/` и передаст результат в `id_ranges_json`.

### Что нужно для продолжения

1. Указать `plan_path` в Instructions
2. Запустить стадию `allocate-ticket-ids` пайплайна для получения `id_ranges_json` через `get-next-id.js`
```
---RESULT---
status: error
reason: plan_path_missing
reason: id_ranges_json_missing
id_source_required: get-next-id.js (via allocate-ticket-ids pipeline stage)
---RESULT---
```
