## Анализ плана

**capabilities_registry** (union из `pipeline.yaml → agents.*.capabilities`):
- `text`
- `multimodal`

Других ключей в конфиге нет. Все тикеты ниже назначают `required_capabilities` только из этого списка.

---

## Дедупликация (сканирование всех папок tickets/)

Перед созданием тикетов провожу сканирование по каждому пункту DoD:

| DoD | Кандидат на тикет | Найденный дубль | Папка | Решение |
|-----|-------------------|-----------------|-------|---------|
| 1. Создать `select-default-proxy-modal.ts` | IMPL-??? | **IMPL-043** "Создать компонент select-default-proxy-modal.ts" | `blocked/` | **SKIP** |
| 2. Добавить i18n-ключ `selectDefaultProxyTitle` | IMPL-??? | **IMPL-044** "Добавить i18n-ключ selectDefaultProxyTitle в 8 locale-файлов" | `blocked/` | **SKIP** |
| 3. Юнит-тесты для модалки зелёные | QA-??? | **QA-091** "Юнит-тесты TC-Modal-1..4 для select-default-proxy-modal" | `backlog/` | **SKIP** |

### Обоснование решений

**IMPL-043 → SKIP.** Тикет существует в `blocked/` — не выполнен (verify-artifacts: результат пуст, 0/7 DoD). Scope совпадает на 100%. По алгоритму дедупликации: blocked + тот же scope → разблокировать, не дублировать.

**IMPL-044 → SKIP.** Аналогично: `blocked/`, результат не заполнен (0/4 DoD). Полное совпадение scope (те же 8 locale-файлов, тот же ключ `selectDefaultProxyTitle`). Решение: разблокировать.

**QA-091 → SKIP.** Тикет в `backlog/`, ещё не выполнялся. Scope: TC-Modal-1..4 для `select-default-proxy-modal` — полное совпадение с DoD 3. Зависит от IMPL-043 и IMPL-047 (guard пустого списка).

---

## Результат декомпозиции

**Новых тикетов создано: 0.**

Все три пункта DoD плана уже покрыты существующими тикетами:

| Пункт DoD | Тикет | Статус | Действие |
|-----------|-------|--------|----------|
| Компонент `select-default-proxy-modal.ts` создан | IMPL-043 | blocked | Разблокировать и повторно выполнить |
| Ключ i18n `selectDefaultProxyTitle` добавлен в locale-файлы | IMPL-044 | blocked | Разблокировать и повторно выполнить |
| Юнит-тесты для модалки зелёные | QA-091 | backlog | Ждёт IMPL-043 + IMPL-047 |

> **Примечание:** IMPL-043 и IMPL-044 заблокированы по причине `verify-artifacts: секция Result пуста` — агент выполнил (или попытался выполнить) задачу, но не заполнил секцию результата. Пайплайн разблокирует их и отправит на повторное выполнение. Создание дублирующих тикетов было бы ошибкой.

---

---RESULT---

```
status: completed
tickets_created: 0
skipped:
  - id: IMPL-043
    reason: "Тикет существует в blocked/ — полное совпадение scope (создание select-default-proxy-modal.ts). Разблокировать, не дублировать."
  - id: IMPL-044
    reason: "Тикет существует в blocked/ — полное совпадение scope (i18n-ключ selectDefaultProxyTitle в 8 locale-файлах). Разблокировать, не дублировать."
  - id: QA-091
    reason: "Тикет существует в backlog/ — полное совпадение scope (юнит-тесты TC-Modal-1..4 для модалки). Уже в очереди."
```
