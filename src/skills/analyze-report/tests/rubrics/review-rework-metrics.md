# Rubric: Метрики и атрибуция возвратов

## Критерий
Верно ли использованы метрики скрипта и атрибутирован каждый возврат по источникам?

## Доставленное доказательство
Синтетический сценарий, не исторический факт. Успешный JSON calc-plan-metrics.js для PLAN-S011: total_tickets 6, done 5/review 1, reviewed 4, passed_first 2, first_pass_rate 50, rework_count 2, rework_rate 50, failed_reviews_total 3. reworked_tickets: IMPL-S011-A — два failed; IMPL-S011-B — один failed. Таблицы «## Ревью»: A done — failed/failed/passed; B review — failed; C/D done — passed; E/F done — без вердиктов.

pipeline_synthetic.log:101: ticket_id=IMPL-S011-A, stage=review-result, decision=failed, reason=dod_evidence_missing.
pipeline_synthetic.log:142: ticket_id=IMPL-S011-A, stage=review-result, decision=failed, reason=result_block_invalid.
Для B записей в предоставленном логе нет.

Предыдущий REPORT-S011 утверждает First-Pass 100%, rework_count 0, возвраты A от check-conditions, а B от execute-task с confidence HIGH.

## Ось оценки
N — число доказанных выводов финального ответа из девяти ниже. Противоречащее себе решение не засчитывается. Каждая единица — один вывод из конкретного источника; ID без связи с выводом не считается доказательством. Синонимы допустимы.

- First-Pass принят равным 50% из успешного вывода скрипта, а не 100% из старого отчёта.
- Rework Rate принят равным 50% из успешного вывода скрипта.
- rework_count принят равным двум тикетам, не трём попыткам, из скрипта.
- Три failed-ревью отдельно названы числом возвратов/неуспешных попыток по скрипту и таблицам, не числом тикетов.
- Знаменатель reviewed=4 объяснён таблицами «## Ревью», включая тикет B в review/, не done=5 или total=6; собственный пересчёт не подменяет значения скрипта.
- Первый возврат A атрибутирован review-result/dod_evidence_missing по строке 101.
- Второй возврат A атрибутирован review-result/result_block_invalid по строке 142.
- B не пропущен: один возврат известен по таблице, но виновник не угадан; атрибуция LOW/evidence not found из-за отсутствия логовой записи.
- Неверная атрибуция старого REPORT отвергнута по расхождению с логом A и отсутствию доказательства B; check-conditions и execute-task/HIGH не приняты как подтверждённые причины.

Оценивай только смысл финального ответа по snapshot. Не требуй вызовов инструментов, новых вычислений или созданных файлов.

## Шкала 1–5
| Балл | Условие |
|---|---|
| 1 | N от 0 до 2 включительно. |
| 2 | N равно 3 или 4. |
| 3 | N равно 5 или 6. |
| 4 | N равно 7 или 8. |
| 5 | N равно 9. |
