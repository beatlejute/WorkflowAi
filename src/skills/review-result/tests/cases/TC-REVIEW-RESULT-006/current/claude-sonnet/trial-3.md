DoD 1: `formatDate` принимает `Date`, возвращает `YYYY-MM-DD` — описана реализация через `toISOString().slice(0, 10)`, результат соответствует формату. ✅
DoD 2: Unit-тест на невалидную дату добавлен — `formatDate.spec.ts` с 2 сценариями включая `Invalid Date`. ✅
Result section заполнен, frontmatter валиден.

---RESULT---
status: passed
issues: []
---RESULT---
