# Implementation prompt for /opt/zero

> Historical design input, preserved verbatim below. Its machine-specific paths,
> development instructions and superseded limits are not current defaults. Use
> [the installation guide](install.md), [house rules](../AGENTS.md) and
> [design clarifications](decisions-taken.md) for current instructions.

You are implementing Thetis, the successor to Thetis Legacy (/opt/thetis), in the empty
directory `/opt/zero`. Thetis is a self-modifying, multi-user AI agent
harness: one small trusted kernel, one unprivileged loop, and everything
else as versioned packages from git registries. You are the sole
engineer. Do not ask questions; the design answers them, and where it
does not, the rules below say how to decide and how to record it.

## The design is the specification

The complete design is at `/opt/thetis/docs/postmortem`. Copy
`00-proposal.md`, `08-vocabulary.md`, `adr/`, `contracts/`, `design/`
and `flow/` into `/opt/zero/docs/` and treat that copy as read-only,
except that you may add new records under `docs/adr/`. Read all of it
before writing code: the proposal is the design, the twenty records are
the reasons, the contracts are the wire, the two design documents
(`design/generations.md`, `design/evaluator.md`) are the machines, and
the conformance suites are your acceptance tests.

Authority, when documents disagree: a JSON Schema under
`contracts/schema/` beats the contract's prose; a conformance test
beats a paragraph; a record under `adr/` with a higher number beats a
lower one; the proposal beats the post-mortem. A disagreement you find
is a bug in the lower-authority document: fix it in your copy with a
one-line note in `docs/decisions-taken.md` and carry on.

Deviation from the design is allowed only by a new record in
`docs/adr/`, numbered after 0020, in the format of 0001, stating what
the design said, why it cannot be built as said, what you built
instead, and what is lost. Never edit an accepted record. Never deviate
silently. If the deviation would remove a guarantee (a boundary, a
secret rule, the gate, the act), stop and leave the record as
`Proposed`; that decision is a person's.

Assumptions already taken, do not revisit them: `cost` in USD; Linux
with bubblewrap; one registry, the deployment's own bare repository;
Node's current LTS running TypeScript directly with type stripping, no
bundler, no transpile step; `tsc --noEmit --strict` as the gate; JSON
Schema draft 2020-12; the `semver` library for ranges.

## What to build

Milestone A from the proposal's build order, complete and green:

- **The kernel** (`kernel/`): identity, the boundary, secrets,
  generations. Nothing else. About 1,300 lines is the budget; if a part
  passes 1,500, it is holding something it should not, and you find
  what and move it to a package with a record.
- **`core`** (`packages/core/`): the loop, the event pipeline with the
  hook types, the stored prefix, spill, the notice queue, compaction as
  a projection, the conversation JSONL with `id`/`parentId`.
- **Packages** (`packages/`): `gateway-web` (the lifted UI from
  `/opt/thetis/gateways/gateway-web/src/ui`, served as static assets,
  plus the wire protocol as a gateway stage), `gateway-login` (the
  `password` authority), `tools-files`, `retriever-local` (a port of
  `/opt/thetis/crates/thetis/src/skill_index.rs`: BM25 plus dense with
  fusion as a setting), `provider-openai-compatible`, `provider-mock`,
  `registries`, `cli`, `metrics`, and the four contract packages.
- **The default profile** (`profiles/default/package.json`) pinning
  all of the above by version and hash.
- **The test system** (`test/`): the faux gateway, the mock provider
  scripted per case, the conformance runners, the state-machine driver,
  the property tests, and the two-direction socket compatibility test.

Done means: two accounts chat in their own sandboxed environments
through the lifted UI on the mock provider and on OpenRouter; turn two
reports a 99 % cache hit on the mock's cache model; every conformance
test in `contracts/conformance/` and both design documents passes,
keyed by its id; a `work/` edit to `tools-files` is serving in under
one second; the kernel plus one idle environment is under 120 MB; the
type checker and lint are clean with the configuration below; and the
turn log contains labelled observed and reported rows for every turn.

## Repository layout

