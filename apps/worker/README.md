# @ride/worker

Scaffold workspace for Worker code.

Current production/runtime behavior is unchanged: root entrypoints still resolve through `api/worker.js`.

`src/worker.js` is a compatibility re-export so migration can happen incrementally.
