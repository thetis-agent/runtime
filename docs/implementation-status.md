# Implementation status · 2026-09-09

Milestone A is **in progress**, not accepted. The operator approved ADR
0021's run-principal boundary and authorized continuation. No decision
currently awaits an operator response.

Implemented and exercised so far:

- House rules, the complete design copy, strict TypeScript and ESLint,
  pinned dependencies, generated contract types and stale-generation checks.
- Real evidence designation, principal isolation, bounded run credentials,
  expiry and generation fencing, including deliberate descriptor delegation.
- Bounded NDJSON framing, asynchronous stream queues, provider Unix-socket
  client/server, and cancellation while a response is active.
- A scripted provider using the shared authentication and reservation path,
  deterministic cache accounting, a faux gateway, and an injected clock.
- The unprivileged loop, recorded offer ownership, observer isolation,
  ephemeral appends, stored prefixes, notices, JSONL branches, spill files,
  and compaction that retains protected messages and call/result pairs.
- Scoped authenticated encryption for secrets, registered delivery grants,
  origin/role checks on the internal API, and refusal of scope fallback.
- An explicit generation transition table with guarded, durable observed
  rows; bounded snapshot copying and hashing in worker threads. Process
  switching and the trusted default act are not yet wired to this machine.
- File handlers with canonical grant checks and streamed results; the skill
  loader; Legacy's BM25/cosine/fusion ranker and hierarchical retrieval.

Validation:

- The current suite has 107 passing tests, zero failures and zero skips.
  It is a partial implementation suite, not full conformance acceptance.
- `check` passes strict type checking and lint with zero warnings.
- Tests run inside bubblewrap with user, process and network namespaces.
  A surrounding user systemd scope bounds the test run to 512 MiB,
  64 tasks and 100% CPU. This is not the required idle-RSS measurement.
- The long-prefix fixture asserts at least 99% cached input on turn two
  in the mock's cache model. Socket tests also compare prefix bytes across
  separate connections. No real-vendor cache claim is made.
- The copied 1.0 design schemas remain intact. ADR 0024 introduces the
  executable provider/turn-events 1.1 contracts for normalized tool-call
  history, with regenerated types. ADRs 0022 and 0023 document ephemeral
  context ownership and permanently fenced rollback, respectively.

Remaining acceptance work includes the mandatory production runner and
resource provisioning, kernel socket and origins, the default act and
complete generation driver, package discovery/init/spawn wiring, registry
installation and release retention, the lifted UI and login gateway,
OpenAI-compatible provider and OpenRouter demonstration, CLI, metrics and
evaluator, pinned default profile, remaining conformance ids and inventory
check, property suites, compatibility from real tags, two-account isolation,
edit-to-serve and idle-RSS measurements, and per-turn observed/reported logs.

No completion report is written because Milestone A has not been completed.

Reproduce the current checks from `/opt/zero`:

```sh
/home/bitmuse/.nvm/versions/node/v24.18.0/bin/node scripts/check.ts
systemd-run --user --scope --quiet -p MemoryMax=512M -p TasksMax=64 -p CPUQuota=100% /home/bitmuse/.nvm/versions/node/v24.18.0/bin/node scripts/test.ts
```

The shell's default Node is 18; direct TypeScript execution uses the
installed Node 24.18.0 binary above.
