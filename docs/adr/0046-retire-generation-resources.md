# ADR 0046 · Retire generation resources when their authority ends

**Status:** Accepted · 2026-09-10
**Deciders:** runtime implementers, under the operator's P1/P2 fix authorization
**Amends:** generation preparation and ephemeral identity implementation
**Preserves:** GN-002, GN-006, KS-006–008 and immutable recovery records

## Context

Successful switches retain every run directory. The 128-entry preparation pool
therefore fills during normal operation and also prevents reset and restart.
Some older run directories contain immutable pins referenced by later runs,
undo revisions and frozen default manifests, so deleting all old directories
would break recovery. Separately, closed transient executions and empty
authority descriptors leave permanent entries in the generation identity map.

## Decision

Separate immutable pin retention from active run workspaces. Store newly copied
pins by their verified digest beneath the target's `pins` directory. Bound this
pool to 1,024 distinct digests; a previously retained digest remains usable at
capacity. Keep historical pins for undo and immutable default manifests.

After a durable LIVE checkpoint and retirement of prior processes, remove
inactive run workspaces. Preserve legacy `runs/*/pins` anchors, but remove their
retired state and endpoints. Count active workspaces separately from the public
endpoint and legacy pin anchors. Validate canonical directories before cleanup;
unexpected links or entries fail closed. Cleanup errors remain visible. Never
delete the live workspace, immutable state snapshots or pin anchors.

Give identity an explicit ephemeral-target retirement operation. It revokes all
credentials for that target and releases its fencing slot only when the owning
transient execution or empty descriptor is closed. Persistent deployment and
person targets retain their generation history, including after token expiry
or revocation. Runtime-owned fresh random target IDs are never reused.

## Alternatives considered

Increasing the run or identity limits merely postpones exhaustion. Deleting old
pin paths invalidates durable recovery metadata. Clearing fencing state whenever
a token expires permits persistent targets to admit stale epochs.

## Consequences

Repeated edits of retained revisions and repeated isolated executions release
their workspace and identity capacity. New distinct immutable content still
has an explicit storage budget. Legacy pin paths remain valid after upgrade,
and existing checkpoints and manifests need no rewrite.

## Revisit

When immutable snapshot retention gains reference-based collection across
deployment history, or ephemeral target identifiers acquire persistent meaning.
