---

## Итоговый отчёт findings

### Временны́е диаграммы повторяющихся ID

**IMPL-002** (коллизия):
```
16:36:02  ARCHIVE  tickets/done/IMPL-002.md → tickets/archive/IMPL-002.md
                   (pick-next-task auto-correction: PLAN-002 archived)
16:40:31  CREATE   tickets/backlog/IMPL-002.md
                   (decompose-plan: "Конфиг tickets/**: protected_files + trusted_stages")
          ⚠️ КОЛЛИЗИЯ: tickets/archive/IMPL-002.md и tickets/backlog/IMPL-002.md
```

**IMPL-003** (коллизия):
```
16:36:02  ARCHIVE  tickets/done/IMPL-003.md → tickets/archive/IMPL-003.md
                   (pick-next-task auto-correction: PLAN-002 archived)
16:40:31  CREATE   tickets/backlog/IMPL-003.md
                   (decompose-plan: "Дедупликация в pick-next-task")
          ⚠️ КОЛЛИЗИЯ: tickets/archive/IMPL-003.md и tickets/backlog/IMPL-003.md
```

---

### Findings (приоритизированы)

| # | Приоритет | Finding |
|---|-----------|---------|
| F1 | CRITICAL | **ID коллизия.** IMPL-002 и IMPL-003 существуют одновременно в `archive/` и `backlog/`. Нарушена ссылочная целостность: `check-conditions` считает тикет "завершённым" (archive), пока новый тикет с тем же ID активен в backlog. |
| F2 | CRITICAL | **Отсутствие `allocate-ticket-ids` в пайплайне PLAN-003.** GOTO: `check-plan-decomposition → decompose-plan` напрямую, без выделения `id_ranges_json`. Агент-декомпозитор запущен без источника нумерации. |
| F3 | CRITICAL | **Нарушение stop-gate.** Старая версия `decompose-plan` не остановилась при отсутствии `id_ranges_json`; применила fallback (нумерация с 001). Признак: `ids_allocated_from` отсутствует в `---RESULT---`. |
| F4 | HIGH | **`decompose-gaps` использует агент-driven ID-генерацию без hard stop-gate** — тот же класс риска. Инструкция «найди все файлы... прибавь 1» без ⛔-нотации могла быть проигнорирована fallback-агентом так же, как в PLAN-003. |

**Root cause chain:**
```
Нет allocate-ticket-ids в пайплайне  →  id_ranges_json = absent
→  Агент применил fallback (нумерация с 001)
→  Пост-валидация уникальности не выполнена
→  ID IMPL-002, IMPL-003 коллизируют с archive/
```

---

### Статус исправлений

| Компонент | Статус |
|-----------|--------|
| `pipeline.yaml`: стадия `allocate-ticket-ids` | ✅ Уже существует (добавлена по итогам инцидента) |
| `decompose-plan/workflows/decompose.md`: stop-gate 9.B | ✅ Уже существует + CHG-2026-04-19-001/002 применены ранее |
| `decompose-gaps/workflows/decompose.md`: СТОП-ГЕЙТ | ✅ **CHG-2026-04-19-003 применён в этой сессии** |

### Применённое изменение (CHG-2026-04-19-003)

**Файл:** `D:\Dev\workflowAi\src\skills\decompose-gaps\workflows\decompose.md`

**Изменения:**
1. Шаг 9 — определение следующего ID: заменена формулировка «найди все файлы... во всех папках» на явный Glob-вызов с подчёркиванием `archive/` и `done/`; добавлено `⛔ Не угадывай номер`
2. Шаг 9 — добавлен блок `⛔ СТОП-ГЕЙТ: проверка уникальности ID` с антипаттерном
3. Чеклист завершения — добавлен пункт: `Для каждого созданного тикета выполнен СТОП-ГЕЙТ проверки уникальности ID`

### Тест

Воркфлоу `workflows/test.md` имеет статус **DRAFT (не активирован)**. Существующий тест `TC-DECOMPOSE-GAPS-002` уже покрывает glob-before-write поведение (проверяет обнаружение файла в `ready/`). Изменение усиливает инструкцию, не меняя требуемое поведение — регрессии не ожидается.
