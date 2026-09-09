# ADR 0013 · The stored prefix replaces the perpetual pin

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session, from the Codex debate (A1, S4, F2)
**Supersedes:** ADR 0007 §5 and ADR 0010 §4 (the pin replayed through `retrieve` and `offer` on every turn)

## Context

ADR 0007 pinned the skills and offer schemas per conversation and had
the core pass `pinned` back into `retrieve` and `offer` on every turn so
handlers would reconstruct the same bytes. That reconstructed immutable
data every turn, needed the package bytes to survive for the life of
the conversation, put mutable harness notes inside "the prefix" by the
contract's own sentence, and made a current handler serve a stale
schema it might no longer implement.

## Decision

1. **The core renders the prefix once**, before the first model request
   of a conversation: the `system` and `skills` sections and the offered
   tool definitions, with their hashes and the renderer version, stored
   as one object in the conversation. Later turns load it. `retrieve`
   runs on turn 1 and on a refresh, not on every turn.
2. **The prefix is `system`, `skills`, and `offer`.** `harness` follows
   it and is mutable. Rule 7 is rewritten to say so.
3. **A refresh happens at an announced change:** the profile changed, or
   a derived `offer` (a remote server's list) changed and the handler
   said so. The core re-renders, the conversation pays one cache miss,
   and the one-line notice names what changed. No handler serves a
   stale schema; ADR 0010's `gone` answer is no longer needed for that
   case.
4. **Retention follows the object.** The prompt no longer needs package
   bytes after turn 1; skill files the model may read are kept in the
   local cache while a conversation references them, and the reference
   is the stored object, written before the first request, so GC cannot
   race it. A missing hash is never silently substituted.

## Consequences

Good: turn 2 onward reads one object instead of re-running retrieval
and re-hashing; the contradiction about harness notes is gone; a
profile update no longer creates stale-schema calls.

Bad: a profile update costs each open conversation one cache miss,
about ten times one turn's prompt cost, once.
