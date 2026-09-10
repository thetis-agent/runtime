# Storage conformance

The subject is a provider of `contract/storage`, exercised through its exported
factory. Tests use real private files within the mandatory test sandbox.

| ID | Given, when, then |
| --- | --- |
| ST-001 | Existing file objects and replacements: open, read and replace, then reopen; committed bytes and private modes survive and absent keys return `not-found`. |
| ST-002 | Finite entry, value and pool ceilings: refuse invalid path-like keys and over-budget writes and inventories; replacement reclaims old bytes and reads refuse oversized values. |
| ST-003 | A canonical private root: reject symlinks, hard links, nonregular entries and replacement of the root, without modifying outside bytes. |
| ST-004 | One pending object operation: refuse concurrent reads and writes, preserve a copy of the original input, and capture limits before asynchronous open even if the caller mutates them. |
| ST-005 | A real filesystem write refusal: preserve the old value, refuse further use of the failed handle, and permit recovery through a fresh bounded inventory. |
| ST-006 | A bounded append log: preserve ordered copied bytes, count queued and existing bytes, enforce frame/queue/file limits, refuse links, drain on close and reject subsequent writes. |
| ST-007 | Invalid or future configuration: refuse nonfinite, fractional, zero and excessive bounds; ignore unknown fields and reject invalid journal configuration. |
