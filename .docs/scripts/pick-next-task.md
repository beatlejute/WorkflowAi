# Pick-next-task

Описание скрипта для выбора следующего human-доступного тикета в очереди workflow-ai.

## Определение статуса `human_ready`

.Status `human_ready` устанавливается когда:
- Список eligible non-human тикетов пуст
- Существует созревший human-тикет (все зависимости выполнены + условия проверены)

## Формат ответа
```json
{
  "status": "human_ready",
  "ticket_id": "DOCS-17",
  "priority": 3,
  "title": "Создать API-документацию",
  "pending_count": 1
}
```

## Поля ответа
- `pending_count`: общее число созревших human-тикетов (>= 1)

## nuovo (updated fields)
- Добавлено поле `pending_count` во всех ответах human_ready
- Уточнены условия активации статуса с учетом `pending_count`

## Побочные эффекты
- Обновление состояния очередь тикетов в `workflow/`
- Запуск уведомлений о готовом тикете

## Формат вызова
```bash
node pick-next-task.js [OPTIONS]
```