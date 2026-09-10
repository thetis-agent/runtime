#!/usr/bin/env bash
# ADR 0002, ADR 0006, ADR 0037: every acceptance failure blocks delivery.
set -euo pipefail
workspace=$(pwd -P)
export THETIS_PACKAGES="$workspace/packages"
mkdir -p reports delivery
runtime_commit=$(git -C runtime rev-parse HEAD)
packages_commit=$(git -C packages rev-parse HEAD)
runtime_repository=$(git -C runtime remote get-url origin)
packages_repository=$(git -C packages remote get-url origin)
for repository in runtime packages; do
  [[ -z $(git -C "$repository" status --porcelain --untracked-files=all) ]]
done
jq -n --arg runtime "$runtime_commit" --arg packages "$packages_commit" \
  --arg runtime_repository "$runtime_repository" --arg packages_repository "$packages_repository" \
  --arg node "$(node --version)" --arg workflow "$GITHUB_WORKFLOW_REF" \
  --arg run "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  '{version: 1, runtime: {repository: $runtime_repository, commit: $runtime}, packages: {repository: $packages_repository, commit: $packages}, node: $node, generator: "node:stripTypeScriptTypes:strip", workflow: $workflow, run: $run}' > reports/provenance.json
printf 'Runtime commit: %s\n\nPackages commit: %s\n' "$runtime_commit" "$packages_commit" >> "$GITHUB_STEP_SUMMARY"
cd runtime
failures=0
gate() {
  local name=$1
  shift
  if "$@" 2>&1 | tee "$workspace/reports/$name.log"; then
    printf '%s: passed\n' "$name" >> "$GITHUB_STEP_SUMMARY"
  else
    printf '%s: FAILED\n' "$name" >> "$GITHUB_STEP_SUMMARY"
    failures=$((failures + 1))
  fi
}
# Execution artifacts are deliberately untracked; committed schemas and validators
# are checked for freshness by check.ts, never regenerated to make CI pass.
node scripts/build.ts 2>&1 | tee "$workspace/reports/build.log"
gate check node scripts/check.ts
gate kernel-size node scripts/size.ts
gate kernel-boundary bash .github/scripts/kernel-boundary.sh
# GN-002 must read this job's bundle, rather than the previously committed seed.
node scripts/release.ts 2>&1 | tee "$workspace/reports/registry.log"
# Includes conformance inventory, providers and dependants, recovery, deployment
# smoke tests, evaluator isolation and the actual latency/RSS acceptance limits.
gate test node scripts/test.ts
if (( failures != 0 )); then
  printf '::error::%s acceptance gate(s) failed; delivery is blocked.\n' "$failures"
  exit 1
fi
node scripts/distribution.ts "$workspace/delivery"
cp profiles/default/{package.json,profile.lock.json,registry.json,registry.bundle} "$workspace/delivery/"
cp "$workspace/reports/provenance.json" "$workspace/delivery/"
cp "$workspace/reports/platform.txt" "$workspace/delivery/"
cd "$workspace/delivery"
sha256sum thetis-distribution.tar.gz package.json profile.lock.json registry.json registry.bundle provenance.json platform.txt > SHA256SUMS
sha256sum --check --strict SHA256SUMS
