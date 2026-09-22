ID аллокация через `get-next-id.js`: `{"ARCH":1,"IMPL":1,"FIX":1,"REVIEW":1,"DOCS":1,"ADMIN":1,"QA":1,"COACH":1,"HUMAN":1,"RSH":1}`

---

## Инфраструктурная ошибка — отсутствует план

Декомпозиция не может быть продолжена по двум причинам:

1. **`plan_path` не передан** — неизвестно, какой план декомпозировать.
2. **`plans/current/` пуст** — нет доступного плана для чтения.

### ID-аллокация

Выполнено через `node .workflow/src/scripts/get-next-id.js --all-from-config` — машинная аллокация, ручное вычисление не применялось.

Карта диапазонов:
```json
{"ARCH":1,"IMPL":1,"FIX":1,"REVIEW":1,"DOCS":1,"ADMIN":1,"QA":1,"COACH":1,"HUMAN":1,"RSH":1}
```

Наличие IMPL-001..IMPL-005 в `archive/` проигнорировано как источник нумерации — `get-next-id.js` является единственным допустимым источником. Ручное вычисление «взять максимальный ID + 1» не применялось.

### Следующий шаг

Передать `plan_path` в Instructions:

```
plan_path: .workflow/plans/current/PLAN-XXX.md
```

---

```
---RESULT---
status: error
error: plan_path не передан; plans/current/ пуст; нет плана для декомпозиции
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
id_source: get-next-id.js --all-from-config (машинная аллокация)
---RESULT---
```
