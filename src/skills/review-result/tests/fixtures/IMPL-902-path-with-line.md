---
id: IMPL-902
title: "Исправить парсинг URL в фоновом скрипте"
priority: 3
type: impl
required_capabilities: []
created_at: "2026-04-19T00:00:00Z"
updated_at: "2026-04-19T00:00:00Z"
completed_at: "2026-04-19T00:00:00Z"
parent_plan: ""
parent_task: ""
dependencies: []
conditions: []
context:
  files: []
  references: []
  notes: |
    Сценарий для регрессионного теста скила review-result (TC-REVIEW-RESULT-002).
    ⚠️ Workdir изолированный: настоящего src/background/index.ts здесь нет —
    путь указан в отраслевой нотации path:line-range, корректное поведение
    ревьюера должно учитывать этот формат и не помечать файл как missing.
complexity: simple
tags:
  - impl
---

## Описание

Исправить парсинг URL-параметра `redirect_to` в обработчике сообщений фонового скрипта.

## Критерии готовности

- [x] Парсер обрабатывает URL с query string без потери параметров
- [x] Добавлен unit-тест на edge-case с пустым `redirect_to`

## Изменённые файлы

- src/background/index.ts:204-211

## Result

Логика парсинга вынесена в отдельную функцию, добавлен тест.
Все пункты DoD выполнены.
