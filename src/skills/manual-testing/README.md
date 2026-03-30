# Manual Testing — Agent Skill

Скил тестировщика (QA-инженера) для проведения ручного и полуавтоматического тестирования веб-приложений и desktop-приложений (VSCode-расширения, Electron и др.) через браузер и desktop-инструменты.

## Структура

```
manual-testing/
├── SKILL.md                              # Ядро: роль, маршрутизация, принципы
├── README.md                             # Документация
├── workflows/
│   ├── smoke.md                          # Smoke-тестирование после деплоя
│   ├── regression.md                     # Регрессионное тестирование
│   ├── exploratory.md                    # Исследовательское тестирование
│   ├── acceptance.md                     # Приёмочное тестирование по AC
│   └── test-plan.md                      # Создание тест-плана и тест-кейсов
├── knowledge/
│   ├── testing-types.md                  # Типы и подходы к тестированию
│   ├── browser-tools.md                  # Инструменты работы с браузером (Playwright MCP)
│   ├── desktop-tools-core.md              # Desktop-инструменты: core (Click, Type, Screenshot, Scrape, навигация)
│   ├── desktop-tools-advanced.md          # Desktop-инструменты: advanced (Snapshot, MultiEdit, Registry, Process)
│   ├── test-case-design.md              # Техники проектирования тест-кейсов
│   ├── sandbox-core.md                 # Sandbox: quick-start, evidence persistence, ограничения
│   └── sandbox-advanced.md             # Sandbox: .wsb конфиг, MCP disconnect, continuation
├── algorithms/
│   ├── test-prioritization.md            # Приоритизация тест-кейсов
│   └── bug-severity.md                   # Определение severity/priority бага
└── templates/
    ├── test-case.md                      # Шаблон тест-кейса
    ├── bug-report.md                     # Шаблон баг-репорта
    ├── test-plan.md                      # Шаблон тест-плана
    └── test-session-report.md            # Шаблон отчёта о сессии
```

## Как это работает

1. Скил получает тикет `QA-*` с запросом на тестирование
2. По триггерам определяет тип (SMOKE, REGRESSION, EXPLORATORY, ACCEPTANCE, TEST-PLAN)
3. Загружает соответствующий воркфлоу из `workflows/`
4. Подгружает knowledge/algorithms по мере необходимости
5. Выполняет тестирование через браузер (Playwright MCP) или desktop-инструменты (Windows-MCP)
6. Формирует результат по шаблонам из `templates/`
7. При обнаружении багов — создаёт баг-репорты

## Как расширять

### Добавить новый тип тестирования
1. Создай воркфлоу в `workflows/{type}.md`
2. Добавь маршрут в таблицу маршрутизации в `SKILL.md`
3. Создай шаблон вывода в `templates/` если нужен

### Добавить knowledge
1. Создай файл в `knowledge/{topic}.md`
2. Добавь ссылку в таблицу «Загрузка знаний» в `SKILL.md`
3. Добавь маркер `<!-- РАСШИРЕНИЕ: -->` для будущего обогащения

### Добавить алгоритм
1. Создай файл в `algorithms/{algo}.md` с секциями: Вход, Алгоритм, Выход, Пример
2. Добавь ссылку в таблицу «Загрузка алгоритмов» в `SKILL.md`

### Добавить шаблон
1. Создай файл в `templates/{template}.md`
2. Добавь ссылку в таблицу «Шаблоны вывода» в `SKILL.md`
