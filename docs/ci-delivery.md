# CI and release delivery

Both `thetis-agent/runtime` and `thetis-agent/packages` own `CI` and `Release`
workflows. Runtime owns the shared verification action and tooling; package
sources remain in their own checkout (ADR 0035). Land the runtime tooling before
enabling the package workflows. Select revisions containing the shared action,
schema validators and ADR 0037 execution-artifact support; earlier revisions
without that tooling cannot run this pipeline.

## Verification

Pull requests, merge queues, pushes to `main`, manual runs and daily schedules
run `Full CI` on a fresh GitHub-hosted Ubuntu 24.04 x64 VM. There are no path
filters: contract and dependency changes need the same combined suite as package
changes. The peer defaults to `main`; repository variables `THETIS_PACKAGES_REF`
(runtime) and `THETIS_RUNTIME_REF` (packages) may pin a supported peer commit.
Manual CI's `peer_ref` allows testing coordinated changes before either is merged.
The report records the resolved commits of both checkouts, including a PR's
tested merge commit. A rerun against a moving peer branch may resolve new bytes;
release builds always require the peer's complete commit hash.

The pipeline performs these blocking checks:

| Check | Requirement |
| --- | --- |
| Locked `npm ci --ignore-scripts` bootstrap | Exact reviewed dependency closure, no lifecycle scripts |
| Bounded offline artifact build | ADR 0037: sources remain editable; generated JavaScript records source/output hashes and Node version |
| `scripts/check.ts` | Committed contract types, schema validators and loader freshness; strict TypeScript; zero-warning lint; artifact freshness |
| `scripts/size.ts` and kernel name scan | 1,300-line kernel budget excluding comment-only lines (ADR 0039), with physical/excluded totals; package ignorance |
| Fresh `scripts/release.ts` output | Real immutable registry objects, matching profile pins and bundle checksum |
| Complete `scripts/test.ts` | All runtime/package tests, conformance inventory, dependants, socket compatibility, evaluator isolation, generation recovery, deployment smoke, latency and RSS limits |

Build and release commands use mandatory bubblewrap with no network. Tests use
the existing dedicated systemd user scope, cgroup v2 controllers, bounded tmpfs
mounts and nested sandboxes. The VM setup enables unprivileged namespaces under
Ubuntu's host policy, installs the boundary tools, starts the user manager and
checks `/dev/net/tun`. It refuses other runner environments; do not run that setup
on a deployment host. The job records installed platform versions and hashes.

The pipeline checks committed validators instead of regenerating stale output.
Untracked `.ts.js` and `.ts.artifact.json` files are built with **Node 24.18.0**
and checked before tests. The bundle is regenerated before the suite so GN-002
reconstructs this run's exact release offline and exercises hash-tamper refusal.
Tests need no real keys, models or private evaluator material. Paid live checks
are excluded. Public CI results do not become production evaluator evidence
(ADR 0014).

Logs and source provenance are retained on failures. Any failed check blocks
candidate upload and publishing; tests, size and performance are never allowed
to fail silently. Existing kernel-size, memory or latency failures must be fixed
in the product before a release can pass. The complete suite already runs the
acceptance measurements, so CI does not run `bench` a second time.

## Repository configuration

1. Enable Actions in both repositories and protect `main` with reviewed pull
   requests and the `Full CI` required check. Include it in merge-queue rules.
   Protect changes to workflows and runtime gate tooling with code review.
2. If the peer is private, create a dedicated read-only fine-grained token with
   Contents access to the peer repository and store it as `THETIS_SOURCE_TOKEN`.
   The ordinary `GITHUB_TOKEN` is scoped to its own repository. Public peers need
   no extra secret. Fork runs without peer access fail; they do not switch to a
   privileged `pull_request_target` execution path. Maintainers can review and
   run accessible coordinated commits through manual CI.
