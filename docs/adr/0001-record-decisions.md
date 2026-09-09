# ADR 0001 · Record architecture decisions

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session
**Supersedes:** nothing

## Context

Thetis kept its reasoning in module doc comments and dated design records
under `docs/plans`. That was enough to write a post-mortem in an
afternoon, and not enough to stop the same argument from being had
twice: the successor's design went through seven drafts in one day, and
three of the reversals (npm as transport, package kinds, gateways as a
contract) were positions that had already been argued and lost, or won,
in an earlier round nobody re-read.

## Decision

Every architecture decision gets one file in this directory, in this
format: title, status, deciders, what it supersedes, context, decision,
alternatives considered with the reason each lost, consequences good and
bad, and when to revisit. Records are numbered in order of acceptance and
never edited after acceptance except to change the status line. A
reversal is a new record that names the one it supersedes.

A record is written when a decision is made that would cost more than a
day to reverse, or when the same question is asked a second time.

## Consequences

Good: the argument is had once, and the reader who asks "why not X" finds
the answer under X. Bad: a record is work, and a decision without one
will sometimes be made anyway; the register in `05-successor.md` is the
backlog of those.

## Revisit

Never. The format may change; the practice does not.
