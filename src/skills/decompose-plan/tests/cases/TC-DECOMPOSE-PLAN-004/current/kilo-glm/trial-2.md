Let me explore the project structure and load the required knowledge modules.
Let me read the test case and some reference materials.
Now I have all the context needed. Let me perform the decomposition following the workflow.

## 1. Чтение плана

**План (inline):** Реализовать функцию buildTargetPrompt() в runner'е

**DoD плана:**
1. Функция buildTargetPrompt() реализована в src/scripts/run-skill-tests.js
2. Юнит-тест TC-PROMPT-001 написан и зелёный
3. README обновлён разделом про prompt assembly
4. Коммит feat(runner): buildTargetPrompt создан

**Контекст проекта:** task_types: IMPL (реализация кода), QA (написание автотестов), DOCS (обновление документации), ADMIN (инфраструктурные операции). Git-операции выполняет стейкхолдер.

## 2. Маршрутизация по объекту работы (Проверка 7 — executor-атомарность)

Для каждого пункта DoD определяю тип по `config.yaml → task_types`:

| Пункт DoD | Объект работы | Тип по маршрутизации | Исполнитель |
|-----------|---------------|---------------------|-------------|
| Функция buildTargetPrompt() реализована в src/scripts/run-skill-tests.js | Код (src/scripts/) | IMPL | agent |
| Юнит-тест TC-PROMPT-001 написан и зелёный | Автотесты | QA | agent |
| README обновлён разделом про prompt assembly | Документация | DOCS | agent |
| Коммит feat(runner): buildTargetPrompt создан | Git-операция | — | стейкхолдер |

Ответы расходятся (IMPL, QA, DOCS, стейкхолдер) → Проверка 7 FAIL для единого тикета.

## 3. Атомарность — исходный тикет-кандидат

```
Тикет-кандидат: «Реализовать функцию buildTargetPrompt() в runner'е»
| Проверка | Результат | Evidence / Действие |
|----------|-----------|---------------------|
| 1. Одна задача | FAIL | DoD содержит 4 глагола: «реализовать», «написать», «обновить», «создать» |
| 2. Один объект | FAIL | Файлы: src/scripts/run-skill-tests.js, тестовый файл, README.md — разные подсистемы |
| 3. Один результат | FAIL | DoD: 4 несвязанных критерия (реализация, тест, документация, коммит) |
| 4. Нет скрытых подзадач | FAIL | 4 независимых шага (реализация, тестирование, документация, коммит — параллельны) |
| 5. Размер | FAIL | Реализация + тесты + документация > 200 строк |
| 6. Независимая верификация | FAIL | Тест и документация зависят от реализации |
| 7. Один исполнитель | FAIL | DoD-пункты маршрутизируются: IMPL, QA, DOCS, стейкхолдер — 4 разных типа |
→ Решение: РАЗБИТЬ на 3 тикета (IMPL, QA, DOCS). Git-операцию удалить из DoD — стейкхолдер.
```

## 4. Атомарность — тикет IMPL

```
Тикет-кандидат: «Реализовать функцию buildTargetPrompt() в src/scripts/run-skill-tests.js»
| Проверка | Результат | Evidence / Действие |
|----------|-----------|---------------------|
| 1. Одна задача | PASS | Title: «Реализовать функцию buildTargetPrompt()» — один глагол «реализовать» |
| 2. Один объект | PASS | Файлы: src/scripts/run-skill-tests.js. Один модуль runner'а. Правки блока A (buildTargetPrompt) не могут быть применены без блока B — неделимая логика |
| 3. Один результат | PASS | DoD: 1 пункт — «Функция buildTargetPrompt() реализована в src/scripts/run-skill-tests.js». Проверяется одним действием (импорт/вызов) |
| 4. Нет скрытых подзадач | PASS | Шаги: 1. Написать тело функции. Зависимость: цепочка (нет параллельных шагов) |
| 5. Размер | PASS | Одна функция, ожидаемо < 100 строк |
| 6. Независимая верификация | PASS | Функция проверяется импортом и вызовом, не требует других тикетов |
| 7. Один исполнитель | PASS | Все DoD маршрутизируются в IMPL (реализация кода) |
→ Решение: СОЗДАТЬ
```

