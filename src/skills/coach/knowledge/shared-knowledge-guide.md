# Shared Knowledge — межскиловые знания

Когда knowledge-модуль нужен 2+ скилам — он выносится в `skills/shared/`.

## Структура

```
skills/
├── shared/               # Проектно-специфичные знания, общие для нескольких скилов
│   ├── README.md         # Индекс: таблица модулей с описанием и списком потребителей
│   └── module.md
├── skill-a/
└── skill-b/
```

## README.md — обязательный индекс

```markdown
# Shared Knowledge Modules

| Модуль | Описание | Используется в |
|--------|----------|----------------|
| `module-name.md` | Что содержит | skill-a, skill-b |
```

## Правила

| Правило | Описание |
|---------|----------|
| **Критерий выноса** | Контент используется 2+ скилами с пересечением 70%+ |
| **Скилы — универсальные, shared — проектный** | Скилы переносятся между проектами as-is. Shared содержит проектно-специфичные знания |
| **Ссылка из скила — через glob** | В таблице загрузки: `.workflow/src/skills/shared/*` → «проверь индекс, загрузи релевантные». Не хардкодить имена модулей |
| **Path resolution — project-relative, не SKILL-relative** | Шилы могут быть подключены в проект как символические ссылки/junctions на canonical-каталог скилов. Если скил вычисляет путь к shared через `..` от собственной location (`<skill-dir>/../shared/`), на Windows symlinks/junctions это резолвится через realpath в canonical-каталог скилов, где `shared/` отсутствует (`shared/` живёт в проекте). Поэтому **всегда используй project-relative путь**: `.workflow/src/skills/shared/<file>` от корня проекта. Не пиши `../shared/<file>` в SKILL.md/workflow — это ломается под symlink-deployment. |
| **Domain-контекст — в скиле** | Специфичная интерпретация shared-знаний остаётся в knowledge/workflows скила |

## Антипаттерны

| Антипаттерн | Как правильно |
|-------------|---------------|
| Дублировать данные в knowledge/ нескольких скилов | Вынести в shared/ |
| Хардкодить `.workflow/src/skills/shared/module.md` в SKILL.md | `.workflow/src/skills/shared/*` → проверить README |
| Класть в shared/ knowledge одного скила | Оставить в knowledge/ скила |
| Вкладывать shared/ в конкретный скил | shared/ — на одном уровне со скилами |
| Использовать `..`-relative путь к shared (`../shared/`) | Использовать project-relative `.workflow/src/skills/shared/`. Скилы могут быть symlinks/junctions; `..` резолвится через realpath не туда |

<!-- РАСШИРЕНИЕ: добавляй правила shared knowledge ниже -->
