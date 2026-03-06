---
# Шаблон тикета для универсальной системы координации агентов
# Скопируйте этот файл и заполните поля

id: "{TYPE}-{NNN}"              # IMPL-001, FIX-015, PLAN-003
title: "Название задачи"
priority: 3                      # 1-критический, 2-высокий, 3-средний, 4-низкий, 5-когда-нибудь

# Тип задачи
type: implementation             # planning | implementation | bugfix | review | documentation | admin

# Требования к агенту-исполнителю (для выбора подходящего инструмента)
required_capabilities: []
  # - code_generation        # Генерация кода
  # - code_editing           # Редактирование кода
  # - file_operations        # Работа с файлами
  # - debugging              # Отладка
  # - code_analysis          # Анализ кода
  # - documentation          # Написание документации
  # - strategic_thinking     # Стратегическое планирование
  # - typescript             # Знание TypeScript
  # - python                 # Знание Python

created_at: ""                   # ISO 8601: 2026-02-28T12:00:00Z
updated_at: ""                   # Обновляется при изменении
completed_at: ""                 # Заполняется при завершении

parent_plan: ""                  # Путь к плану: plans/current/plan-001.md
parent_task: ""                  # ID родительской задачи для подзадач

# Зависимости - задачи, которые должны быть выполнены ДО этой
dependencies: []
  # - IMPL-001
  # - PLAN-002

# Условия выполнения - все должны быть истинны для начала работы
conditions: []
  # - type: tasks_completed      # Все зависимости выполнены
  # - type: date_after           # После определённой даты
  #   value: "2026-03-01"
  # - type: file_exists          # Файл должен существовать
  #   value: "src/config.ts"
  # - type: manual_approval      # Требует ручного подтверждения

# Контекст - информация для агента-исполнителя
context:
  files: []                      # Файлы для работы
    # - src/api/routes.ts
    # - docs/api-spec.md
  references: []                 # Ссылки на документацию
    # - https://docs.example.com/api
  notes: ""                      # Дополнительные заметки

# Оценка сложности
complexity: medium               # simple | medium | complex

tags: []
  # - backend
  # - api
  # - refactoring
---

## Описание

<!-- Краткое описание того, что нужно сделать -->

## Детали задачи

<!-- Подробное описание с техническими деталями -->

## Критерии готовности (Definition of Done)

- [ ] Критерий 1
- [ ] Критерий 2
- [ ] Критерий 3

---

## Результат выполнения

<!-- Заполняется агентом-исполнителем после выполнения -->

### Summary

<!-- Краткое описание того, что было сделано -->

### Изменённые файлы

<!-- 
- `path/to/file1.ts` - описание изменений
- `path/to/file2.ts` - описание изменений 
-->

### Заметки для следующих задач

<!-- Важная информация для связанных задач -->

### Время выполнения

- Started: 
- Completed: 
- Agent used: <!-- Какой агент/инструмент использовался -->
