# Deep Research — Agent Skill

Агент-исследователь для глубокого анализа тем. Получает задачи на исследование от других скилов и формирует структурированные текстовые отчёты с данными, источниками и выводами.

## Структура

```
deep-research/
├── SKILL.md              # Ядро: роль, маршрутизация, принципы
├── workflows/            # market, competitor, trend, benchmark, technology, custom, base-checklist
├── knowledge/            # research-methodology, source-evaluation, data-validation, perplexity-config
├── algorithms/           # source-scoring, synthesis
└── templates/            # research-report, brief-summary
```

## Как это работает

1. Любой скил проекта создаёт тикет `RSH-*` с исследовательским вопросом
2. Deep Research определяет тип (MARKET/COMPETITOR/TREND/BENCHMARK/TECHNOLOGY/CUSTOM)
3. Загружает соответствующий workflow
4. Проводит исследование: поиск → фильтрация → анализ → синтез
5. Формирует отчёт с источниками, уровнями уверенности, выводами

## Как расширять

### Новый тип исследования
1. Создай файл в `workflows/{type}.md`
2. Добавь запись в таблицу маршрутизации в `SKILL.md`

### Новый knowledge-модуль
1. Создай файл в `knowledge/{module}.md`
2. Добавь запись в таблицу загрузки знаний в `SKILL.md`

### Новый шаблон вывода
1. Создай файл в `templates/{template}.md`
2. Добавь запись в таблицу шаблонов в `SKILL.md`
