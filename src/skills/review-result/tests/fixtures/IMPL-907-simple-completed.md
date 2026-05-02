---
id: IMPL-907
title: "Добавить функцию форматирования даты"
priority: 3
type: impl
required_capabilities: []
created_at: "2026-05-01T00:00:00Z"
updated_at: "2026-05-01T12:00:00Z"
completed_at: "2026-05-01T12:00:00Z"
parent_plan: ""
parent_task: ""
dependencies: []
conditions: []
context:
  files: []
  references: []
  notes: "Фикстура для TC-REVIEW-RESULT-006 — проверка 4-колоночного формата секции ревью."
complexity: simple
tags:
  - impl
---

## Описание

Добавить утилиту `formatDate(date)` в модуль `src/utils/date.ts`.

## Критерии готовности

- [x] Функция `formatDate` принимает `Date` и возвращает строку `YYYY-MM-DD`
- [x] Добавлен unit-тест на edge-case (невалидная дата)

## Result

### Что сделано

Добавлена функция `formatDate` в `src/utils/date.ts`. Написан unit-тест `formatDate.spec.ts` с 2 сценариями: валидная дата и `Invalid Date`.

### Изменённые файлы

- src/utils/date.ts
- src/utils/formatDate.spec.ts

### Заметки

- Функция использует `toISOString().slice(0, 10)` для нормализации формата.
