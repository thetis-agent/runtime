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

Both repositories' CI workflows check out runtime with `fetch-depth: 0`,
as the release workflows already do, to include the tagged history. The
tag must also exist in `thetis-agent/runtime` on GitHub. Publish the
existing local baseline once from the runtime checkout, after verifying
its commit:

```sh
test "$(git rev-parse 'refs/tags/compatibility/socket-v1.0.0^{commit}')" = d8aa0d1200c7c24a0fa7f671c41eece204b377fe
git push origin refs/tags/compatibility/socket-v1.0.0:refs/tags/compatibility/socket-v1.0.0
```

Keep that tag protected against updates and deletion. Do not recreate it
from the current checkout or force-push a replacement.

The shared suite checks negotiated capabilities, valid and invalid method
parameters, unknown fields, inherited identity and per-operation fencing.
It loads the archived implementations unchanged and mounts the pinned
dependency installation read-only. No network or model is involved.

The public socket contract remains major 1. Kernel and client implementation
minor 1.1 adds the managed generation path and reserved control capacity.
Method-specific acceptance tests remain separate; this matrix does not
claim that unfinished kernel methods satisfy their conformance suites.
