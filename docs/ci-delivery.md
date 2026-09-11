# CI and release delivery

Both `thetis-agent/runtime` and `thetis-agent/packages` own `CI` and `Release`
workflows. Runtime owns the shared verification action and tooling; package
sources remain in their own checkout (ADR 0035). Land the runtime tooling before
enabling the package workflows. Select revisions containing the shared action,
schema validators and ADR 0037 execution-artifact support; earlier revisions
without that tooling cannot run this pipeline.

## Verification

Pull requests, merge queues, pushes to `main`, manual runs and daily schedules
run `Full CI` across fresh GitHub-hosted Ubuntu 24.04 x64 VMs. There are no path
filters: contract and dependency changes need the same combined suite as package
changes. The peer defaults to `main`; repository variables `THETIS_PACKAGES_REF`
(runtime) and `THETIS_RUNTIME_REF` (packages) may pin a supported peer commit.
Manual CI's `peer_ref` allows testing coordinated changes before either is merged.
For a coordinated pull request, add one line to its body:

```text
Thetis peer commit: <full 40-character lowercase commit hash>
```

PR CI checks out that exact commit from the fixed peer repository. A malformed
or duplicate line fails the job. The body is read as data from the event file;
it is never evaluated as shell code. The pin applies only to that pull request.
Set the line before pushing the branch. Use manual CI to select a different peer
without a new push; rerunning an old PR job retains its original event data.
Push, merge queue and scheduled runs retain the configured peer default. This
selection changes no checks or release requirements.

The report records the resolved commits of both checkouts, including a PR's
tested merge commit. A rerun against a moving peer branch may resolve new bytes;
release builds always require the peer's complete commit hash.
Concurrency is separate for push, pull-request, scheduled and manual runs, so a
delayed daily run cannot cancel the main push whose release candidate is needed.
Newer pushes still replace older push runs on the same branch.

The source-resolution job pins both commit hashes once. Four test jobs then run
in parallel with a separate checkout, systemd scope and bubblewrap namespace per
job. Sorted test files are distributed round-robin across shards `1/4` through
`4/4`; every discovered runtime/package test runs exactly once. Sharding balances
file counts, not measured durations. Each shard keeps `--test-concurrency=1`, the
one-CPU quota, 2 GiB memory ceiling and 256-task limit. This also keeps performance
tests free of competing test files and prevents kernel startup's orphan sweep
from killing another test's processes. Local runs remain sequential by default.

Build, static checks and the installed-service smoke run in a separate job beside
the test matrix. Both paths build from the pinned pair and regenerate their registry
bundle before testing. A failed shard does not cancel the other shards. `Full CI`
always runs, requires every upstream job to succeed, merges coverage and only then
promotes the staged delivery to the existing release-candidate artifact. Missing,
failed, cancelled or skipped gates block promotion. Staged delivery has provenance
mode `gates`; finalization verifies its checksums and exact source pair before
changing the mode to `verify` and refreshing checksums. Releases cannot consume
the intermediate artifact. Intermediate artifact names are stable within a run
and replaced on retry, allowing failed-job reruns to reuse successful jobs from
that same pinned source pair.

CI performs these blocking checks:

| Check | Requirement |
| --- | --- |
| Locked `npm ci --ignore-scripts` bootstrap | Exact reviewed dependency closure, no lifecycle scripts |
| Bounded offline artifact build | ADR 0037: sources remain editable; generated JavaScript records source/output hashes and Node version |
| `scripts/check.ts` | Committed contract types, schema validators and loader freshness; strict TypeScript; zero-warning lint; artifact freshness |
| `scripts/size.ts` and kernel name scan | 1,500-line kernel budget excluding comments, whitespace and static imports, with physical/excluded totals; package ignorance |
| Fresh `scripts/release.ts` output | Real immutable registry objects, matching profile pins and bundle checksum |
| Complete `scripts/test.ts` | All runtime/package tests, conformance inventory, dependants, socket compatibility, evaluator isolation, generation recovery, deployment smoke, latency and RSS limits |
| Real installed-service smoke | Root provisioning on a bounded loopback volume, dedicated service uid, systemd credential delivery and cgroup delegation, terminal chat, restart, chat again and recorded uninstall |

Build and release commands use mandatory bubblewrap with no network. Tests use
the existing dedicated systemd user scope, cgroup v2 controllers, bounded tmpfs
mounts and nested sandboxes. The VM setup enables unprivileged namespaces under
Ubuntu's host policy, installs the boundary tools, starts the user manager and
checks `/dev/net/tun`. It refuses other runner environments; do not run that setup
on a deployment host. The job records installed platform versions and hashes.