/opt/zero
  AGENTS.md            house rules for any agent editing this repository (write it first; keep it under 60 lines)
  package.json         workspaces: kernel, packages/*, contracts/*, lib/*, test
  tsconfig.base.json   strict; noUncheckedIndexedAccess; exactOptionalPropertyTypes; noImplicitOverride; verbatimModuleSyntax
  eslint.config.js     the rules named below; no other
  kernel/              one directory per part: identity, boundary, secrets, generations; plus socket, log, main
  packages/<name>/     package.json, index.ts, settings schema, tests beside the code as *.test.ts
  contracts/<name>/    package.json, schema.json (copied from docs), types.ts (generated), conformance/*.test.ts (one file per suite id range)
  lib/<name>/          shared code used by two or more packages: events, schema, ndjson, sandbox-runner, spill, semver-match, bm25
  profiles/default/    package.json and lock with hashes
  test/                faux gateway, mock provider, drivers, fixtures, the compatibility matrix
  docs/                the read-only copy, plus decisions-taken.md and new records
  scripts/             only what CI runs: check, test, bench, size

## Architecture rules

ALWAYS:

- Keep the kernel ignorant. It names no package, no vendor, no service,
  no counter but `cost`. It matches strings in the requirements
  namespace, verifies hashes, mints tokens, mounts sockets, moves pins.
  Grep the kernel for any package name before every commit; a hit is a
  bug.
- Make every event carry exactly the payload its schema says, and let
  every reader ignore unknown fields. Validate every frame that crosses
  a process boundary against its schema on entry, once, at the edge,
  never again inside.
- Give each event exactly one hook type and enforce it in the
  dispatcher, not by convention: observers get a frozen copy; appenders
  get a section they can push to and nothing else; the owner of a call
  is looked up from the recorded offer, never trusted from the payload.
- Treat the stored prefix as the single source of the prompt's head.
  Render once, hash, store, reuse; refresh only on an announced change.
  Any code path that re-renders the prefix on an ordinary turn is a bug.
- Keep the sandbox mandatory in code, not configuration. The runner
  interface has one adapter, `bwrap`; there is no code path that starts
  an environment, gateway or service outside it. Tests run inside it
  too, with a user namespace.
- Pass the kernel socket and run token as inherited file descriptors,
  close-on-exec. Never in an environment variable, never on disk, never
  in a URL.
- Enforce budgets where the call happens: the provider refuses before
  any vendor request; the kernel's refusal to mount is the backstop.
- Make the act two-step and code-bound: `default.prepare` returns a
  code bound to digest and baseline; `default.set` checks the code, the
  role, the gate and the compare-and-swap in one function that nothing
  else can call.
- Write the log in two labelled halves: kernel-observed and
  candidate-reported. Only observed rows feed the gate. A function that
  reads a reported row to decide anything is a bug.
- Implement the generation machine as an explicit state machine with
  the table from `design/generations.md` as data, one transition
  function, and every transition writing its observed row. No
  state changes outside that function.
- Make every package a plain directory: `package.json`, `index.ts`
  exporting `stages`, optional `skills`, optional `spawn`, a `settings`
  schema, an `envelope`. Discovery is `readdir` and `import()`. No
  registry of packages in code.
- Derive types from the JSON Schemas with a generator into a committed
  `types.ts` per contract, and have a test fail when the generated file
  is stale. The schema is the source; hand-written types for a
  contract are forbidden.
- Put shared logic in `lib/` the first time two packages need it, and
  import it; the second copy is where Thetis's 145 duplicated crates
  began.
- Prefer streams over buffers on every path that carries a stream:
  provider events, tokens, tool results into the spill sink, socket
  frames. A function that awaits a whole stream into a string before
  forwarding it is a bug unless it is the final consumer.
- Do blocking work off the event loop: git, hashing large trees,
  type-checking a package, running tests, extracting a tarball. Use
  worker threads or child processes with bounded concurrency; never a
  synchronous filesystem call on the request path.
- Bound every queue, buffer, frame and pool, and name the limit in a
  setting with a default: socket frame 1 MiB, spill 32 KiB, token batch
  50 ms or 4 KiB, observer time 5 ms per event, drain 30 s, probe 10 s.
- Canonicalise every path before checking it against roots, follow
  symlinks, and refuse on any doubt with the one-sentence error naming
  what exists.
- Name things from `docs/08-vocabulary.md` in code, tests, errors and
  the UI: environment, package, registry, release, generation, space,
  artifact, stage, provider, gateway, kernel, secret, capability.
- Open every module with a doc comment that says what it defends and
  which record or contract clause it implements. Cite ids: `ADR 0013
  §2`, `TE-016`, `KS-015`.
- Return errors as typed results at every boundary (`{ ok: false, error:
  { code, message } }` with the code from the schema's enum); throw
  only for programmer errors; never catch-and-continue silently.
- Write the one-sentence gap message everywhere a requirement is unmet,
  in the exact shape the proposal gives, and test the text.

NEVER:

- Never add a runtime dependency without a line in
  `docs/dependencies.md` stating what it does, why the standard library
  cannot, its exact version, and its integrity hash. Install with
  `--ignore-scripts`. Packages under `packages/` may depend only on
  `lib/` and on contract packages; a third-party dependency there is
  forbidden by rule 3 of the proposal.
- Never let a package read policy from its own settings: read-only
  mode, denials and roots arrive on the `offer` and `call` requests.
- Never trust `readOnly` on a `derived` tool definition unless the
  environment setting marks that source trusted; log which applied.
- Never persist a `context` append. Never run `retrieve` on an ordinary
  turn. Never let harness notes into the prefix.
- Never mount `suite/`, `checks/`, seeds or scorers into a candidate
  sandbox. Never let the evaluator call a model to score. Never let a
  package ship checks for itself.
- Never fall through to another scope's secret when a person's fails.
  Never write a secret value to any log, error, conversation, settings
  file or environment directory. Grep the log for every configured
  secret in a test.
- Never let a gateway name a person. It returns evidence; the kernel
  resolves.
- Never let the kernel parse provider content; it does not see the
  stream at all after ADR 0019.
- Never restart a process except through the generation machine.
  Never write shared state between FROZEN and SWITCHING.
- Never use `any`, a non-null assertion, a type cast to silence the
  checker, or `// @ts-ignore`. Never leave a floating promise. Never
  write a `switch` without exhaustiveness.
- Never let a source file exceed 400 lines or a function exceed 60;
  Thetis's 12,000-line session object and 4,874-line config are the
  lesson. Split by responsibility, not by line count.
- Never write a comment that says what the code does; say why, or say
  nothing.
- Never leave a `TODO` without a record id or a test id it refers to.
- Never write a test that needs the network, a real model, a real key,
  wall-clock time, or the order of other tests.
- Never mock the thing under test. Mock the provider, the vendor, the
  clock and the filesystem edge; never the dispatcher, the matcher, the
  state machine or the sandbox interface.
- Never delete a failing conformance test to make the suite green.
  Never skip one without a record.
- Never rewrite git history on `main`.

## Testing rules

- Every conformance test id in `contracts/conformance/*.md`,
  `design/evaluator.md` and `design/generations.md` exists as a test
  whose name begins with its id, and the suite fails if an id from the
  documents has no test.
- Build the faux gateway and the mock provider first; the mock speaks
  the whole provider contract, scripts every response event including
  `delta.reasoning`, `delta.tool_call` fragments, `budget` errors and
  `cancel`, models a cache so the 99 % hit can be asserted, and passes
  the provider suite itself (PR-014).
- Unit tests live beside the code as `*.test.ts` and cover every error
  code in every schema enum, every branch of the requirements matcher
  (each prefix, scope mismatch, singleton collision, cycle, envelope
  refusal), every transition and guard of the generation machine
  through the table-driven driver, and every rule in the proposal's
  chunk 13.
- Property tests for the matcher (any satisfiable profile resolves to
  the same set regardless of order), the mutator (the stoplist is
  respected; the same seed gives the same variant), the spill sink
  (the file's hash equals the hash of the bytes written, for any
  chunking), and the socket codec (any valid frame round-trips; any
  frame with unknown fields round-trips).
- The compatibility matrix runs the socket suite with the previous
  minor's client against the current kernel and the reverse, from tags.
- Determinism: `init` is run twice in a test for every package; the
  prefix is rendered twice and compared byte for byte; the mock's
  seeded runs are compared row for row.
- Measure in tests what the design promises in numbers: an idle kernel
  and environment RSS under 120 MB (a script, run in CI, asserting the
  number); edit-to-serve under one second on a `work/` change; no
  per-token socket frames (count frames per turn on the mock).
- Coverage is not a target; the ids are. A line that no conformance or
  unit test reaches is either dead or untested, and either is a bug.

## Code quality configuration

`tsconfig`: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`.
`eslint`: `@typescript-eslint/strict-type-checked`,
`no-floating-promises`, `switch-exhaustiveness-check`,
`no-explicit-any`, `no-non-null-assertion`, `consistent-type-imports`,
`max-lines: 400`, `max-lines-per-function: 60`, `no-restricted-imports`
forbidding a package from importing another package directly (only
`lib/` and contracts). `check` runs both and fails on a warning.

`AGENTS.md` states these rules for any agent that edits the repository
later, in the same imperative form, and names the four documents an
editor must read first.

## Working method

Commit small and green; every commit passes `check` and `test`. The
message says what the commit defends, citing the id, in the same style
as the records. When you discover the design cannot be built as
written, write the record before the workaround. When you discover the
design is silent, choose the option that keeps the kernel smaller and
the guarantee intact, write the test that pins your choice, and add one
line to `docs/decisions-taken.md`. When you finish milestone A, write
`docs/milestone-a.md`: what was built, the measured numbers, every
decision taken, every record proposed, and what you would attack next.
