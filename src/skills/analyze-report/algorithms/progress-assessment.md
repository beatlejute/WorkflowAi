# Алгоритм: Оценка прогресса по плану

Формализованный метод оценки текущего прогресса выполнения плана.

## Вход

- Список всех тикетов плана с их статусами (done, in-progress, ready, blocked, backlog)
- Сложность каждого тикета (simple, medium, complex)
- Даты создания и завершения тикетов
- Данные ревью (прошёл / не прошёл / пропущен)

## Алгоритм

### 1. Подсчитай распределение по статусам

```
total = count(all tickets)
done = count(status == done)
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

```
reviewed = count(tickets with review)
passed_first = count(tickets passed review on first attempt)
first_pass_rate = passed_first / reviewed × 100%
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
- Quality Rate (First-Pass Rate)
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
