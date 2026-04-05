# Алгоритм: Проверка актуальности тикета

## Вход

- `ticket_id` — идентификатор тикета из контекста промпта
- Файл тикета: `.workflow/tickets/in-progress/{ticket_id}.md`

## Выход

- `status`: `relevant` | `irrelevant`
- `reason` (при **irrelevant**): `already_skipped` | `plan_inactive` | `dod_completed` | `dependencies_inactive` | `blocked`
- `reason` (при **relevant**): `review_failed_needs_rework` | `needs_review`

> ⛔ **`review_failed_needs_rework` используется ТОЛЬКО со `status: relevant`.** Использование со `status: irrelevant` — ошибка алгоритма.

## Алгоритм (шаги выполняются последовательно, первый irrelevant — стоп)

### Шаг 0. Быстрый выход по существующему ревью

1. Найди секцию `## Ревью` в тикете
2. Если последняя запись `⏭ skipped` → **СТОП**: `irrelevant` (reason: `already_skipped`). Новую запись НЕ добавлять.
3. Если последняя запись `❌ failed` → **СТОП**: `relevant` (reason: `review_failed_needs_rework`)
4. Иначе → продолжить

### Шаг 1. Прочитать тикет

1. Открой `.workflow/tickets/in-progress/{ticket_id}.md`
2. Извлеки из frontmatter: `parent_plan`, `dependencies`, `conditions`
3. Извлеки из тела: Definition of Done (чеклист `[ ]` / `[x]`), секцию `## Блокировки`

### Шаг 2. Проверить статус blocked

1. Если есть секция `## Блокировки` с активными блокировками → `irrelevant` (reason: `blocked`)
2. Если frontmatter содержит `blocked: true` → `irrelevant` (reason: `blocked`)

### Шаг 3. Проверить родительский план

1. Открой файл из `parent_plan` (путь: `.workflow/plans/current/{plan}.md`)
2. Прочитай `status` из frontmatter
3. Если `status` ∈ {`completed`, `archived`, `cancelled`} → `irrelevant` (reason: `plan_inactive`)
4. Если файл не найден или `parent_plan` пуст → fallback `relevant` (fail-safe)

### Шаг 4. Проверить выполнение DoD

1. Найди все чекбоксы в Definition of Done
2. Если ВСЕ отмечены `[x]` И секция «Результат выполнения» заполнена:
   - Если последнее ревью `❌ failed` → `relevant` (reason: `review_failed_needs_rework`)
   - Если ревью нет вообще (секция `## Ревью` пуста или отсутствует) → `relevant` (reason: `needs_review`)
   - Если последнее ревью `✅ passed` → `irrelevant` (reason: `dod_completed`)

### Шаг 5. Проверить зависимости

1. Для каждого тикета из `dependencies`:
   - Поищи файл в `blocked/` → если найден с причиной «неактуально» → зависимость неактуальна
   - Поищи файл во всех колонках → если не найден (удалён/архивирован) → зависимость неактуальна
2. Если хотя бы одна критическая зависимость неактуальна → `irrelevant` (reason: `dependencies_inactive`)

### Шаг 6. Вердикт

Если все проверки пройдены → `relevant`

### Шаг 6.1. Верификация вывода (ОБЯЗАТЕЛЬНО)

Перед тем как сформировать ответ:
1. Убедись, что в ответе будет блок `---RESULT---` с полями `status` и `reason`
2. Если вердикт `irrelevant` — убедись, что шаг 7 (запись в ревью) ВЫПОЛНЕН ПЕРВЫМ, до вывода RESULT-блока
3. Если вердикт `relevant` — убедись, что ты НЕ сделал никаких записей в файл тикета. Если сделал `⏭ skipped` запись — удали её немедленно
4. Проверь: `reason: review_failed_needs_rework` допустим ТОЛЬКО совместно со `status: relevant`

### Шаг 7. Запись при irrelevant

> **⛔ КРИТИЧНО:** Пропуск этого шага приводит к **бесконечному циклу** в пайплайне.
> Без записи `⏭ skipped` в ревью тикет попадает в `done/` без ревью → auto-correction
> возвращает его в `backlog/` → он снова проходит `ready → in-progress → check-relevance → done` бесконечно.
> **Этот шаг ОБЯЗАТЕЛЕН — без него не выдавай RESULT-блок.**

> **⛔ При вердикте `relevant` — НЕ делай НИКАКИХ записей в тикет.** Скил read-only при `relevant`.
> Запись `⏭ skipped` при `relevant` ломает пайплайн: при следующем прогоне шаг 0.2 найдёт `⏭ skipped`
> и вернёт `irrelevant (already_skipped)` — тикет никогда не выполнится.

Если вердикт `irrelevant`:
1. Найди или создай секцию `## Ревью` в конце файла тикета (заголовок строго `## Ревью`, кириллицей)
2. Добавь строку в таблицу:

```
| {текущая дата} | ⏭️ skipped | {причина} |
```

3. **Верификация:** после записи перечитай секцию ревью и убедись, что строка добавлена. Если строка отсутствует — повтори запись.

## Таблица решений (сводная)

| # | Проверка | Результат | Статус | Reason | Примечание |
|---|----------|-----------|--------|--------|------------|
| 0 | Последнее ревью `⏭ skipped` | Уже проверен | `irrelevant` | `already_skipped` | |
| 0 | Последнее ревью `❌ failed` | Нужна доработка | **`relevant`** | `review_failed_needs_rework` | ⛔ статус RELEVANT, не irrelevant |
| 2 | Тикет заблокирован | Blocked | `irrelevant` | `blocked` | |
| 3 | План неактивен | Plan inactive | `irrelevant` | `plan_inactive` | |
| 4 | DoD выполнен, ревью `✅ passed` | Задача сделана | `irrelevant` | `dod_completed` | |
| 4 | DoD выполнен, ревью отсутствует | Нужно ревью | **`relevant`** | `needs_review` | ⛔ не irrelevant — иначе auto-correct loop |
| 5 | Зависимости неактуальны | Deps inactive | `irrelevant` | `dependencies_inactive` | |
| 6 | Все проверки ОК | All passed | `relevant` | — | |

## Граничные случаи

| Случай | Решение |
|--------|---------|
| Файл тикета не найден | `relevant` (fail-safe) |
| `parent_plan` пуст | `relevant` (fail-safe) |
| Файл плана не найден | `relevant` (fail-safe) |
| Неизвестный статус плана | `relevant` (fail-safe) |
| Нет секции DoD | Считать DoD невыполненным → `relevant` |
| Зависимость не найдена ни в одной колонке | Считать неактуальной |
| Вердикт `relevant`, но в ревью случайно добавлена `⏭ skipped` | Удалить строку немедленно — иначе следующий прогон вернёт `already_skipped` и тикет застрянет |

## Пример применения

**Вход:** тикет `XXX-005` в `in-progress/`

1. Ревью: нет записей → продолжаем
2. Блокировки: нет → продолжаем
3. План `PLAN-001`: `status: active` → ОК
4. DoD: 2 из 4 `[x]` → не завершён → ОК
5. Зависимости: `XXX-003` в `done/` → ОК
6. **Вердикт: `relevant`**

<!-- РАСШИРЕНИЕ: добавляй новые проверки и граничные случаи ниже -->
