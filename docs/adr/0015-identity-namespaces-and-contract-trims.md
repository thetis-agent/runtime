# ADR 0015 · Identity, package namespaces, registry changes, and contract trims

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session, from the Codex debate (F3, F4, F11, F15, S1, S2, S3, S11, A3, A5)
**Amends:** ADR 0006 §5, §6; ADR 0010 §3; contracts/turn-events, host-socket

## Decision

1. **A gateway returns identity evidence, never a person.** The host
   resolves the person from its own bindings: its cookie, or an external
   id a person linked through the host page. Where only the gateway can
   verify an external id, the administrator designates it an
   authentication authority for that kind, and it may only name
   accounts that linked that kind. Project membership is resolved by
   the host per request.
2. **A package name belongs to the registry that first published it**
   in this marketplace. A version ref is created atomically; different
   content at an existing version is refused to the second publisher
   by name. Resolution records registry and commit.
3. **Removing a registry stops discovery; resolved hashes stay usable.**
   Revocation is a separate explicit act. Profiles record the registry
   generation they were resolved against.
4. **One major per resolved service.** Dual-major provision is dropped.
   A make-default that would leave a profile in use requiring a major no
   longer provided is refused, naming the profiles.
5. **A contract may ship inside its first provider** and is extracted
   into its own package when a second provider is published. Events
   carry no per-message `v`; a contract's version is negotiated once
   per connection and carried by the package.
6. **Each event declares its hook type** in `contract/turn-events`:
   observe (`input`, `token`, `output`, `end`), append (`context`),
   answer (`offer`), own (`call`), single (`retrieve`), emit (`notice`).
   The generic "return a changed payload or appended events" is gone.
7. **The semver floor is trimmed** to what is provably breaking: a
   removed tool, field, message or skill id, or a new required input,
   forces a major. Nothing else is inferred. `derived` fields stay
   excluded.
8. **Deleted:** `ToolDef.group` until an attention stage exists;
   `log.append`; the file tools' `no-delete` mode and protected list.
9. **The socket** has a control channel (cancel, health, stop) separate
   from bulk; frames are bounded; tokens are batched; telemetry is
   summarized per turn, not per token.
10. **Spill files** are named by call id, finalized atomically, hashed,
    and written through a sink the core gives a handler so a result is
    never materialized whole to be spilled.