The pipeline checks committed validators instead of regenerating stale output.
Both committed and edited-package guard generation use a fresh Ajv instance per
package. Adding, removing or widening an unrelated runtime
schema, or compiling another package first, does not change a package's generated
bytes. Runtime schemas remain available for external references; changing a
referenced contract can still require regeneration in its consumers. The first
adoption of this isolation requires one regeneration of the committed package
guards alongside the runtime generator change. Subsequent unrelated runtime
schema edits no longer require a matching packages change. An actual code
dependency on an unmerged peer API still needs the dependency to land or a
coordinated manual run; validator isolation does not make that pair compatible.

Untracked `.ts.js` and `.ts.artifact.json` files are built with **Node 24.18.0**
and checked before tests. The bundle is regenerated before the suite so GN-002
reconstructs this run's exact release offline and exercises hash-tamper refusal.
Tests need no real keys, models or private evaluator material. Paid live checks
are excluded. Public CI results do not become production evaluator evidence
(ADR 0014).

Logs and source provenance are retained on failures. Any failed check blocks
candidate upload and publishing; tests, size and performance are never allowed
to fail silently. Kernel-size, memory or latency failures must be fixed before a release can pass.
The kernel currently counts 1,423 lines against the operator-approved 1,500-line
ceiling (implementation note 0054), so its size gate passes. The complete suite already runs the acceptance
measurements, so CI does not run `bench` a second time.

## Coverage reports

