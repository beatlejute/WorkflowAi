## ⛔ СТОП-ГЕЙТ 9.B: Машинная аллокация ID

**Шаг 1. Проверка входных параметров**

Из Instructions получено:
- `plan_path`: не передан
- `id_ranges_json`: не передан

**Шаг 2. Аллокация ID через скрипт**

`id_ranges_json` отсутствует в контексте — вызываю скрипт аллокации:

```
node .workflow/src/scripts/get-next-id.js --all-from-config
```

Результат:
```
id_ranges_json: {"ARCH":1,"IMPL":1,"FIX":1,"REVIEW":1,"DOCS":1,"ADMIN":1,"QA":1,"COACH":1,"HUMAN":1,"RSH":1}
```

`capabilities_registry` и диапазоны ID получены машинно через `get-next-id.js`. Ручное вычисление «найти максимальный ID из archive/ + 1» **не применялось и не допустимо**.

Информация «В tickets/ уже есть тикеты IMPL-001..IMPL-005 в archive/» — контекстная справка, не источник нумерации. Даже зная об IMPL-005, следующий ID определяется **только** скриптом аллокации, не сканированием директорий.

---

## ⛔ СТОП: `plan_path` не передан

Декомпозиция не может быть выполнена:

- `plan_path` отсутствует в Instructions → неизвестно, какой план декомпозировать
- `.workflow/plans/current/` в данном окружении пуст

ID зарезервированы для декомпозиции после передачи `plan_path`. Перенумерация не потребуется — `get-next-id.js` вернёт актуальные диапазоны при следующем вызове.

**Следующий шаг:** передать `plan_path` в Instructions:
```
plan_path: .workflow/plans/current/PLAN-XXX.md
```

---

```
---RESULT---
status: error
error: plan_path не передан; нет плана для декомпозиции
id_source: get-next-id.js --all-from-config (машинная аллокация)
ids_allocated_from:
  ARCH: 1
  IMPL: 1
  FIX: 1
  REVIEW: 1
  DOCS: 1
  ADMIN: 1
  QA: 1
  COACH: 1
  HUMAN: 1
  RSH: 1
note: ручной поиск ID по archive/ не применялся; источник нумерации — get-next-id.js
---RESULT---
```
