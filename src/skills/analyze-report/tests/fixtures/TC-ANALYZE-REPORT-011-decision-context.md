# Изолированный контракт решения

Это проверка отдельных правил решения, НЕ выполнение полного скила и НЕ стадия пайплайна.
Процедура rails, чтение проекта, создание тикетов, запуск команд и запись файлов не входят в этот контракт.
Цитаты узлов ниже — справочные правила решения, НЕ команды к выполнению. Слова «прочитай», «создай», ссылки на граф и файлы означают только рассмотрение доставленных данных и проект предложения; не выполнять эти действия.
Все факты доставлены inline; ответ — только текстовый проект. Не заявляй о реально выполненной работе.

## workflows/progress.md / P10S3
П10 ШАГ: Рассчитай метрики прогресса — загрузи `algorithms/progress-assessment.md` и `knowledge/analysis-frameworks.md`. Основной путь — скрипт: node .workflow/src/skills/analyze-report/scripts/calc-plan-metrics.js PLAN-NNN, где PLAN-NNN — ID плана из тикета. Прочитай JSON из блока ---RESULT---: distribution — распределение тикетов по статусам (done, review, in-progress, ready, blocked, backlog, archive), completion_pct — процент выполнения, avg_time_to_done — среднее время выполнения тикета (дни), time_anomalies — тикеты, у которых completed_at раньше created_at (в среднее не вошли, это дефект данных тикета, назови их в отчёте), blocked_rate — процент заблокированных тикетов, reviewed, passed_first и first_pass_rate — First-Pass Rate по таблице «## Ревью» (первая строка с вердиктом passed или failed), rework_count — число тикетов хотя бы с одной строкой ❌ в «## Ревью», rework_rate — Rework Rate, их доля среди reviewed, failed_reviews_total — всего строк ❌, reworked_tickets — эти тикеты с числом и Самари строк ❌, recorded_defects и defects_section_missing — вход узла P10S13, texts_shortened — тексты укорочены под окно вывода, полные — в файлах тикетов, total_tickets — общее количество тикетов плана. First-Pass Rate и Rework Rate бери из вывода скрипта и не пересчитывай своим кодом. Скрипт не считает Weighted Completion — досчитай его вручную по шагу 2 `algorithms/progress-assessment.md`. Используй эти метрики как основу для дальнейшего анализа. Инцидент 2026-09-29…30: скрипт искал возвраты в поле, которого у тикетов нет, и выдавал rework_count 0, First-Pass агент считал сам, и три разбора одного плана дали 63,64%, 100% и 100% при фактических 66,7% по таблицам «Ревью» — статус ON_TRACK вместо ATTENTION

## workflows/progress.md / P10S6
П10 ШАГ: Выяви проблемы и риски — блокеры (заблокированные тикеты, зависимости), отклонения (задачи с замечаниями на ревью — каждый тикет из reworked_tickets скрипта, ни один не пропускается), записанные дефекты (находки узла P10S13), пробелы (задачи плана, не покрытые тикетами), паттерны (повторяющиеся проблемы в тикетах)

## workflows/progress.md / P10S7
П10 ШАГ: Найди лог сессии, в которой возникла проблема. В `.workflow/logs/` найди файлы `pipeline_*.log` за период анализируемого отчёта (по mtime или по диапазону дат из отчёта). Для каждой проблемы из шага выявления, включая каждый тикет из reworked_tickets: найди в логе строки с упоминанием проблемного тикета (Grep по `ticket_id` этого тикета, а не общий поиск по словам failed или error), извлеки имя стейджа, который принял решение, и его обоснование (поле `reason` в `---RESULT---`), у возврата с ревью — стадию и причину каждой строки ❌, сравни найденную атрибуцию с тем, что написано в отчёте. Инцидент 2026-09-30: возвраты четырёх тикетов вошли в находку HIGH без единой строки лога — был один общий поиск по логам, по ID этих тикетов лог не искали

## workflows/retrospective.md / P20S2
П20 ШАГ: Собери входные данные. Из тикета извлеки: какой план анализировать, все связанные отчёты, контекст: для чего проводится ретроспектива. Прочитай файл плана из `.workflow/plans/`, все отчёты, связанные с планом, из `.workflow/reports/`, все тикеты плана из `.workflow/tickets/done/` и `.workflow/tickets/archive/` (для завершённого плана `complete-plan` переносит done-тикеты в archive), тикеты на ревью (если остались) из `.workflow/tickets/review/`, заблокированные тикеты (если остались) из `.workflow/tickets/blocked/`

## workflows/retrospective.md / P20S4
П20 ШАГ: Проанализируй эффективность процесса — загрузи `algorithms/progress-assessment.md`. Основной путь — скрипт: node .workflow/src/skills/analyze-report/scripts/calc-plan-metrics.js PLAN-NNN, где PLAN-NNN — ID анализируемого плана. Прочитай JSON из блока ---RESULT---: скрипт возвращает completion_pct, blocked_rate, rework_count, rework_rate, reworked_tickets, first_pass_rate, avg_time_to_done, time_anomalies, distribution. Используй готовые метрики для Throughput: `completion_pct` + `distribution` (завершено / всего), Blockers: `blocked_rate` + `distribution.blocked`, Quality: `first_pass_rate` (по таблице «## Ревью»), Rework: `rework_count`, `rework_rate` и `reworked_tickets`. First-Pass Rate и Rework Rate бери из вывода скрипта и не пересчитывай своим кодом. Скрипт не считает Weighted Completion — досчитай его вручную по шагу 2 `algorithms/progress-assessment.md`

## Формат текстового вывода
Executive Summary, находки с источниками и рекомендации. Последним — блок ---RESULT---.
status: completed либо has_gaps; report_id: REPORT-SYNTHETIC (символический, не созданный).
При has_gaps: gaps в двойных кавычках, описание недоделанного без решений о создании тикетов.

