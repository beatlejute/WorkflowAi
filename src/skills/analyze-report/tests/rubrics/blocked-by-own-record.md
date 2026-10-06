# Rubric: Запись проверки и продуктовый провал

## Критерий
Верно ли различены блокировка записью проверки и продуктовые провалы по evidence DoD?

## Доставленное доказательство
Синтетический сценарий, не исторический факт. PLAN-S009, T1, три QA в blocked. У каждого DoD 1.

A: QA-S009-A, npm test, expect stdout matches /0 failed/. blocked_reason: dod_check_failed: stdout expectation mismatch. Evidence QA-S009-A.md.json: status failed, exit_code 0, stdout «✓ suite A passed; ✓ suite B passed; Tests: 20 passed».

B: QA-S009-B, npm test, expect exit 0. blocked_reason: dod_check_failed: expected exit 0, got 1. Evidence QA-S009-B.md.json: status failed, exit_code 1, stdout «Tests: 12 failed, 1464 passed». Исполнитель назвал падения посторонними.

C: QA-S009-C, check-warning, expect stdout not contains UNSAFE_WARNING. blocked_reason: dod_check_failed: stdout expectation mismatch. Evidence QA-S009-C.md.json: status failed, exit_code 0, stdout UNSAFE_WARNING. DoD запрещает это предупреждение в продукте. Исправлений и решений стейкхолдера нет.

## Ось оценки
N — число выполненных обязательств финального ответа из шести ниже. Противоречащее себе решение не засчитывается. Синонимы допустимы; названный ID без связи с выводом не доказывает рассуждение.

- A признан пробелом собственной записи по текстовому ожиданию, не доказанным продуктовым падением: evidence показывает успешный прогон, но не содержит ожидаемую строку.
- B признан продуктовым провалом, не неисправной записью: exit 1 и падения не сняты словами исполнителя.
- C признан одновременно проблемой записи по текстовому ожиданию и продуктовым дефектом: вывод действительно содержит запрещённый текст.
- В gaps для A передан невыполненный DoD с QA-S009-A, пунктом 1, текстовым ожиданием и blocked_reason; анализ связан с фактическим stdout/exit 0.
- В gaps для B передан продуктовый провал с QA-S009-B, пунктом 1, ожиданием exit 0 и blocked_reason; анализ связан с exit 1/12 failed.
- В gaps для C переданы оба аспекта с QA-S009-C, пунктом 1, запретом UNSAFE_WARNING и blocked_reason; анализ связан с фактическим предупреждением.

Каждое обязательство о gaps засчитывается только при итоговом has_gaps: это корректная доставка классификации, не независимая оценка оформления. Не требуй инструментов или созданных файлов. Оценивай исключительно смысл финального ответа по snapshot.

## Шкала 1–5
| Балл | Условие |
|---|---|
| 1 | N равно 0 или 1. |
| 2 | N равно 2. |
| 3 | N равно 3 или 4. |
| 4 | N равно 5. |
| 5 | N равно 6. |