## 5. Атомарность — тикет QA

```
Тикет-кандидат: «Написать юнит-тест TC-PROMPT-001 для buildTargetPrompt()»
| Проверка | Результат | Evidence / Действие |
|----------|-----------|---------------------|
| 1. Одна задача | PASS | Title: «Написать юнит-тест TC-PROMPT-001 для buildTargetPrompt()» — один глагол «написать» |
| 2. Один объект | PASS | Файлы: тестовый файл для buildTargetPrompt. Одна suite тестов |
| 3. Один результат | PASS | DoD: 1 пункт — «Юнит-тест TC-PROMPT-001 написан и зелёный». Проверяется одной командой (test runner) |
| 4. Нет скрытых подзадач | PASS | Шаги: 1. Написать тест-кейс, 2. Запустить и убедиться что зелёный. Зависимость: шаг 2 требует шаг 1 (цепочка) |
| 5. Размер | PASS | Один тест-кейс, ожидаемо < 100 строк |
| 6. Независимая верификация | PASS | Тест проверяется запуском test runner'а, независимо от DOCS-тикета |
| 7. Один исполнитель | PASS | Все DoD маршрутизируются в QA (написание автотестов) |
→ Решение: СОЗДАТЬ (dependencies: [IMPL])
```

## 6. Атомарность — тикет DOCS

```
Тикет-кандидат: «Обновить README разделом про prompt assembly»
| Проверка | Результат | Evidence / Действие |
|----------|-----------|---------------------|
| 1. Одна задача | PASS | Title: «Обновить README разделом про prompt assembly» — один глагол «обновить» |
| 2. Один объект | PASS | Файлы: README.md. Один файл документации |
| 3. Один результат | PASS | DoD: 1 пункт — «README обновлён разделом про prompt assembly». Проверяется визуальным осмотром |
| 4. Нет скрытых подзадач | PASS | Шаги: 1. Добавить раздел про prompt assembly. Один шаг |
| 5. Размер | PASS | Один раздел документации, ожидаемо < 100 строк |
| 6. Независимая верификация | PASS | README проверяется визуально, независимо от QA-тикета |
| 7. Один исполнитель | PASS | Все DoD маршрутизируются в DOCS (обновление документации) |
→ Решение: СОЗДАТЬ (dependencies: [IMPL])
```

## 7. Scope-guard

| Проверка | IMPL | QA | DOCS |
|----------|------|-----|------|
| 1. Принадлежность к scope | PASS — задача из плана | PASS — задача из плана | PASS — задача из плана |
| 2. Связь с задачами плана | PASS — декомпозиция пункта DoD 1 | PASS — декомпозиция пункта DoD 2 | PASS — декомпозиция пункта DoD 3 |
| 3. Критерии успеха | PASS — необходима для функции | PASS — необходима для валидации | PASS — необходима для документирования |
| 4. Горизонт плана | PASS | PASS | PASS |
| 5. Не дублирует пайплайн | PASS | PASS | PASS |

## 8. Дедупликация

Сканирование `.workflow/tickets/` — папка не содержит существующих тикетов (backlog/, ready/, in-progress/, blocked/, review/, done/, archive/ — пусты).

| Тикет | Найдено дубликатов | Решение |
|-------|--------------------|---------|
| IMPL | 0 | CREATE |
| QA | 0 | CREATE |
| DOCS | 0 | CREATE |

## 9. СТОП-ГЕЙТ 9.B: id_ranges_json

На входе стадии отсутствует параметр `id_ranges_json`. Согласно workflow (шаг 9.B), это инфраструктурная ошибка: стадия `allocate-ticket-ids` не была запущена или не передала диапазоны.

