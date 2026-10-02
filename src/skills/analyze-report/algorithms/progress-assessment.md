# Алгоритм: Оценка прогресса по плану

Формализованный метод оценки текущего прогресса выполнения плана.

## Вход

- Список всех тикетов плана с их статусами (done, archive, review, in-progress, ready, blocked, backlog); archive — завершённые тикеты закрытого плана, считаются как done, review — выполнены и ждут ревью, в done не считаются
- Сложность каждого тикета (simple, medium, complex)
- Даты создания и завершения тикетов
- Данные ревью — таблица «## Ревью» каждого тикета: строки ✅ passed, ❌ failed, ⏭️ skipped

## Алгоритм

### 1. Подсчитай распределение по статусам

```
total = count(all tickets)
done = count(status == done or status == archive)
review = count(status == review)
in_progress = count(status == in-progress)
ready = count(status == ready)
blocked = count(status == blocked)
backlog = count(status == backlog)
```

### 2. Рассчитай Completion Rate

**Простой (по количеству):**
```
completion_rate = done / total × 100%
```

**Взвешенный (по сложности):**

| Сложность | Вес |
|-----------|-----|
| simple | 1 |
| medium | 2 |
| complex | 3 |

```
weighted_done = Σ(weight[t] for t in done_tickets)
weighted_total = Σ(weight[t] for t in all_tickets)
weighted_completion = weighted_done / weighted_total × 100%
```

### 3. Рассчитай Quality Rate

Источник — таблица «## Ревью» тикета. Строка с вердиктом ✅ passed или ❌ failed — одна попытка ревью, строка ⏭️ skipped и отметка без вердикта ревью (например, «✅ выполнено человеком») попыткой не считаются. Первая попытка — первая такая строка, каждая строка ❌ — возврат. Знаменатель First-Pass Rate и Rework Rate — reviewed: тикет без попытки ревью ни пройти его с первого раза, ни вернуться с него не мог. Считает скрипт `scripts/calc-plan-metrics.js` (поля reviewed, passed_first, first_pass_rate, rework_count, rework_rate, failed_reviews_total, reworked_tickets), вручную — только если скрипт недоступен, по тем же определениям.

```
reviewed = count(tickets with review)                          # хотя бы одна строка passed или failed
passed_first = count(tickets passed review on first attempt)   # первая такая строка — passed
first_pass_rate = passed_first / reviewed × 100%
rework_count = count(tickets with ≥1 failed row)
rework_rate = rework_count / reviewed × 100%
failed_reviews_total = count(failed rows)
```

### 4. Рассчитай Block Rate

```
block_rate = blocked / total × 100%
```

### 5. Определи статус прогресса

| Completion | Block Rate | First-Pass Rate | Статус | Рекомендация |
|------------|-----------|-----------------|--------|-------------|
| ≥80% | <10% | ≥70% | 🟢 ON_TRACK | Продолжить по плану |
| 50-80% | <20% | ≥50% | 🟡 ATTENTION | Обратить внимание на отстающие задачи |
| 30-50% | <30% | Любой | 🟠 AT_RISK | Пересмотреть приоритеты, разблокировать |
| <30% | ≥30% | Любой | 🔴 CRITICAL | Эскалировать, пересмотреть план |

### 6. Оцени тренд

Если есть данные за несколько периодов:
```
velocity_current = done_last_period / period_length
velocity_previous = done_prev_period / period_length
trend = velocity_current - velocity_previous
```

| Тренд | Интерпретация |
|-------|---------------|
| trend > 0 | 📈 Ускорение |
| trend ≈ 0 | ➡️ Стабильно |
| trend < 0 | 📉 Замедление |

## Выход

- Completion Rate (простой и взвешенный)
- Quality Rate (First-Pass Rate, Rework Rate)
- Block Rate
- Статус прогресса (ON_TRACK / ATTENTION / AT_RISK / CRITICAL)
- Тренд (если данных достаточно)
- Распределение тикетов по статусам

## Пример

```
Total: 12 тикетов
Done: 7 (3 simple, 3 medium, 1 complex)
In-progress: 2 (1 medium, 1 complex)
Ready: 1 (simple)
Blocked: 2 (1 medium, 1 complex)

Completion Rate: 7/12 = 58%
Weighted: (3×1 + 3×2 + 1×3) / (4×1 + 4×2 + 4×3) = 12/24 = 50%
Block Rate: 2/12 = 17%
First-Pass Rate: 5/7 = 71%

Статус: 🟡 ATTENTION (50% weighted, 17% blocked, 71% first-pass)
```
