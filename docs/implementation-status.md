# Implementation status · 2026-09-09

Milestone A is **in progress**, not accepted. The operator approved ADR
0021's run-principal boundary and authorized continuation. No decision
currently awaits an operator response.

Implemented and exercised so far:

- Kernel-observed submission start/end rows with host-generated correlation,
  elapsed time and response/error outcomes, including killed turns. Candidate
  reports travel once per completed turn through worker and inherited control
  sockets, with aggregated stage counts/durations, retrieved ids, offered names
  and per-call outcomes/durations. Actual two-environment tests verify separate
  labels and exclusion of provider text and credentials. Report exhaustion emits
  an explicit budget diagnostic; the full oversized-frame end-event conformance
  case and the final deployment log integration remain unfinished.
- House rules, the complete design copy, strict TypeScript and ESLint,
  pinned dependencies, generated contract types and stale-generation checks.
- Real evidence designation, principal isolation, bounded run credentials,
  expiry and generation fencing, including deliberate descriptor delegation.
  Provisional credentials permit private startup controls but cannot admit
  ordinary calls at any time; serving launches receive fresh credentials,
  and abandoned candidates cannot revive.
- Bounded NDJSON framing, asynchronous stream queues, provider Unix-socket
  client/server, and cancellation while a response is active. Provider
  connections have a 10-second admission budget, a 600-second exchange
  budget, a 64-connection limit and a 30-second drain deadline; deadline
  tests use an injected clock and the actual socket implementation.
- Negotiated kernel socket transport with schema-checked method parameters,
  credential-bound identity, per-operation fencing, request deadlines and
  control-frame priority verified over a real socket.
  Both compatibility directions now load the previous minor from a pinned
  green git tag; the shared transport suite passes against current code.
- A scripted provider using the shared authentication and reservation path,
  deterministic cache accounting, a faux gateway, and an injected clock.
  Its shared-service entry now runs in a real bubblewrap child, reads policy
  over the inherited kernel endpoint, persists reservations with an epoch
  clock, and attributes usage through the actual kernel accounting path.
  Two caller identities have independent budgets; drain and announced
  rollback resumption preserve the same service process. Both adapters export
  spawns, which discovery collects and checks with initialized registrations
  against the same envelope, including duplicate ids and secret requirements.
  Kernel activation, person-scope service authentication and deployment principals
  without a person remain to be assembled.
- A compatible HTTP adapter with bounded SSE, tool fragments, reasoning
  replay, conservative reservations, OpenRouter price ceilings and tested
  cancellation/error handling against a scripted HTTP vendor.
  Its service entry validates settings from the package schema, receives its
  key through the declared spawn environment, and declares network egress.
  Egress provisioning and an actual OpenRouter demonstration remain.
- The unprivileged loop, recorded offer ownership, observer isolation,
  ephemeral appends, stored prefixes, notices, JSONL branches, spill files,
  and compaction that retains protected messages and call/result pairs.
  A scoped session API now persists conversation metadata, checks local ids
  and canonical paths, loads histories under bounded leases, exposes
  cancellation, and drains both turns and conversation creation. Submission
  returns completion metadata; output remains on the gateway event path.
  The worker now runs these sessions behind a private Unix control endpoint,
  reusing the negotiated RPC transport and its limits. A real imported file
  tool runs through the dispatcher, while 1,000 provider deltas produce no
  monitor messages. The shipped process entry now keeps inherited authority
  on the monitor and reads its runtime over that endpoint; two real
  bubblewrap environments chat independently through the shared mock service.
  Kernel-supplied principal/token fields replace configuration claims, and
  provider output remains in each environment's own conversation state.
  Gateway integration, announced profile refresh and background notice
  routing through the session API remain.
- Scoped authenticated encryption for secrets, registered delivery grants,
  origin/role checks on the internal API, and refusal of scope fallback.
- An explicit generation transition table with guarded, durable observed
  rows; bounded snapshot copying and hashing in worker threads. Process
  switching is wired to real sandbox effects; the trusted default act remains.
  ADR 0025 records commitment intent before fencing and rename; endpoint
  tests verify new connections move while old connections remain usable.