**СТОП.** Невозможно создать файлы тикетов без выделенных ID-диапазонов.

Для демонстрации результата декомпозиции привожу проект тикетов ниже. Фактическое создание файлов требует повторного запуска с корректным `id_ranges_json`.

---

### Проект тикета IMPL-{NNN}

```yaml
id: IMPL-{NNN}
title: "Реализовать функцию buildTargetPrompt() в src/scripts/run-skill-tests.js"
type: impl
executor_type: agent
priority: 2
dependencies: []
conditions: []
required_capabilities: []
parent_plan: inline
```

## Описание

Реализовать функцию `buildTargetPrompt()` в файле `src/scripts/run-skill-tests.js`. Функция собирает целевой промпт для runner'а на основе параметров запуска.

## Детали задачи

1. Определить сигнатуру функции `buildTargetPrompt()` в модуле `src/scripts/run-skill-tests.js`
2. Реализовать логику сборки промпта
3. Экспортировать функцию для использования в runner'е

## Definition of Done

- [ ] Функция buildTargetPrompt() реализована в src/scripts/run-skill-tests.js

---

### Проект тикета QA-{NNN}

```yaml
id: QA-{NNN}
title: "Написать юнит-тест TC-PROMPT-001 для buildTargetPrompt()"
type: qa
executor_type: agent
priority: 2
dependencies: ["IMPL-{NNN}"]
conditions: []
required_capabilities: []
parent_plan: inline
```

## Описание

Написать юнит-тест TC-PROMPT-001, проверяющий корректность работы функции `buildTargetPrompt()`.

## Детали задачи

1. Создать тестовый файл для функции `buildTargetPrompt()`
2. Реализовать тест-кейс TC-PROMPT-001
3. Убедиться, что тест проходит (зелёный)

## Definition of Done

- [ ] Юнит-тест TC-PROMPT-001 написан и зелёный

---

### Проект тикета DOCS-{NNN}

```yaml
id: DOCS-{NNN}
title: "Обновить README разделом про prompt assembly"
type: docs
executor_type: agent
priority: 3
dependencies: ["IMPL-{NNN}"]
conditions: []
required_capabilities: []
parent_plan: inline
```

## Описание

Добавить в README.md проекта раздел, описывающий механизм prompt assembly в runner'е.

## Детали задачи

1. Добавить раздел про prompt assembly в README.md
2. Описать назначение и использование функции `buildTargetPrompt()`

## Definition of Done

- [ ] README обновлён разделом про prompt assembly

---

### Удалено из DoD (стейкхолдер)

| Пункт | Причина удаления |
|-------|-----------------|
| Коммит feat(runner): buildTargetPrompt создан | Git-операция (commit) выполняется стейкхолдером, не агентом-исполнителем |

### Зависимости

```
IMPL-{NNN}  ←  QA-{NNN}
IMPL-{NNN}  ←  DOCS-{NNN}
```

### Рекомендации для следующего плана (вне scope)

Нет — все задачи плана покрыты тикетами.

---

```
---RESULT---
status: default
notes: "id_ranges_json не предоставлен. Тикеты спроектированы, но не записаны в файлы. Требуется повторный запуск с allocate-ticket-ids."
decomposition:
  tickets_created: 3
  tickets:
    - prefix: IMPL
      title: "Реализовать функцию buildTargetPrompt() в src/scripts/run-skill-tests.js"
      dependencies: []
    - prefix: QA
      title: "Написать юнит-тест TC-PROMPT-001 для buildTargetPrompt()"
      dependencies: [IMPL]
    - prefix: DOCS
      title: "Обновить README разделом про prompt assembly"
      dependencies: [IMPL]
  dod_items_removed:
    - item: "Коммит feat(runner): buildTargetPrompt создан"
      reason: "git-операция — стейкхолдер, не агент"
  ids_allocated_from: {}
---RESULT---
```
