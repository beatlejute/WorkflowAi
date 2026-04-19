Проанализирую пайплайн. Вижу коллизию ID — проверю детали.
Проанализирую лог пайплайна. Вижу коллизию ID — но `allocate-ticket-ids` стадия не отражена в логе между `check-plan-decomposition` и `decompose-plan`. Проверю runner.
Проанализирую структуру goto в runner. Ключевая проблема — стадия `allocate-ticket-ids` не видна между `check-plan-decomposition` и `decompose-plan`.
## Findings

### 1. Пропущена стадия `allocate-ticket-ids` (КРИТИЧЕСКОЕ)

**Доказательство из лога:**
```
[2026-04-06 16:36:12] [INFO] [check-plan-decomposition] GOTO check-plan-decomposition → decompose-plan status="needs_decomposition"
```

Согласно `pipeline.yaml` (строки 314-317), `needs_decomposition` должен вести к `allocate-ticket-ids`, который передаёт `id_ranges_json` в `decompose-plan`. Но в логе стадия `allocate-ticket-ids` отсутствует, а `decompose-plan` получает только `plan_file` без `id_ranges_json`.

**Временная диаграмма для PLAN-003:**
| Время | Событие |
|-------|---------|
| 16:36:02 | pick-first-task архивирует IMPL-002…IMPL-008 (из PLAN-002) |
| 16:36:12 | check-plan-decomposition → **пропущена `allocate-ticket-ids`** → decompose-plan |
| 16:36:18 | decompose-plan создаёт IMPL-002, IMPL-003 **с коллизией ID** |

**Коллизия ID:**
- IMPL-002 и IMPL-003 уже существуют в `tickets/archive/` (были завершены в PLAN-002)
- Новая декомпозиция PLAN-003 создаёт тикеты с теми же ID

### 2. Stop-gate не сработал в decompose-plan

Согласно `workflows/decompose.md` (шаг 9.B): при отсутствии `id_ranges_json` декомпозитор обязан **остановиться**. Вместо этого:
- Тикеты созданы успешно (exitCode=0)
- В выводе отсутствует секция `ids_allocated_from` (обязательная при выполнении stop-gate)

**Вывод:** декомпозитор не выполнил свой собственный стоп-гейт — продолжил работу с невалидным входом.

### 3. Root Cause

| Этап | Что должно было произойти | Что произошло |
|------|--------------------------|--------------|
| check-plan-decomposition | Вернуть `needs_decomposition` → `allocate-ticket-ids` | goto ведёт напрямую к `decompose-plan` |
| allocate-ticket-ids | Сгенерировать `id_ranges_json`сканированием tickets/ включая archive/ | **Пропущена** |
| decompose-plan | Принять `id_ranges_json`, проверить валидность, остановиться если пусто | Продолжила без параметра |

**Гипотеза:** несогласованность между `pipeline.yaml` и фактически исполняемым кодом runner'а. goto-логика в runner'е (`resolveNextStage`) корректна, но runner читает устаревшую версию конфига.

### 4. Нарушенные принципы коуча

| Принцип | Как нарушен |
|---------|-----------|
| **1. Root Cause First** | Архитектурная защита от коллизий (allocate-ticket-ids) не работает — причина первого порядка: инфраструктура не обеспечила контракт |
| **10. Self-Correct** | Декомпозитор должен был остановиться при отсутствии `id_ranges_json`, но продолжил работу — self-check не сработал |

---

## Рекомендация

**CRITICAL:** Проверить一致性 конфигурации pipeline.yaml и фактического поведения runner'а. Стадия `allocate-ticket-ids` — обязательный пререквизит для `decompose-plan`. Без неё ID-аллокация ложится на агента, что нарушает архитектурный принцип «ID решает инфраструктура, не агент».
