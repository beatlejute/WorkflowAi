# Coach — Модульный скилл на рельсах

Мета-скил для создания, аудита, анализа, улучшения и перевода на рельсы других скилов. Обрабатывает тикеты `COACH-*` и ad-hoc запросы стейкхолдера. Носитель концепции «Рельсы для агента»: все скилы проекта приводятся к ней только через коуча.

## Структура

```
coach/
├── SKILL.md                          # Граф ядра: этапы П0 (вход, правила, маршрутизация) … П8 (отчёт)
├── rails.yaml                        # Гарды коуча (H1 область записи, H2 git, H3 действие-по-этапу, H4 потолки, H5 выход)
├── rails-migration.yaml              # Карта переноса фраз-инвариантов из прозаической формы (конверсия 2026-09-22)
├── workflows/                        # Фрагменты графа — ветки: create (П10), audit (П20), analyze (П30),
│                                     # improve (П40), research (П50), review (П60), convert (П70)
├── knowledge/                        # rails-concept, skill-anatomy, common-antipatterns, prompt-engineering,
│                                     # backlog-management, incident-analysis, test-authorship
├── algorithms/                       # graph-conversion, rails-compliance, skill-scoring, gap-analysis,
│                                     # improvement-prioritization
├── templates/                        # new-skill (графовая форма), audit-report, improvement-plan, coach-backlog-init
├── tests/                            # index.yaml, cases/, rubrics/, fixtures/, rails/ (тесты гардов)
└── README.md
```

## Как это работает

1. Агент входит в П0: канарейка живости, чтение бэклога и shared, выбор ветки в Q-узле по триггерам тикета или ad-hoc запроса.
2. Ветка (фрагмент `workflows/<type>.md`) ведёт к ядру: П1 evidence → П2 root cause → П3 черновик (чеклисты) → П4 правка (только `.workflow/src/skills/`) → П5 тест (runner) → П6 бэклог → П7 ГЛАВНОЕ ПРАВИЛО → П8 отчёт и остановка.
3. Каждый переход объявляется цитатой узла (`node .workflow/src/rails/cli.mjs goto <узел> --quote "…"`), хуки rails отклоняют действия вне своего этапа и вне области записи; журнал отказов — вход для ANALYZE.
4. Справочники (knowledge, algorithms, templates) загружаются узлами графа по триггеру.

## Типичные сценарии

| Задача | Ветка |
|--------|-------|
| Создать скил для новой роли (сразу в графовой форме) | `workflows/create.md` (П10) |
| Полный аудит скила, включая соответствие рельсам | `workflows/audit.md` (П20) |
| Анализ эффективности по тикетам, логам и журналу отказов | `workflows/analyze.md` (П30) |
| Точечное улучшение | `workflows/improve.md` (П40) |
| Поиск лучших практик | `workflows/research.md` (П50) |
| Ревью структуры и качества | `workflows/review.md` (П60) |
| Перевод прозаического скила на рельсы | `workflows/convert.md` (П70) |
| Разбор инцидента, «почему не поймали?» | ядро с П1 |

## Как расширять

| Что добавить | Действия |
|-------------|----------|
| Новая ветка | Фрагмент `workflows/type.md` с этапом П{N}0 + ребро из P0Q1 с триггерами |
| Новое правило | `R`-узел в нужном этапе с датой и ценой инцидента; проза не добавляется |
| Новый гард | Запись в `rails.yaml` + тест в `tests/rails/` — только по инциденту; для гардов самого коуча — правка человеком |
| Новые знания | `knowledge/name.md` + узел загрузки с условием |
| Новый алгоритм | `algorithms/name.md` + узел загрузки |
| Новый шаблон | `templates/name.md` + ссылка в узле |
| Расширение модуля | Дописать после маркера `<!-- РАСШИРЕНИЕ -->` |

Проверка после любой правки: `node .workflow/src/scripts/check-rails-graph.js --skill coach`, затем `run-skill-tests.js --skill coach`.
