`plan_path` не передан в Instructions. `id_ranges_json` не передан. Конфиг отсутствует.

---

## ⛔ СТОП — два критических условия

### Условие 1: `plan_path` не передан

Воркфлоу `workflows/decompose.md` шаг 1: план читается **только** по `plan_path` из Instructions. Директория `plans/current/` не сканируется. Без `plan_path` неизвестно, что декомпозировать.

### Условие 2: СТОП-ГЕЙТ 9.B — `id_ranges_json` не передан

Параметр `id_ranges_json` отсутствует в Instructions.

Единственный допустимый источник нумерации тикетов — `id_ranges_json`, передаваемый стадией `allocate-ticket-ids`. Эта стадия запускается **до** декомпозиции: вызывает скрипт `get-next-id.js` (`.workflow/src/scripts/get-next-id.js`), который сканирует все поддиректории `.workflow/tickets/` и определяет следующий свободный N для каждого PREFIX. Результат передаётся декомпозитору как `id_ranges_json: '{"IMPL": N, "FIX": N, ...}'`.

**Информация о IMPL-001..IMPL-005 в archive/ не является источником нумерации.** Ручной алгоритм «взять максимальный занятый номер из archive/ и добавить 1» запрещён: `workflows/decompose.md` → 9.B явно исключает любой ручной fallback (`⛔ Не изобретай N_start самостоятельно и не используй ручной алгоритм как fallback`). Декомпозитор не вычисляет IMPL-006 самостоятельно, даже располагая информацией об архивных тикетах.

### Что требуется для запуска

1. Запустить стадию `allocate-ticket-ids` — вызовет `get-next-id.js --all-from-config`, вернёт карту диапазонов.
2. Передать `plan_path` в Instructions (путь к плану).
3. Передать `id_ranges_json` в Instructions — JSON-строку от `allocate-ticket-ids`, например `'{"IMPL": 6, "FIX": 1, ...}'`.

```
---RESULT---
status: error
error: >
  plan_path не передан;
  id_ranges_json не передан — СТОП-ГЕЙТ 9.B;
  декомпозиция не выполнена
id_source: требуется get-next-id.js через стадию allocate-ticket-ids (машинная аллокация)
note: >
  Наличие IMPL-001..IMPL-005 в archive/ не используется для определения следующего ID.
  Ручной подсчёт запрещён по 9.B workflows/decompose.md.
---RESULT---
```
