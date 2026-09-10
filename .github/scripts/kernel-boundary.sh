#!/usr/bin/env bash
# ADR 0017: discover package names and refuse them in physical kernel sources.
set -euo pipefail
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
done < <(find "$THETIS_PACKAGES" -mindepth 2 -maxdepth 2 -name package.json -type f | sort)
exit "$found"