- Managed process controls now use real inherited RPC endpoints to start,
  probe, drain and stop sandboxed processes. Tests cover cooperative and
  stuck turns and a probe that never responds. The generation driver now
  verifies pin copies, migrates isolated state, switches endpoints, restores
  failed candidates and supports undo. Durable restart recovery remains.
  ADR 0026 makes probe grants read-only and starts a fresh serving process
  after fencing. Real tests cover failures on both sides of commitment,
  discarded-path auditing and interrupted-conversation update metadata.
- A bubblewrap runner with a pre-exec cgroup gate, inherited descriptors,
  read-only root mounts, bounded writable filesystems and verified memory
  enforcement. Network egress and persistent-volume provisioning remain.
  The runner also waits for cgroup freezer acknowledgment before state
  copying; a real queued-write test verifies freeze/thaw behavior.
- Registered secrets delivered through a private spawn pipe and set in the
  service environment before entry evaluation, tested with the encrypted
  store and actual bubblewrap runner without key copies in argv or files.
- Usage attribution checks the reporting run's recorded caller grants,
  preserves candidate/reviewed labels and supplies the cost-only mount check.
  Provider checkpoints retain unfinished reservations across restart and
  refuse vendor access when reservation persistence fails. Deployment spawn
  assembly still needs to require those checkpoints and wire the mount check.
- File handlers with canonical grant checks and streamed results; the skill
  loader; Legacy's BM25/cosine/fusion ranker and hierarchical retrieval.
- Directory discovery, settings validation and a schema-checked initialization
  worker. A real synchronous infinite init is terminated while the monitor
  remains responsive; the remaining packages initialize again with the failed
  package inert. Every shipped package initializes twice in the suite.
  Registration activation and the loop's process-level session bridge remain.

Validation:

- The current suite has 201 passing tests, zero failures and zero skips.
  It is a partial implementation suite, not full conformance acceptance.
- `check` passes strict type checking and lint with zero warnings.
- Tests run inside bubblewrap with user, process and network namespaces.
  The launcher creates its own delegated user systemd scope, which bounds the test run to 512 MiB,
  128 tasks and 100% CPU. Three real sandboxed processes plus the test
  infrastructure exceeded the former 64-task supervisor limit; each
  sandbox still has its own 64-task limit. This is not the required
  idle-RSS measurement.
- An ad hoc `/proc` observation of the first full environment process was
  139,644 KiB RSS (about 136 MiB), already above the kernel-plus-environment
  target. This is an outstanding optimization failure, not an accepted
  exception; no passing idle-memory benchmark is claimed.
- The long-prefix fixture asserts at least 99% cached input on turn two
  in the mock's cache model. Socket tests also compare prefix bytes across
  separate connections. No real-vendor cache claim is made.
- The copied 1.0 design schemas remain intact. ADR 0024 introduces the
  executable provider/turn-events 1.1 contracts for normalized tool-call
  history, with regenerated types. ADRs 0022 and 0023 document ephemeral
  context ownership and permanently fenced rollback, respectively.

Remaining acceptance work includes network egress and storage
provisioning, kernel socket and origins, the default act and
durable generation recovery and all target kinds, package discovery/init/spawn wiring, registry
installation and release retention, the lifted UI and login gateway,
provider spawn integration and OpenRouter demonstration, CLI, metrics and
evaluator, pinned default profile, remaining conformance ids and inventory
check, remaining property suites, two-account isolation,
edit-to-serve and idle-RSS measurements, and per-turn observed/reported logs.

No completion report is written because Milestone A has not been completed.

Reproduce the current checks from `/opt/zero`:

```sh
/home/bitmuse/.nvm/versions/node/v24.18.0/bin/node scripts/check.ts
/home/bitmuse/.nvm/versions/node/v24.18.0/bin/node scripts/test.ts
```

The shell's default Node is 18; direct TypeScript execution uses the
installed Node 24.18.0 binary above.
