#!/usr/bin/env bash
# Repo check for design-with-gemini. Run from anywhere: `bash scripts/check.sh`.
#
#   1. Every stylesheet and script that index.html (and each standalone phone page)
#      references exists, and every cell script/stylesheet on disk is either wired
#      into a page or is a Node-only file (*.test.*, *.mjs).
#   2. Every .js / .mjs file parses (`node --check`).
#   3. The page scripts, concatenated in index.html order, parse as ONE program.
#      They are classic <script defer> files that share a single global scope, so a
#      top-level `const` / `let` / `class` declared in two cells is a load-time
#      SyntaxError in the browser that no per-file check can see.
#   4. All Node test suites pass (`node --test`).
#
# Exit code 0 means all four passed. This does not exercise the page in a browser.

set -u
cd "$(dirname "$0")/.." || exit 2

fail=0
note() { printf '%s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fail=1; }

refs() { # refs <html-file> <attr>  ->  paths relative to the repo root
  local html=$1 attr=$2 dir
  dir=$(dirname "$html")
  grep -oE "${attr}=\"[^\"]+\.(js|css)\"" "$html" | sed -E "s/^${attr}=\"//; s/\"$//" |
    grep -vE '^(https?:)?//' | while read -r p; do
      if [ "$dir" = "." ]; then printf '%s\n' "$p"; else printf '%s\n' "$dir/$p"; fi
    done
}

# 1. Wiring ------------------------------------------------------------------
wired=$(mktemp); trap 'rm -f "$wired" "${bundle:-}"' EXIT
pages=$(git ls-files '*.html')
for page in $pages; do
  { refs "$page" src; refs "$page" href; } | while read -r p; do
    printf '%s\n' "$p" >> "$wired"
    [ -f "$p" ] || printf 'MISSING %s (referenced by %s)\n' "$p" "$page"
  done
done > "$wired.missing"
if [ -s "$wired.missing" ]; then
  while read -r line; do bad "$line"; done < "$wired.missing"
fi
rm -f "$wired.missing"

for f in $(git ls-files 'cells/*.js' 'cells/*.css'); do
  case "$f" in *.test.js) continue ;; esac
  grep -qxF "$f" "$wired" || bad "$f is not referenced by any page"
done
note "wiring   $(sort -u "$wired" | wc -l | tr -d ' ') files referenced by $(printf '%s\n' $pages | wc -l | tr -d ' ') page(s)"

# 2. Per-file syntax -----------------------------------------------------------
n=0
for f in $(git ls-files '*.js' '*.mjs'); do
  n=$((n + 1))
  node --check "$f" 2>/dev/null || { bad "syntax: $f"; node --check "$f" 2>&1 | head -5; }
done
note "syntax   $n files"

# 3. Shared global scope -------------------------------------------------------
bundle=$(mktemp).js
for f in $(refs index.html src); do
  [ -f "$f" ] || continue
  printf '\n// ==== %s\n' "$f"; cat "$f"; printf '\n;\n'
done > "$bundle"
if node --check "$bundle" 2>/dev/null; then
  note "globals  index.html scripts parse as one program"
else
  bad "index.html scripts collide in the shared global scope:"
  node --check "$bundle" 2>&1 | head -8
fi

# 4. Tests ---------------------------------------------------------------------
out=$(timeout 600 node --test 2>&1); code=$?
printf '%s\n' "$out" | grep -E '^# (tests|pass|fail|cancelled|skipped) ' | tr '\n' ' '; printf '\n'
if [ $code -ne 0 ]; then
  bad "node --test exited $code"
  printf '%s\n' "$out" | grep -E '^not ok' | head -20
fi
tests=$(printf '%s\n' "$out" | sed -nE 's/^# tests ([0-9]+)$/\1/p')
[ "${tests:-0}" -gt 0 ] || bad "node --test ran zero tests"

[ $fail -eq 0 ] && note "OK" || note "CHECK FAILED"
exit $fail
