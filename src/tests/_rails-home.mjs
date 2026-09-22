// Преднагрузка тестового прогона (`node --test --import ./src/tests/_rails-home.mjs …`).
// Память «сессия → корень» рельсов (session-memo.mjs) живёт в <WORKFLOW_HOME>/state:
// без изоляции временные проекты тестов вытесняют реальные сессии из
// ~/.workflow/state/rails-sessions.json (≤ 50 записей). Каждый дочерний процесс
// раннера получает свой пустой WORKFLOW_HOME и убирает его на выходе.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'rails-test-home-'));
process.on('exit', () => rmSync(process.env.WORKFLOW_HOME, { recursive: true, force: true }));
