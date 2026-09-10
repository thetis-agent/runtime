#!/usr/bin/env bash
# ADR 0002, ADR 0037, ADR 0055: CI verifies; release mode assembles previously reviewed sources.
set -euo pipefail
mode=${1:-verify}
case "$mode" in verify|assemble) ;; *) printf 'Unknown delivery mode: %s\n' "$mode" >&2; exit 2 ;; esac
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
node_version=$(node --version)
curl -fsSL --proto '=https' --proto-redir '=https' "https://nodejs.org/dist/$node_version/SHASUMS256.txt" > reports/node-shasums.txt
node_x64=$(awk -v f="node-$node_version-linux-x64.tar.xz" '$2==f{print $1}' reports/node-shasums.txt)
node_arm64=$(awk -v f="node-$node_version-linux-arm64.tar.xz" '$2==f{print $1}' reports/node-shasums.txt)
[[ $node_x64 =~ ^[a-f0-9]{64}$ && $node_arm64 =~ ^[a-f0-9]{64}$ ]]
jq -n --arg runtime "$runtime_commit" --arg packages "$packages_commit" \
  --arg runtime_repository "$runtime_repository" --arg packages_repository "$packages_repository" \
  --arg node_version "$node_version" --arg node_x64 "$node_x64" --arg node_arm64 "$node_arm64" \
  --arg workflow "$GITHUB_WORKFLOW_REF" \
  --arg mode "$mode" --arg tooling "${THETIS_TOOLING_COMMIT:-$runtime_commit}" \
  --arg run "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  '{version: 1, runtime: {repository: $runtime_repository, commit: $runtime}, packages: {repository: $packages_repository, commit: $packages}, node: {version: $node_version, sha256: {"linux-x64": $node_x64, "linux-arm64": $node_arm64}}, generator: "node:stripTypeScriptTypes:strip", workflow: $workflow, run: $run, delivery: {mode: $mode, toolingRuntime: $tooling}}' > reports/provenance.json
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
node --import ./lib/artifacts/source.mjs scripts/build.ts 2>&1 | tee "$workspace/reports/build.log"
if [[ "$mode" == verify ]]; then
  gate check node --import ./lib/artifacts/source.mjs scripts/check.ts
  gate kernel-size node --import ./lib/artifacts/source.mjs scripts/size.ts
  gate kernel-boundary bash .github/scripts/kernel-boundary.sh
fi
# GN-002 must read this job's bundle, rather than the previously committed seed.
node --import ./lib/artifacts/source.mjs scripts/release.ts 2>&1 | tee "$workspace/reports/registry.log"
# Includes conformance inventory, providers and dependants, recovery, deployment
# smoke tests, evaluator isolation and the actual latency/RSS acceptance limits.
if [[ "$mode" == verify ]]; then
  gate test node --import ./lib/artifacts/source.mjs scripts/test.ts --coverage "$workspace/reports/coverage"
  if [[ -f "$workspace/reports/coverage/summary.md" ]]; then
    cat "$workspace/reports/coverage/summary.md" >> "$GITHUB_STEP_SUMMARY"
  else
    printf '\nCoverage report unavailable; inspect the test gate log.\n' >> "$GITHUB_STEP_SUMMARY"
  fi
else
  printf '\nRelease assembly uses reviewed main history; CI acceptance and coverage are not rerun (ADR 0055).\n' >> "$GITHUB_STEP_SUMMARY"
fi
if (( failures != 0 )); then
  printf '::error::%s acceptance gate(s) failed; delivery is blocked.\n' "$failures"
  exit 1
fi
node --import ./lib/artifacts/source.mjs scripts/distribution.ts "$workspace/delivery"
cp profiles/default/{package.json,profile.lock.json,registry.json,registry.bundle} "$workspace/delivery/"
cp "$workspace/reports/provenance.json" "$workspace/delivery/"
cp "$workspace/reports/platform.txt" "$workspace/delivery/"
cp install.sh "$workspace/delivery/"
node --import ./lib/artifacts/source.mjs scripts/kernel-pins.ts > "$workspace/delivery/kernel-pins.json"
cd "$workspace/delivery"
sha256sum thetis-distribution.tar.gz package.json profile.lock.json registry.json registry.bundle provenance.json platform.txt kernel-pins.json install.sh > SHA256SUMS
sha256sum --check --strict SHA256SUMS
# Release signing runs only in the protected publication job, after all candidate code has finished.
