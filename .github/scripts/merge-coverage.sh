#!/usr/bin/env bash
# Merge execution counts before recomputing percentages; never add shard percentages or duplicate source totals.
set -euo pipefail
inputs=${1:?Provide the shard reports directory}
output=${2:?Provide the merged coverage directory}
arguments=()
for shard in 1 2 3 4; do
  report="$inputs/$shard/coverage/lcov.info"
  [[ -s "$report" && $(stat -c %s "$report") -le 67108864 ]]
  arguments+=(--add-tracefile "$report")
done
mkdir -p "$output"
temporary=$(mktemp "${RUNNER_TEMP:-/tmp}/thetis-lcov.XXXXXX")
trap 'rm -f "$temporary"' EXIT
lcov --branch-coverage "${arguments[@]}" --output-file "$temporary"
node --import ./runtime/lib/artifacts/source.mjs runtime/scripts/coverage-summary.ts "$temporary" "$output"
