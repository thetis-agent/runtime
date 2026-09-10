#!/usr/bin/env bash
# Only the aggregate gate may turn staged delivery into a release candidate; ADR 0035.
set -euo pipefail
[[ ${RESOLVE_RESULT:-} == success && ${GATES_RESULT:-} == success && ${TEST_RESULT:-} == success ]]
directory=${1:?Provide the staged delivery directory}
cd "$directory"
sha256sum --check --strict SHA256SUMS
jq -e --arg runtime "$RUNTIME_COMMIT" --arg packages "$PACKAGES_COMMIT" \
  '.runtime.commit == $runtime and .packages.commit == $packages and .delivery.mode == "gates"' provenance.json
jq '.delivery.mode = "verify"' provenance.json > provenance.json.tmp
mv provenance.json.tmp provenance.json
sha256sum thetis-distribution.tar.gz package.json profile.lock.json registry.json registry.bundle provenance.json platform.txt kernel-pins.json install.sh > SHA256SUMS
sha256sum --check --strict SHA256SUMS
