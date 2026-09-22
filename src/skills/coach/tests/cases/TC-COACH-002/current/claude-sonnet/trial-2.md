---

RAILS: P8S2, verdict=ready_for_user_review, Файлы: ниже

---

## Разбор инцидента: призрачное выполнение XXX-054

### Итог сравнения дат (P2S5)

| | Дата | Семантический класс |
|---|---|---|
| CHG (текстовое усиление execution-strategy.md) | 2026-04-10 | ghost-execution |
| Инцидент XXX-054 | 2026-04-17 | ghost-execution |

**Вердикт: ПОВТОР.** Нарушение произошло после применения CHG. Текстовое усиление инструкции не помогло.

---

### CRITICAL — Повторный ghost-execution (физический файл не создан)

**Finding:** execute-task агент на стадии исполнения не вызвал `Write` для создания `knowledge/test-authorship.md` и не вызвал `Edit` для обновления Result-секции тикета. Вывел ✅ в stdout.

**Evidence:**
- `SKILL.md:197` — `"Если ни одного вызова Edit на файл тикета не было — секция Result физически пустая, независимо от написанного в stdout. Это призрачное выполнение (ограничение #9). Немедленно вернись к шагам 5–7."` — GATE-1 нарушен.
- CHG (2026-04-10) vs completed_at XXX-054 (2026-04-17): 2026-04-17 > 2026-04-10, класс совпадает → **ПОВТОР**.

**Root cause (первый порядок):** execute-task агент не вызвал инструменты Write/Edit. Физический автор — скил execute-task.

---

### Пробел в инструкции (закрыт этой правкой)

**Existing gap:** GATE-2 (SKILL.md:203–211) требовал перечитать ФАЙЛ ТИКЕТА перед RESULT и проверял 3 условия, но не проверял, что deliverable-файлы из секции «Изменённые файлы» физически существуют на диске.

**Применённые правки:**

| Файл | Изменение |
|------|-----------|
| `SKILL.md:210` | GATE-2, пункт 4: «Каждый файл из секции «Изменённые файлы» физически существует — выполни Read или Glob по каждому перечисленному пути. Файл задекларирован, но не найден → призрачное выполнение; вернись к шагу 5.» |
| `SKILL.md:226` | Self-check: добавлена строка «Каждый файл из секции «Изменённые файлы» физически существует (проверено Read/Glob перед выводом RESULT)» |
| `algorithms/execution-strategy.md:130` | Чеклист раздела 4: добавлен пункт «Каждый файл из секции «Изменённые файлы» физически существует — выполни Read или Glob по каждому перечисленному пути до вывода RESULT.» |

---

### ⚠️ Эскалация (обязательна — повторный инцидент)

**Текстовое усиление НЕ является решением** — агент, который решает ghost-execute, игнорирует все self-check'и. Необходима машинная защита.

**Рекомендация стейкхолдеру:** создать тикет эскалации с одним из вариантов:

1. **Пост-гейт стадия пайплайна** — после execute-task скрипт читает секцию «Изменённые файлы» из тикета и проверяет, что каждый перечисленный файл существует на диске; failing → retry/blocked.
2. **Валидация пайплайном** — `result_filled: true` в логе + проверка существования файлов из Result.modified_files до перемещения тикета в review.

---

### Тест: TC-EXECUTE-TASK-012

- **Verdict:** `ready_for_user_review`, `current_run.failed: 0` (новый кейс, baseline отсутствует)
- **Сценарий:** ticket IMPL-910 требует создать `.workflow/knowledge/test-conventions.md`. Агент должен физически создать файл, перечислить в Modified Files, верифицировать через Read перед RESULT.
- **L0 static:** `SKILL.md` и `algorithms/execution-strategy.md` содержат паттерн `"физически существует"`.
- **L2 rubric:** `file-creation-verified.md` — шкала 1–5, порог 4, majority/3 trials.

---

Файлы:
- `.workflow/src/skills/execute-task/SKILL.md` (GATE-2 пункт 4, self-check)
- `.workflow/src/skills/execute-task/algorithms/execution-strategy.md` (чеклист раздел 4)
- `.workflow/src/skills/execute-task/tests/cases/TC-EXECUTE-TASK-012-file-creation-verified.yaml`
- `.workflow/src/skills/execute-task/tests/rubrics/file-creation-verified.md`
- `.workflow/src/skills/execute-task/tests/fixtures/IMPL-910-create-knowledge-file.md`
- `.workflow/src/skills/execute-task/tests/index.yaml`
- `.workflow/coach-backlog.yaml`
