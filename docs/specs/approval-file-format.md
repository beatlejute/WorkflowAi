# Спецификация формата approval-файла

## Обзор

Approval-файл — это JSON-файл, представляющий состояние шага пайплайна (stage) в процессе выполнения задачи. Файл используется для коммуникации между runner'ом и внешними системами, а также для ручного контроля прогресса.

Формат является публичным API runner'а и подлежит обратной совместимости.

## Структура файла

 Approval-файл содержит следующие поля:

| Поле | Тип | Обязательное | Описание |
|------|-----|--------------|----------|
| `ticket_id` | string | Да | ID тикета (например, `IMPL-001`) |
| `stage_id` | string | Да | ID стадии пайплайна |
| `attempt` | number | Да | Номер попытки выполнения (начинается с 1) |
| `step_id` | string | Да | Уникальный идентификатор шага: `{ticket_id}_{stageId}_{attempt}` |
| `status` | string | Да | Текущий статус: `pending`, `approved`, `rejected`, `timeout` |
| `created_at` | ISO8601 | Да | Время создания записи |
| `updated_at` | ISO8601 | Да | Время последнего обновления |
| `expires_at` | ISO8601 | Нет | Время истечения срока действия (для `pending`) |
| `reviewer_id` | string | Нет | ID ревьюера (для `approved`/`rejected`) |
| `comment` | string | Нет | Комментарий ревьюера (для `approved`/`rejected`) |

## Поле `step_id`

Формат: `{ticket_id}_{stageId}_{attempt}`

Пример: `IMPL-001_review_1`

Поле вычисляется runner'ом детерминированно на основе:
- `ticket_id` — идентификатор тикета
- `stageId` — идентификатор стадии (например, `review`, `qa`, `deploy`)
- `attempt` — номер попытки (инкрементируется при каждой повторной отправке)

## Lifecycle статуса

### pending → approved

Шаг ожидает подтверждения. При положительном решении ревьюера статус меняется на `approved`.

```json
{
  "ticket_id": "IMPL-001",
  "stage_id": "review",
  "attempt": 1,
  "step_id": "IMPL-001_review_1",
  "status": "pending",
  "created_at": "2026-04-30T10:00:00.000Z",
  "updated_at": "2026-04-30T10:05:00.000Z",
  "expires_at": "2026-04-30T18:00:00.000Z"
}
```

```json
{
  "ticket_id": "IMPL-001",
  "stage_id": "review",
  "attempt": 1,
  "step_id": "IMPL-001_review_1",
  "status": "approved",
  "created_at": "2026-04-30T10:00:00.000Z",
  "updated_at": "2026-04-30T12:30:00.000Z",
  "reviewer_id": "user-123",
  "comment": "Код соответствует стандартам, можно мержить"
}
```

### pending → rejected

Шаг ожидает подтверждения. При отрицательном решении ревьюера статус меняется на `rejected`.

```json
{
  "ticket_id": "IMPL-001",
  "stage_id": "review",
  "attempt": 1,
  "step_id": "IMPL-001_review_1",
  "status": "rejected",
  "created_at": "2026-04-30T10:00:00.000Z",
  "updated_at": "2026-04-30T12:25:00.000Z",
  "reviewer_id": "user-456",
  "comment": "Требуется исправить: нарушены принципы SOLID в модуле X"
}
```

### pending → timeout

Шаг ожидает подтверждения, но срок истёк (не был обработан в рамках `expires_at`).

```json
{
  "ticket_id": "IMPL-001",
  "stage_id": "review",
  "attempt": 1,
  "step_id": "IMPL-001_review_1",
  "status": "timeout",
  "created_at": "2026-04-30T10:00:00.000Z",
  "updated_at": "2026-04-30T18:01:00.000Z",
  "comment": "Срок ожидания истек, ревью не было проведено"
}
```

## Возобновление после rejection/timeout

При статусе `rejected` или `timeout` runner создаёт новую запись с увеличенным `attempt` (`+1`). Новый `step_id` формируется с обновлённым номером попытки.

Пример пересоздания после rejection:

```json
{
  "ticket_id": "IMPL-001",
  "stage_id": "review",
  "attempt": 2,
  "step_id": "IMPL-001_review_2",
  "status": "pending",
  "created_at": "2026-04-30T18:30:00.000Z",
  "updated_at": "2026-04-30T18:35:00.000Z",
  "expires_at": "2026-05-01T10:00:00.000Z"
}
```

## Примечания

- Approval-файл хранится в `${stateDir}/approvals/{ticket_id}_{stage_id}.json`
- Runner гарантирует атомарность обновлений (race-free запись)
- Формат неизменяем (backward compatibility); при необходимости расширения добавляются новые опциональные поля
