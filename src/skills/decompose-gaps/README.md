# decompose-gaps

Скил декомпозиции недочётов (gaps) из анализа отчёта в атомарные тикеты на доработку.

## Структура

```
decompose-gaps/
├── SKILL.md                        # Ядро: роль, маршрутизация, принципы
├── README.md                       # Документация
├── workflows/
│   └── decompose.md                # Пошаговый алгоритм декомпозиции gaps
├── knowledge/
│   └── scope-validation.md         # 4 проверки scope, критерии валидности gap
└── algorithms/
    └── scope-check.md              # Формализованный алгоритм проверки scope
```

## Как это работает

1. Получает на вход `gaps`, `report_id`, `plan_id` из context
2. Загружает knowledge/scope-validation.md и algorithms/scope-check.md
3. Запускает workflows/decompose.md
4. Для каждого gap выполняет 4 проверки scope (источник → принадлежность → статус плана → workflow-управление)
5. Gaps в scope → тикеты в `.workflow/tickets/backlog/`
6. Gaps вне scope → секция «Новые требования (вне scope)»

## Как расширять

### Добавить новое правило валидации scope
1. Добавь правило в `knowledge/scope-validation.md` после маркера `<!-- РАСШИРЕНИЕ -->`
2. Добавь соответствующий шаг в `algorithms/scope-check.md` после маркера `<!-- РАСШИРЕНИЕ -->`

### Добавить новый граничный случай
1. Добавь строку в таблицу «Граничные случаи» в `algorithms/scope-check.md`

### Добавить новый воркфлоу
1. Создай файл в `workflows/`
2. Добавь строку в таблицу маршрутизации в `SKILL.md`
