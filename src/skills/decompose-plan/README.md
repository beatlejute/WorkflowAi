# decompose-plan

Скил декомпозиции высокоуровневых планов в атомарные тикеты для канбан-доски.

## Структура

```
decompose-plan/
├── SKILL.md                        # Ядро: роль, маршрутизация, принципы
├── README.md                       # Документация
├── workflows/
│   └── decompose.md                # Пошаговый алгоритм декомпозиции плана
├── knowledge/
│   ├── human-task-rules.md         # Правила создания HUMAN-тикетов
│   └── scope-guard-checklist.md    # Чеклист scope-guard (4 проверки)
└── algorithms/
    └── deduplication.md            # Алгоритм проверки на дубликаты
```

## Как это работает

1. Получает путь к плану из Instructions промпта
2. Загружает knowledge/scope-guard-checklist.md и algorithms/deduplication.md
3. Запускает workflows/decompose.md
4. Для каждой задачи плана: определяет тип по объекту работы, оценивает автономность (agent/human)
5. Проходит scope-guard (4 проверки) и дедупликацию
6. Создаёт тикеты в `.workflow/tickets/backlog/`
7. Обновляет план ссылками на тикеты

## Как расширять

### Добавить новое правило scope-guard
1. Добавь проверку в `knowledge/scope-guard-checklist.md` после маркера `<!-- РАСШИРЕНИЕ -->`

### Добавить новый критерий HUMAN-задачи
1. Добавь строку в таблицу критериев в `knowledge/human-task-rules.md` после маркера `<!-- РАСШИРЕНИЕ -->`

### Добавить правило дедупликации
1. Добавь граничный случай в `algorithms/deduplication.md` после маркера `<!-- РАСШИРЕНИЕ -->`

### Добавить новый воркфлоу
1. Создай файл в `workflows/`
2. Добавь строку в таблицу маршрутизации в `SKILL.md`
