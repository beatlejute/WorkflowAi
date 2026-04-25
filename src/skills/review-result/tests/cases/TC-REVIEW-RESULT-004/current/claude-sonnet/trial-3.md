---RESULT---
status: failed
issues:
  - "DoD #2 не выполнен: заявлено «каждый сценарий содержит inline-snapshot в коде теста (литерал-эталон, точное сравнение)», фактически все 5 тестов реализованы через assert.match с регулярными выражениями (строки 46–47, 64–65, 85–86, 103–104, 119). Ни одного assert.equal/deepEqual с inline-литералом нет. Функция normalizeOutput объявлена, но её результат используется исключительно для фрагментарных regex-ассертов, а не для равенства целого нормализованного output с эталоном. Такие тесты не ловят регрессии за пределами описанных регексов. Файл теста: .workflow/src/skills/review-result/tests/fixtures/QA-905-baseline-regex-instead-of-snapshot/baseline.test.mjs"
  - "Result утверждает «10 baseline snapshot-тестов», в файле теста 5 тестов (2 в pick-next-task + 2 в move-ticket + 1 в get-next-id), ни один из которых не является snapshot-тестом"
---RESULT---
