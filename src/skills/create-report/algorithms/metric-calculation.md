# Алгоритм: Расчёт метрик отчёта

## Вход

Список тикетов из `.workflow/tickets/` (все статусы), активный план (если есть).

## 1. Velocity

### Формула

```
velocity_day = done_count / days_elapsed
velocity_week = velocity_day * 7
```

`days_elapsed` — от начала работы по плану до момента отчёта, не меньше 1 дня. Начало — самая ранняя запись «## История работы» среди тикетов плана (`start_source: first_run`), записей нет — дата создания плана, затем самая ранняя `created_at` тикета. Дата черновика плана раньше начала работы и занижает velocity.

**Сглаживание** (при наличии предыдущего отчёта):

```
smoothed_velocity = 0.7 * current_velocity + 0.3 * previous_velocity
```

### Пример

За 5 дней закрыто 8 тикетов. Предыдущая velocity = 1.0/день.

- `current = 8 / 5 = 1.6`
- `smoothed = 0.7 * 1.6 + 0.3 * 1.0 = 1.42`

## 2. Plan Health

### Формула

```
completion = done_in_plan / total_in_plan * 100%
expected = days_since_start / total_planned_days * 100%
delta = completion - expected
```

`total_planned_days` — срок плана: `end_date − created_at` или `duration_days` из frontmatter плана (`horizon_source`). Срока нет — `expected` и `delta` не считаются, статус `n/a`, горизонт по умолчанию не подставляется: подставленный горизонт даёт ожидаемое выполнение, которого у плана нет.

### Пороги

| Статус | Условие | Действие |
|--------|---------|----------|
| ON_TRACK | delta >= 0 | Нет |
| AT_RISK | -25% < delta < 0 | Указать в отчёте |
| OFF_TRACK | delta <= -25% | Пометить CRITICAL в отчёте |
| n/a | срока плана нет (`horizon_source: none`) | Написать в отчёте «plan health не рассчитан: у плана нет срока» |

### Пример

План: 20 тикетов, 10 дней. Прошло 6 дней, закрыто 10.

- `completion = 10/20 = 50%`
- `expected = 6/10 = 60%`
- `delta = 50% - 60% = -10%` → **AT_RISK**

## 3. Распределение тикетов

### Формула

```
type_pct = count_by_type / total * 100%
```

Типы берутся из поля `type` в frontmatter тикетов. Группировка динамическая — перечисляются все встречающиеся типы.

### Пример

15 тикетов: 6 impl, 4 fix, 3 review, 2 docs.

- impl: 6/15 = 40%, fix: 27%, review: 20%, docs: 13%

## 4. Обнаружение аномалий

### Критерии

| Аномалия | Условие | Severity |
|----------|---------|----------|
| Velocity drop | current < previous * 0.5 | HIGH |
| Blocked accumulation | blocked_rate > 25% | HIGH |
| Stale in-progress | in_progress с `updated_at` > 3 дней назад | MEDIUM |
| Result without move | in_progress с непустым Result | MEDIUM |
| Zero velocity | done_count = 0 за период | HIGH |
| Review rework | тикетов плана хотя бы с одной строкой ❌ в «## Ревью» ≥ 25% от всех тикетов плана | MEDIUM |

### Пример

Предыдущая velocity = 2.0, текущая = 0.8.

- `0.8 < 2.0 * 0.5 = 1.0` → **Velocity drop (HIGH)**

## Выход

Рассчитанные метрики для включения в секции отчёта: статистика, velocity, plan health, аномалии.

<!-- РАСШИРЕНИЕ: добавляй новые формулы и критерии ниже -->