Both repositories' CI workflows collect coverage in the complete
sandboxed test shards. [Node 24's native coverage reporters](https://nodejs.org/download/release/v24.18.0/docs/api/test.html#coverage-reporters)
provide the LCOV data; no coverage service token or additional npm dependency is
required. Test failures retain their nonzero status, and coverage does not impose
a new percentage threshold or waive performance/conformance assertions.
The child preload stops V8 coverage before `acceptance-performance.test.ts` and
`deployment-assembly.test.ts` run. Both tests still execute and enforce their original RSS/latency limits;
their executions do not contribute coverage. This keeps profiling overhead out
of the quantities those tests measure.

CI uploads a separate `runtime-ci-coverage-*` or `packages-ci-coverage-*`
artifact, including after a failed test gate, retained for 14 days. Release
publication reuses CI's verified bytes and does not generate new coverage. Each artifact
contains `lcov.info`, `summary.json` and `summary.md`; the workflow summary shows
line, branch and function coverage for runtime, packages and their combined total.
LCOV source paths start with `runtime/` or `packages/` to match the two checkouts.
Each shard retains its own coverage and diagnostic artifact even on failure.
The aggregate job installs Ubuntu's `lcov` and combines all four tracefiles with
branch coverage enabled before recalculating weighted summaries. It never adds
per-shard percentages or counts the same source file four times. A missing shard
report or failed merge blocks `Full CI`; complete reports from failing tests can
still produce combined coverage, while their test failure remains blocking.
The LCOV reporter qualifies function names with their source line and occurrence,
so same-name methods on different lines remain distinct and lazy function discovery
does not rename anonymous functions by their changing array index.

The report includes loaded TypeScript source modules under `kernel`, `lib`,
`contracts` and `packages`. It excludes test files, third-party dependencies,
compiled sidecars and tooling. Coverage inheritance is removed before each test
file runs, preserving explicitly restricted child environments. Separately spawned payloads and modules
that no test process loads are outside the native report; these percentages are
not a count of all repository files or a replacement for conformance coverage.
Raw V8 data stays on a bounded 512 MiB temporary mount. Only the reporting
parent uses that temporary directory; the child preload restores ordinary test
temporaries to their existing 64 MiB `/tmp`. The LCOV report streams
through stdout to a host-owned writer capped at 64 MiB; tests receive no writable
host report mount. An empty, malformed, oversized or incomplete report fails the
test command, while valid reports remain available when assertions fail.

Reproduce locally from runtime (the destination is outside the source checkout):

```sh
node --import ./lib/artifacts/source.mjs scripts/test.ts --coverage /tmp/thetis-coverage
```

Existing test-path prefixes may follow the coverage directory for a focused run.
Reproduce a CI partition with `--shard 1/4` (and similarly `2/4`, `3/4`, `4/4`).
The runner accepts at most 16 shards, rejects invalid or repeated options, and
fails an empty selection. Passing path prefixes intentionally limits the selected
suite before sharding; CI supplies no prefixes.

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
3. Create the `release` environment in both repositories. Allow `main` dispatches and protected `v*` tags
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
6. Store the complete unencrypted OpenSSH private key, or base64 of that whole
   file, as `RELEASE_SIGNING_KEY` in the publishing repository's protected
   `release` environment. Only the publication job reads it; CI and
   candidate execution receive no signing key (implementation note 0052). It signs `SHA256SUMS`
   after the installer receives the reviewed tag and public trust root; rotating it ships a new line in the installed
   `allowed_signers` file in a release signed with the key being retired, never
   by rewriting history.

Actions are pinned by full upstream commit hashes. Dependabot proposes weekly
GitHub Actions updates in both repositories; review and test those updates.
There is no shared execution cache between principals or generations (implementation note 0036).

## Publish a reviewed pair

For runtime, merge and review both revisions and wait for the exact runtime
commit's main CI run to succeed. Create and push an annotated `vMAJOR.MINOR.PATCH`
tag on that commit. The tag triggers `Release`; manual dispatch from main remains
available with an existing tag and an optional exact peer commit assertion.

The **Select verified CI delivery** job resolves the annotated tag, requires it
on main history, downloads the successful main CI candidate for that exact SHA,
checks its checksums and provenance, and verifies the tested peer commit is on
packages main. Missing, expired, failed or mismatched candidates block publication.
It runs no candidate code, does not rebuild the archive and does not rerun tests.
An expired candidate requires a new successful CI run before release dispatch.

The public signature is produced only after these checks. CI builds pins from the
actual distribution tree and re-extracts the archive under a restrictive umask to
verify all hashes and execution artifacts. Checkout-only package files are never
included in the published package pin.

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
- `allowed_signers`: the release key's public line, published for convenience and installed
  as `etc/allowed_signers`. It is deliberately **outside** `SHA256SUMS`: the installer's
  trust root is its own embedded copy of this line, never a file the release supplies.
- `provenance.json`, `platform.txt`, `SHA256SUMS`, `SHA256SUMS.sig`: exact source
  revisions, Node identity (version and per-platform release-tarball checksums),
  generator identity, workflow/run link, boundary-tool inventory, checksums and
  the checksum file's `ssh-keygen -Y sign` signature (ADR 0048).
- `install.sh`: the standalone installer with this release's tag and public signing
  identity, included in the signed asset list. Source fragments and generated
  output are checked for freshness before delivery.
- `kernel-pins.json`: the tree hash of each kernel code pin directory (`kernel`,
  `lib`, `contracts`, the vendored production dependency closure and `packages`),
  checked against the extracted archive before the supervised kernel service
  applies an update (ADR 0048).

The archive normalizes ordering, timestamps and owner metadata. Linux boundary tools are platform prerequisites; the installer downloads the exact
Node archive whose x64 or arm64 digest is in signed provenance; the archive includes the production
JavaScript dependencies so installation needs no npm network access. GitHub
Release tags label deliveries; they do not replace per-package immutable registry
versions, the allowlisted registry, or kernel installation hash checks.

## Installation and production activation

Download assets from the reviewed release, verify `SHA256SUMS.sig` against the
installed `allowed_signers` file (`ssh-keygen -Y verify -n zero-release`), check
`SHA256SUMS` itself, and compare `provenance.json` with the reviewed source pair
and the tag it names (ADR 0048). Extract the archive into a new inactive
directory and check `kernel-pins.json`'s tree hashes against it before treating
the kernel code as trusted. Keep profile, registry metadata and bundle from that
same delivery. Use Node 24.18.0: execution metadata rejects another runtime version.
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
that archive eligible for publication. Develop and test the release-verification
path itself against a local, offline, signed release fixture assembled directly
from `scripts/release.ts` and `scripts/distribution.ts` output, signed with a
throwaway key generated inside the test rather than a real `RELEASE_SIGNING_KEY`
(`test/release-fixture.ts`, ADR 0048).

Installer publication embeds the publishing repository's asset URL. The runtime
repository remains the tag authority. A package-repository release therefore
requires the same annotated version tag in runtime at the reviewed peer commit;
its build refuses a missing or mismatched runtime tag. Both workflows require
annotated release tags. The ordinary CI verification job never receives a release
signing key; only the protected publication job signs the verified delivery.

## Signing-key formatting

For `Load key ...: error in libcrypto`, replace `RELEASE_SIGNING_KEY` with the
complete unencrypted key file or the output of `base64 -w0 /path/to/release_ed25519`.
Paste only the key text or encoded value, without Markdown fences. The loader
normalizes CRLF, escaped newlines and base64 wrapping, validates the key without
printing secret data, and removes its temporary file on success or failure.
A public key or fingerprint cannot substitute for the private key.
