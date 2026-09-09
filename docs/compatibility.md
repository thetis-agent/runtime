# Socket compatibility

`test/compatibility.test.ts` runs the same transport checks in two
directions, using real bubblewrap processes and inherited descriptors.

| Client | Kernel | Source |
| --- | --- | --- |
| 1.0 | current 1.1 | archived client from `compatibility/socket-v1.0.0` |
| current 1.1 | 1.0 | archived kernel from `compatibility/socket-v1.0.0` |

The tag is pinned to `d8aa0d1200c7c24a0fa7f671c41eece204b377fe`, an earlier
green implementation commit. It is a local development compatibility
baseline, not a claim that a release was previously deployed. A moved or
missing tag fails the tests. CI must fetch this tag; tests do not fetch it.

The shared suite checks negotiated capabilities, valid and invalid method
parameters, unknown fields, inherited identity and per-operation fencing.
It loads the archived implementations unchanged and mounts the pinned
dependency installation read-only. No network or model is involved.

The public socket contract remains major 1. Kernel and client implementation
minor 1.1 adds the managed generation path and reserved control capacity.
Method-specific acceptance tests remain separate; this matrix does not
claim that unfinished kernel methods satisfy their conformance suites.
