Бэклог обновлён корректно: дублирующие `last_action` удалены, запись добавлена в `analyzed_tickets` по новой схеме `source: ad_hoc`.

---

## Итоговый отчёт

### Findings

| # | Приоритет | Описание | Статус |
|---|-----------|----------|--------|
| F1 | **CRITICAL** | Коллизия IMPL-002/IMPL-003: pick-first-task архивирует → decompose-plan пересоздаёт в том же запуске. Root cause: `algorithms/deduplication.md` не сканировал `archive/`, стадия `allocate-ticket-ids` отсутствовала | ✅ ИСПРАВЛЕНО |
| F2 | **HIGH** | `ids_allocated_from` отсутствует в RESULT декомпозиции — СТОП-гейт 9.B не был внедрён на 2026-04-06 | ✅ ИСПРАВЛЕНО |
| F3 | **MEDIUM** | Пайплайн не валидирует наличие `ids_allocated_from` в RESULT механически — агент может пропустить СТОП-гейт без остановки пайплайна | ❌ НЕ ИСПРАВЛЕНО |
| F4 | **LOW** | `coach-backlog.yaml` содержал дублирующий non-schema ключ `last_action` — запись предыдущего анализа этого лога была молча перекрыта | ✅ ИСПРАВЛЕНО |

### Что сделано

- **`knowledge/backlog-management.md`** — добавлена секция «Ad-hoc анализы» с форматом `source: ad_hoc` для `analyzed_tickets` и антипаттерн «Non-schema поля»
- **`coach-backlog.yaml`** — удалены дублирующие `last_action`, добавлена корректная запись ad-hoc анализа в `analyzed_tickets`

### Рекомендация по F3

Создать IMPL-тикет: добавить в раннер пайплайна post-check для стадии `decompose-plan` — если `---RESULT---` не содержит секцию `ids_allocated_from:` → статус стадии FAILED, декомпозиция откатывается. Это машинная защита, не зависящая от дисциплины агента.
