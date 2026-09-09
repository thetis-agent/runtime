# ADR 0006 · Contracts are packages, with a schema and a conformance test

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session
**Supersedes:** nothing; completes the requirements model of the seventh draft

## Context

Packages communicate through interfaces: a service by name and version,
a stage by the event it answers, every package by the shape of turn
events, and every environment by the host socket. The seventh draft
versions all of these by name and semantic range, and the host matches
ranges. It does not say where an interface's shape lives, who owns it,
how a provider proves it conforms, or what a version bump of a contract
means. Thetis's contract was one WIT file that could not widen a record
and that rebuilt 166 guests on each of its 17 changes. PrimeAgent's
answer, for its socket, is a change-class rule with tests in both
directions.

## Decision

1. **A contract is a package.** It provides `contract/<name>: <version>`
   and contains the TypeScript types, a JSON schema for every message,
   and a conformance test suite. It contains no implementation. A
   provider and a requirer of `service/<name>` both `requires:
   { contract/<name>: "^N" }`; the name without a contract package is
   refused at publish with the one-sentence gap.
2. **The contract's test runs against every provider at publish**, as
   part of the checks, in the clean host environment. The contract is a
   different package from the provider, so the provider is not scoring
   itself (ADR 0004). A provider that fails the suite for the version it
   claims is refused.
3. **The semver floor covers contracts.** The host diffs the schema
   between versions: a removed or renamed field or message, a new
   required field on input, or a narrowed type on output forces a major;
   a new optional field or a new message forces at least a minor; text
   forces a patch. The author can go higher, never lower.
4. **Readers ignore unknown fields; writers never remove without a
   major.** Every schema is open by default. This is Thetis's `ipc.rs`
   rule as a contract rule, and it is why most contract changes are
   minors that touch no consumer.
5. **A provider may provide more than one major**, `provides:
   { service/x: ["1.9.0", "2.0.0"] }`, so a migration can run with
   requirers on both sides. The host still treats the name as a
   singleton per profile.
6. **Every message carries the contract version it was written to.**
   A receiver that gets a major it does not know refuses with the name;
   a minor it does not know is accepted and unknown fields are ignored.
7. **The turn events are a contract shipped by `core`** as
   `contract/turn-events`, and the host socket is `contract/host-socket`
   shipped by the host. Both follow the same rules as any other; a major
   on either is a release that groups the packages it touches. The
   socket additionally negotiates capabilities at connect and its
   changes are tested old-client against new-host and the reverse.
8. **The review page lists, per contract, which majors the default
   provides and which packages require each.** A requirer of a major
   nobody provides is a gap error, never a runtime surprise.

## Alternatives considered

**The first provider defines the contract implicitly.** Lost: two
providers diverge and nothing detects it.

**Contracts in the host.** Lost on the rule that the host names
nothing; and a contract in the host would need a host pull request to
change, which is Thetis's kernel again.

**Types only, no conformance test.** Lost: a claimed version is then a
promise nobody checks, and ADR 0004 requires that what can be tested is
tested by something other than itself.

**One global contract file** (Thetis's WIT). Lost: one change rebuilt
everything; a record could not widen; ownership was the kernel's.

## Consequences

Good: a contract changes like anything else, by a version and a review;
its consumers are listed; a provider proves conformance before it is
default; a minor never breaks a consumer; a major is visible as a
release that carries its consumers with it.

Bad: a service now needs two packages, the contract and the provider,
and the first author of a service writes both; contract tests are real
work and a thin one proves little; the host must diff schemas, a few
hundred lines using a standard schema library.

## Revisit

When a contract's conformance suite is found to pass for a provider that
is wrong in practice, the suite is the bug. When contract packages
outnumber providers, the granularity is wrong and contracts should be
grouped.
