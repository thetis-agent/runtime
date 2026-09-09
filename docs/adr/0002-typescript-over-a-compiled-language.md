# ADR 0002 · TypeScript over a compiled language

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session, after the round-one runtime critic and the PrimeAgent study
**Supersedes:** Thetis's choice of Rust for the kernel and Rust-to-WebAssembly for every guest

## Context

Thetis is Rust throughout: a 61,197-line kernel in one crate, an agent and
163 tools compiled to `wasm32-wasip2`, and a JavaScript UI with no build
step. The operator's assessment of that choice, in their words: the
compiler is second to none at stopping an LLM from making benign footgun
errors, and it is incredibly slow, and they are unsure the project gets
enough from Rust to justify it.

The measured cost, from [01-as-built.md](../01-as-built.md):

| Cost | Value |
| --- | --- |
| Incremental release build of the kernel, one crate touched, 80 cores | 63 s |
| Build ceiling in configuration; unit start timeout to survive it | 900 s; 1,200 s |
| Guests rebuilt when the WIT contract changes (17 times in 12 days) | 166 |
| Build output on disk | 7.3 GB `target/`, 4.4 GB `artifacts/`, 0.8 GB two more targets |
| Tool crates that are copies, because a wasm component cannot share code | 145 of 163 |

The successor's requirements that bear on the choice
([00-proposal.md](../00-proposal.md)): the agent edits packages daily and
the edit-to-serve target is under one second; the host is about 1,400
lines and is edited by people with a pull request; a package is a
directory the loop imports; the hot swap is a process restart at a turn
boundary; the host and one idle environment fit in 120 MB.

## Decision

TypeScript for the host, the core, and every stage. Node as the runtime.
No build step; the type checker in strict mode is the gate, run as the
first check at publish and returned in the tool result when the agent
edits a package, exactly as the compiler's verdict was in Thetis.

Services (`spawn`) are outside this decision. A service is a process
behind a socket and may be in any language; the requirements model
matches it by name. A component that needs predictable CPU or memory
behaviour, such as a vector index over a large corpus, is a service, not a
stage, and this record does not constrain it.

## What the compiler gave, and what replaces it

The operator's claim is specific: the compiler stops benign footguns. The
defence has to be equally specific about which ones.

| Footgun an LLM makes | Rust | Strict TypeScript | Gap |
| --- | --- | --- | --- |
| Wrong or misspelled field name | compile error | compile error (`strict`) | none |
| Forgetting a value can be absent | `Option` forces handling | `strictNullChecks` forces handling | none |
| Unhandled case in a union or enum | `match` must be exhaustive | exhaustive `switch` with `never`, enforced by the `switch-exhaustiveness-check` lint | lint, not compiler; same verdict in the same tool result |
| Forgetting to await a promise | `#[must_use]` on futures | `no-floating-promises` lint | lint |
| Reading an array index that may not exist | bounds-checked, panics | `noUncheckedIndexedAccess` makes it `T \| undefined` | none |
| Leaking `any` into typed code | impossible | `noImplicitAny` plus `no-explicit-any` lint | lint |
| Trusting JSON from a boundary | `serde` derives a typed parse | a schema library validates at the boundary; the same discipline, one library | none, if the rule "every boundary validates" is kept |
| Use after move, dangling reference, double free | prevented | not applicable; garbage collected | none |
| Data race between threads | prevented by `Send`/`Sync` | not applicable; one event loop per process, workers pass messages | none, given the design |
| Integer overflow | checked in debug, wrapping in release | numbers are doubles; `BigInt` where exactness matters | a real gap for arithmetic on large integers; the host has none |
| Silent performance cliff | predictable | garbage collector pauses, JIT warm-up | a real gap; irrelevant to an I/O-bound host of 1,400 lines |

Nine of eleven rows close with the type checker plus four lint rules and
one boundary rule. The two that stay open, integer arithmetic and
performance predictability, do not occur in the host or the stages and
are handled by the service escape hatch when they occur anywhere.

The same tool-result loop is what makes either language work for an
agent: the verdict comes back inside the turn, and the model fixes it
before reporting. Thetis proved the loop with `rustc`; PrimeAgent runs it
with `tsgo --noEmit` at 200,000 lines ([10-prime-agent.md](../10-prime-agent.md)).
The loop is the safety property. The language is the cost of running it.

## Alternatives considered

**Rust, split into small crates, with a build-time budget.** The first
draft's choice. A 1,400-line host would build in seconds, and `cache.rs`,
`auth.rs`, `store.rs` and the ranker would lift verbatim. Lost on two
counts: seconds is not the sub-second edit loop the agent needs for the
packages it edits daily, so packages would be TypeScript anyway; and a
Rust host with TypeScript packages is two toolchains, two test runners,
and an IPC seam between them, which is the thing the design just paid to
remove. One language beats the best of two.

**Go for the host.** Compiles in about a second, ships one static binary,
and the operator would keep a compiled trusted core. Lost for the same
two-toolchain reason, plus a weaker answer to the footgun table: no sum
types, `nil` without a checker, and errors as values the model forgets to
check. Go's speed advantage is real and is moot for a host that proxies
streams and shells out to git.

**Rust for everything, without WebAssembly.** Packages as native crates
loaded by the loop. Lost on the edit loop: every package edit is a cargo
build, and Thetis measured what that costs. The wasm boundary was the
reason Rust was tolerable for guests, because it made hot swap safe; with
process restart as the hot swap, the reason is gone.

**Python.** The other language LLMs write well, and PrimeAgent's kernel
choice. Lost on the footgun table: type hints are optional and unchecked
at runtime, so the same tool-result loop returns a weaker verdict.

## Consequences

Good:

- Edit-to-serve is a file write and a process restart. The 63-second step
  is gone from the loop.
- One language for host, core, stages and UI. One test runner, one lint
  configuration, one house-rules file for the agent (PrimeAgent's
  `AGENTS.md` is the model).
- `cache.rs`, `auth.rs`, the ranker and the spill logic port at a few
  hundred lines each; the port list is in [07-keep.md](../07-keep.md).
- Idle memory drops from 820 MB to a Node process, around 40 MB, plus one
  per environment.
- The UI, the one part of Thetis the operator wanted to keep unchanged,
  is already this language.

Bad:

- The four lint rules are as load-bearing as the type checker and must be
  in the checks from milestone A; a profile that turns them off has
  weakened the gate and the review page should say so.
- Every boundary must validate its input with a schema: the host socket,
  `package.json`, every event payload. Rust made this hard to forget;
  here it is a rule and a test.
- A misbehaving stage can block the event loop of its environment. The
  memory limit, the health probe and the turn-boundary restart bound the
  damage to that person's environment, which is the intended boundary.
- Anyone who wanted the trusted host to be memory-safe by construction
  does not get that. The host is 1,400 lines, edited by people, behind a
  reverse proxy, for colleagues; the review is the guarantee.

## Revisit

When a measured number says so: if the host's own latency or memory
appears in the turn log as a cost, or if a footgun class not in the table
above produces a regression the checks did not catch. The service escape
hatch is the first answer to either; a compiled host is the second, and
it would be Go, for the two-toolchain cost is then unavoidable and Go's
is the smaller.
