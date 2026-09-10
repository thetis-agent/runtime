#!/usr/bin/env bash
# ADR 0017: discover package names and refuse them in physical kernel sources.
set -euo pipefail
: "${THETIS_PACKAGES:?Set THETIS_PACKAGES to the reviewed package checkout}"
[[ -d kernel && -d "$THETIS_PACKAGES" ]]
# Process substitution hides discovery failures from set -e; an empty inventory is not a pass.
manifests=$(find "$THETIS_PACKAGES" -mindepth 2 -maxdepth 2 -name package.json -type f | sort)
[[ -n "$manifests" ]]
found=0
while IFS= read -r manifest; do
  name=$(jq -er '.name' "$manifest")
  # Manifests use npm workspace names; registry names are their directory names.
  directory=$(basename "$(dirname "$manifest")")
  for term in "$name" "$directory"; do
    if grep -rnFw --include='*.ts' --exclude='*.test.ts' -- "$term" kernel; then
      found=1
    else
      status=$?
      [[ $status == 1 ]] || exit "$status"
    fi
  done
done <<< "$manifests"
exit "$found"
