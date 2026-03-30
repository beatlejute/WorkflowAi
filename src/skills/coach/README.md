# Coach — Модульный скилл

Мета-скил для создания, аудита и совершенствования других скилов. Обрабатывает тикеты `COACH-*`.

## Структура

```
coach/
├── SKILL.md                          # Ядро: роль, маршрутизация, принципы
├── workflows/                        # CREATE, AUDIT, ANALYZE, IMPROVE, RESEARCH, REVIEW
├── knowledge/                        # skill-anatomy, common-antipatterns, prompt-engineering,
│                                     # backlog-management, shared-knowledge-guide
├── algorithms/                       # skill-scoring, gap-analysis, improvement-prioritization
├── templates/                        # new-skill, audit-report, improvement-plan
└── README.md
```

## Как это работает

1. Агент получает `COACH-*` тикет → **SKILL.md** определяет тип → подгружает **workflow**
2. Воркфлоу ссылается на **knowledge** и **algorithms** по необходимости
3. Результат оформляется по **template**

## Типичные сценарии

| Задача | Воркфлоу |
|--------|----------|
| Создать скил для новой роли | `workflows/create.md` |
| Полный аудит скила | `workflows/audit.md` |
| Анализ эффективности по тикетам | `workflows/analyze.md` |
| Точечное улучшение | `workflows/improve.md` |
| Поиск лучших практик | `workflows/research.md` |
| Ревью структуры и качества | `workflows/review.md` |

## Как расширять

| Что добавить | Действия |
|-------------|----------|
| Новый тип тикета | Создать `workflows/type.md` + строка в маршрутизации SKILL.md |
| Новые знания | Создать `knowledge/name.md` + строка в таблице загрузки SKILL.md |
| Новый алгоритм | Создать `algorithms/name.md` + строка в таблице загрузки SKILL.md |
| Новый шаблон | Создать `templates/name.md` + ссылка в воркфлоу |
| Расширение модуля | Дописать после маркера `<!-- РАСШИРЕНИЕ -->` |
