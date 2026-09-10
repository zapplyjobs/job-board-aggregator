#!/usr/bin/env bash
# AGG-GATE-ENCRYPTEDBLOB-1 (SUP F269 advisory, A281 build): fail when ANY tracked file at a
# filter=crypt path does not carry the OpenSSL-salted ciphertext prefix (U2FsdGVkX1) at the
# blob level. Catches Git-Data-API / web-UI writes that bypass the smudge filter and store
# PLAINTEXT (the SUP-IBERDROLA-ADD-1 class: the blob then smudges to garbage on every
# checkout), and empty/placeholder files at encrypted paths (they SHOULD fail per the
# advisory). Reads raw blobs via git cat-file — needs no transcrypt. Paths are resolved via
# git check-attr, so .gitattributes negations (e.g. /package.json !filter) are honored
# automatically. Usage: check-encrypted-blobs.sh [REF]  (default HEAD). Exit 1 if any
# offending blob is found (reporting the first 10).
set -uo pipefail
REF="${1:-HEAD}"

bad=0
checked=0
while IFS= read -r f; do
  checked=$((checked + 1))
  prefix=$(git cat-file blob "$REF:$f" 2>/dev/null | head -c 10)
  if [ "$prefix" != "U2FsdGVkX1" ]; then
    echo "✗ PLAINTEXT/EMPTY at encrypted path: $f (blob prefix: '${prefix:0:10}')"
    bad=$((bad + 1))
    if [ "$bad" -ge 10 ]; then echo "...stopping after 10 offenders"; break; fi
  fi
done < <(git ls-files -z -- '*.js' '*.json' '*.jsonl' \
  | xargs -0 git check-attr filter -- \
  | awk -F': filter: ' '$2 == "crypt" { print $1 }')

echo "checked $checked encrypted-path blobs at $REF"
if [ "$bad" -eq 0 ]; then
  echo "✓ all encrypted blobs carry the ciphertext prefix"
  exit 0
fi
echo "FAIL: $bad encrypted-path blob(s) are plaintext/empty — writes to encrypted paths must go through git with the crypt filter (never Git-Data-API/blob paths)"
exit 1
