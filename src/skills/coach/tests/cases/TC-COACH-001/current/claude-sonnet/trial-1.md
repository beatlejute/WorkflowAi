---

## Отчёт: анализ пайплайна PLAN-003 (2026-04-06)

### Временные диаграммы ID с коллизиями

**IMPL-002:**
| Время | Событие | Evidence |
|---|---|---|
| 16:36:02 | archived: done→archive (PLAN-002) | `[ARCHIVE] IMPL-002: done → archive (plan PLAN-002 is archived)` |
| 16:40:31 | **создан заново** (PLAN-003) | `**IMPL-002** — Конфиг tickets/**: protected_files + trusted_stages` |

**IMPL-003:**
| Время | Событие | Evidence |
|---|---|---|
| 16:36:02 | archived: done→archive (PLAN-002) | `[ARCHIVE] IMPL-003: done → archive (plan PLAN-002 is archived)` |
| 16:40:31 | **создан заново** (PLAN-003) | `**IMPL-003** — Дедупликация в pick-next-task` |

---

### Findings

#### CRITICAL-1: Pipeline обошёл `allocate-ticket-ids`
- **Evidence**: `[check-plan-decomposition] GOTO check-plan-decomposition → decompose-plan status="needs_decomposition"` — переход прямо на decompose-plan
- **vs pipeline.yaml:344**: `needs_decomposition: stage: allocate-ticket-ids`
- **Статус**: **УЖЕ ИСПРАВЛЕНО** — текущий pipeline.yaml имеет стадию allocate-ticket-ids

#### CRITICAL-2: Агент начал нумерацию с 001 вместо СТОП
- **Evidence**: создал IMPL-001, IMPL-002, IMPL-003 без id_ranges_json в Instructions
- **Нарушение**: `workflows/decompose.md:180` — "Никогда не начинай нумерацию с 001"
- **Gap**: 9.B не покрывал случай "параметр вообще не передан" (только "пустым/некорректным JSON")
- **Статус**: **ИСПРАВЛЕНО** — добавлена предварительная проверка в `workflows/decompose.md:177`

#### CRITICAL-3: `ids_allocated_from` отсутствует в RESULT
- **Evidence**: `---RESULT---\nstatus: default\n---RESULT---` — секция отсутствует
- **Нарушение**: `workflows/decompose.md:189` — "Её отсутствие означает, что СТОП-гейт был пропущен"
- **Gap в TC-007**: ни один anchor не проверял обязательность секции
- **Статус**: **ИСПРАВЛЕНО** — добавлен anchor в TC-007

#### CRITICAL-4: Glob-пре-валидация (9.1 p.4) не выполнялась
- **Evidence**: IMPL-002/003 записаны; archive/ доступен — `get-next-id.js:53-78` сканирует рекурсивно
- **Нарушение**: `workflows/decompose.md:231` — "Есть совпадение → СТОП до записи"
- **Статус**: правило в тексте есть; L2-тест поведения отложен стейкхолдером 2026-09-21

---

### Правки

| Файл | Изменение |
|---|---|
| `workflows/decompose.md:177` | Добавлена предварительная проверка: СТОП при отсутствии/неподстановке `id_ranges_json` |
| `TC-DECOMPOSE-PLAN-007.yaml` | Добавлены 2 anchor (`ids_allocated_from` обязателен; СТОП при absent параметре) + запись инцидента 2026-04-06 в `origin.incidents` |

---

RAILS: P8S2, verdict=ready_for_user_review

**Файлы:**
- `.workflow/src/skills/decompose-plan/workflows/decompose.md`
- `.workflow/src/skills/decompose-plan/tests/cases/TC-DECOMPOSE-PLAN-007-id-collision-stop-no-realloc.yaml`
