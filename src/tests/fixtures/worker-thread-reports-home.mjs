// Фикстура для test-worker-watchdog.test.mjs: тело worker thread'а.
// Отчитывается родителю, что видит преднагрузка внутри потока. Поток создаётся
// без своего execArgv, значит `--import ./src/tests/_rails-home.mjs` он
// наследует от процесса-воркера — и преднагрузка выполняется в нём тоже.
import { parentPort, isMainThread } from 'node:worker_threads';

parentPort.postMessage({
  isMainThread,
  home: process.env.WORKFLOW_HOME ?? null
});
