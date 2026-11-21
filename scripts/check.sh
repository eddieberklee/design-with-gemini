#!/usr/bin/env bash
# Repo check for design-with-gemini. Run from anywhere: `bash scripts/check.sh`.
#
#   1. Every stylesheet and script that index.html (and each standalone phone page)
#      references exists, and every cell or shared UI script/stylesheet on disk is
#      either wired into a page or is a Node-only file (*.test.*, *.mjs).
#   2. Every .js / .mjs file parses (`node --check`).
#   3. The page scripts, concatenated in index.html order, parse as ONE program.
#      They are classic <script defer> files that share a single global scope, so a
#      top-level `const` / `let` / `class` declared in two cells is a load-time
#      SyntaxError in the browser that no per-file check can see.
#   4. All tracked Node test suites pass (`node --test`).
#
# Exit code 0 means all four passed. This does not exercise the page in a browser.

set -u

fail=0
note() { printf '%s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fail=1; }

normpath() { # normpath <slash-path>  ->  collapsed path (. and .. resolved)
  local path=$1 lead="" seg n=0 restore_noglob=0 IFS=/
  local -a parts
  case "$path" in /*) lead="/" ;; esac
  case "$-" in *f*) restore_noglob=1 ;; esac
  set -f
  for seg in $path; do
    case "$seg" in
      ''|'.') continue ;;
      '..')
        if [ "$n" -gt 0 ] && [ "${parts[$((n - 1))]}" != ".." ]; then
          n=$((n - 1))
          unset "parts[$n]"
        elif [ -z "$lead" ]; then
          parts[$n]=".."
          n=$((n + 1))
        fi
        ;;
      *)
        parts[$n]="$seg"
        n=$((n + 1))
        ;;
    esac
  done
  [ "$restore_noglob" -eq 0 ] && set +f
  if [ "$n" -eq 0 ]; then
    [ -n "$lead" ] && printf '/\n' || printf '.\n'
  else
    printf '%s%s\n' "$lead" "${parts[*]}"
  fi
}

refs() { # refs <html-file> <attr>  ->  paths relative to the repo root
  local html=$1 attr=$2 dir p
  dir=$(dirname "$html")
  grep -oE "${attr}=\"[^\"]+\.(js|css)\"" "$html" | sed -E "s/^${attr}=\"//; s/\"$//" |
    grep -vE '^(https?:)?//' | while IFS= read -r p; do
      case "$p" in
        /*) normpath "$p" ;;
        *)  if [ "$dir" = "." ]; then normpath "$p"; else normpath "$dir/$p"; fi ;;
      esac
    done
}

run_with_timeout() { # run_with_timeout <seconds> <cmd...>
  local secs=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif [ -x /opt/homebrew/bin/timeout ]; then
    /opt/homebrew/bin/timeout "$secs" "$@"
  elif [ -x /usr/local/bin/timeout ]; then
    /usr/local/bin/timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  elif [ -x /usr/bin/perl ]; then
    /usr/bin/perl -e 'alarm shift; exec { $ARGV[0] } @ARGV; exit 127' "$secs" "$@"
  elif command -v perl >/dev/null 2>&1; then
    perl -e 'alarm shift; exec { $ARGV[0] } @ARGV; exit 127' "$secs" "$@"
  else
    "$@"
  fi
}

if [ "${BASH_SOURCE[0]:-$0}" != "$0" ]; then
  return 0
fi

cd "$(dirname "$0")/.." || exit 2

# 1. Wiring ------------------------------------------------------------------
wired=$(mktemp); bundle_base=$(mktemp); bundle="${bundle_base}.js"
trap 'rm -f "$wired" "$wired.missing" "$bundle_base" "$bundle"' EXIT
pages=$(git ls-files '*.html')
for page in $pages; do
  { refs "$page" src; refs "$page" href; } | while IFS= read -r p; do
    printf '%s\n' "$p" >> "$wired"
    case "$p" in
      /*|../*|..) printf 'MISSING %s (referenced by %s)\n' "$p" "$page" ;;
      *) [ -f "$p" ] || printf 'MISSING %s (referenced by %s)\n' "$p" "$page" ;;
    esac
  done
done > "$wired.missing"
if [ -s "$wired.missing" ]; then
  while IFS= read -r line; do bad "$line"; done < "$wired.missing"
fi
rm -f "$wired.missing"

for f in $(git ls-files 'cells/*.js' 'cells/*.css' 'ui/*.js' 'ui/*.css'); do
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
test_files=()
while IFS= read -r tf; do
  [ -n "$tf" ] && test_files+=("$tf")
done <<EOF
$(git ls-files '*.test.js' '*.test.mjs')
EOF
if [ "${#test_files[@]}" -eq 0 ]; then
  bad "no tracked *.test.js or *.test.mjs files found"
else
  out=$(run_with_timeout 600 node --test "${test_files[@]}" 2>&1); code=$?
  printf '%s\n' "$out" | grep -E '^# (tests|pass|fail|cancelled|skipped) ' | tr '\n' ' '; printf '\n'
  if [ "$code" -ne 0 ]; then
    bad "node --test exited $code"
    printf '%s\n' "$out" | grep -E '^not ok' | head -20
  fi
  tests=$(printf '%s\n' "$out" | sed -nE 's/^# tests ([0-9]+)$/\1/p')
  [ "${tests:-0}" -gt 0 ] || bad "node --test ran zero tests"
fi

[ $fail -eq 0 ] && note "OK" || note "CHECK FAILED"
exit $fail
