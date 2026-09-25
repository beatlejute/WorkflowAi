# Deep Research — Agent Skill

Агент-исследователь для глубокого анализа тем. Получает задачи на исследование от других скилов и формирует структурированные текстовые отчёты с данными, источниками и выводами.

Скил на рельсах: процедура — граф в `SKILL.md` (ядро) и `workflows/*.md` (ветки), соблюдение принуждается хуками по `rails.yaml`.

## Структура

```
deep-research/
├── SKILL.md              # Ядро графа: П0 роль и правила, П3 синтез и отчёт, П5 self-check, П9 результат
├── rails.yaml            # Гарды: область записи, потолки циклов, выходной слой
├── rails-migration.yaml  # Карта переноса прозы в граф (CONVERT 2026-09-25)
├── workflows/            # Ветки: market (П10), competitor (П20), trend (П30), benchmark (П40), technology (П50), custom (П60)
├── knowledge/            # research-methodology, source-evaluation, data-validation, perplexity-config
├── algorithms/           # source-scoring, synthesis
├── templates/            # research-report, brief-summary
├── scripts/              # perplexity-research.js
└── tests/                # кейсы L0/L2 (cases/, rubrics/), тесты гардов (rails/)
```

## Как это работает

1. Любой скил проекта создаёт тикет `RSH-*` с исследовательским вопросом
2. П0: роль и правила, загрузка методологии и конфигурации perplexity, выбор типа (MARKET/COMPETITOR/TREND/BENCHMARK/TECHNOLOGY/CUSTOM)
3. Ветка типа: скоуп → сбор данных → анализ
4. П3: синтез, отчёт по шаблону, валидация базового чеклиста
5. Дополнительная проверка ветки, П5 self-check, П9 результат

## Как расширять

Правки скила — через коуча (CONVERT/IMPROVE), с проверкой `check-rails-graph.js` и `check-rails-coverage.js`.

### Новый тип исследования
1. Создай фрагмент `workflows/{type}.md` со своим номером этапа: вход, шаги, гейт дополнительной проверки
2. Добавь рёбра из `P0Q1` (на вход ветки) и из `P3Q1` (на гейт ветки), потолок гейта — в `cycles` файла `rails.yaml`

### Новый knowledge-модуль или шаблон
1. Создай файл в `knowledge/`, `algorithms/` или `templates/`
2. Добавь триггер загрузки в лейбл узла графа, на котором модуль нужен
