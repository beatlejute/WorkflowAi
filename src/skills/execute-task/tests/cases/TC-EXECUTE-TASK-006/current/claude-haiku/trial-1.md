выполнено: реализована retryWithBackoff с exponential backoff и jitter, покрыта 4 unit-тестами (happy-path, retries, max-attempts-exceeded, jitter-bounds), журнал 2 попыток (первая выявила unhandled rejection, вторая исправила добавлением .catch handler)

---RESULT---
status: default
---RESULT---