3. Create the `release` environment in both repositories. Restrict it to `main`
   and configure required reviewers and bypass policy where the GitHub plan
   supports them. A workflow's environment declaration alone does not create
   protection rules. See [GitHub environment configuration](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
4. Protect `v*` tags against update/deletion and restrict their creation to release
   maintainers. Enable repository immutable releases where available. Publication
   itself refuses an existing release, never uses `--clobber`, and checks that
   the tag still resolves to the tested commit before creating a draft.
5. Allow the publishing job's `contents: write` permission. Checkout/build jobs
   have read-only tokens and never persist git credentials. The publishing job
   downloads the same run's verified artifact and executes no candidate code.

Actions are pinned by full upstream commit hashes. Dependabot proposes weekly
GitHub Actions updates in both repositories; review and test those updates.
There is no shared execution cache between principals or generations (ADR 0036).

## Publish a reviewed pair

Merge and review both revisions. Create a new `vMAJOR.MINOR.PATCH` tag on the
desired commit in the repository that owns this delivery. Run its `Release`
workflow **from main**, supplying that existing tag and the peer's full
40-character lowercase commit hash. Both commits must be on their repository's
`main` history. A coordinated release needs only one delivery publication; both
repositories can deliver the full pair.

The build reruns every gate on that exact pair and retains the files for review.
The `release` environment then controls the publishing job. It rechecks all
checksums and tag identity, uploads all assets to a draft, and publishes only
after upload succeeds. A partial failure leaves a draft for a maintainer to
inspect; a rerun refuses it. Resolve an incomplete draft explicitly or choose a
new version. No existing published asset is replaced.

Each GitHub Release contains:

- `thetis-distribution.tar.gz`: kernel, libraries, contracts, selected packages,
  source and generated JavaScript, the production dependency closure, profiles
  and operating documentation, in the installed directory layout.
- `registry.bundle`, `registry.json`, `profile.lock.json`, `package.json`: the
  matching offline registry and profile, kept together.
- `provenance.json`, `platform.txt`, `SHA256SUMS`: exact source revisions, Node and
  generator identity, workflow/run link, boundary-tool inventory and checksums.

The archive normalizes ordering, timestamps and owner metadata. Node and Linux
boundary tools are platform prerequisites; the archive includes the production
JavaScript dependencies so installation needs no npm network access. GitHub
Release tags label deliveries; they do not replace per-package immutable registry
versions, the allowlisted registry, or kernel installation hash checks.

## Installation and production activation

Download assets from the reviewed release, verify `SHA256SUMS`, and compare
`provenance.json` with the reviewed source pair. Extract the archive into a new
inactive directory. Keep profile, registry metadata and bundle from that same
delivery. Use Node 24.18.0: execution metadata rejects another runtime version.
The archive contains operational code and production dependencies; development
checks run from the separate source checkouts and their locked development tools.

Provision the bounded filesystems, dedicated delegated cgroup, identity settings,
registry allowlist and inherited master-key descriptor described in
[headless startup](headless-startup.md). The example recipe is an assembly input;
it does not provision a seed or contain production credentials. The verified
JavaScript entry uses the included loader:

```sh
node --no-experimental-strip-types --import ./lib/artifacts/register.mjs \
  kernel/main.ts /var/lib/thetis/seed.json
```

Delivery does not activate a default. The authorized deployment evaluator must
produce observed results bound to the actual baseline, candidate, suite, scorer,
provider, model and seeds. A reviewer then reads the kernel's own confirmation
line and submits `default.prepare` / `default.set` with its code and baseline.
The kernel performs CAS, freeze, snapshot, isolated probe, fencing, fresh serving
launch and recovery. Kernel upgrades use its maintenance generation transaction.
GitHub environment approval is a delivery control; it cannot replace that act.
No workflow calls `systemctl restart`, replaces active pins or mounts production
state or secrets into CI (ADR 0012, ADR 0018, ADR 0025–0030).

## Local workflow validation

Run `actionlint` over both repositories' `.github/workflows/*.yml` and `bash -n`
over runtime's `.github/scripts/*.sh`. Use the Node 24.18 binary to run
`scripts/build.ts`, `scripts/check.ts` and `scripts/test.ts` with the sibling
package checkout present. `scripts/distribution.ts /absolute/output` assembles
an archive inside a bounded offline namespace; only the full CI pipeline marks
that archive eligible for publication.
