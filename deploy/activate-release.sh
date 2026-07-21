#!/usr/bin/env bash
set -euo pipefail

die() {
  printf '%s\n' "release activation failed: $*" >&2
  exit 1
}

root="${PDF_CHECKER_ROOT:-/opt/pdf-checker}"
commit="${1:-}"

[[ "$root" == /* ]] || die "PDF_CHECKER_ROOT must be an absolute path"
[[ "$root" != / && "$root" != */.. && "$root" != *"/../"* && "$root" != *"//"* ]] || die "unsafe PDF_CHECKER_ROOT"
[[ "$commit" =~ ^[0-9a-f]{7,64}$ ]] || die "commit must be a lowercase Git commit ID"
[[ -d "$root" && ! -L "$root" ]] || die "release root must be a real directory"

root="$(cd -- "$root" && pwd -P)"
[[ "$root" != / && "$root" != /opt && "$root" != /var ]] || die "unsafe PDF_CHECKER_ROOT"
releases="$root/releases"
[[ -d "$releases" && ! -L "$releases" ]] || die "releases directory must be a real directory"
releases="$(cd -- "$releases" && pwd -P)"

release="$releases/$commit"
[[ -d "$release" && ! -L "$release" ]] || die "target release must be a real directory"
release="$(cd -- "$release" && pwd -P)"
[[ "$(dirname -- "$release")" == "$releases" ]] || die "target release is outside the releases directory"
[[ -f "$release/package.json" && -f "$release/dist/audit-worker.mjs" ]] || die "target release is missing required build artifacts"

current="$root/current"
tmp="$root/.current.next.$$"
backup="$root/.current.pre-symlink.$(date -u +%Y%m%d%H%M%S).$$"
[[ ! -e "$tmp" && ! -L "$tmp" ]] || die "temporary activation link already exists"

current_moved=false
activated=false

cleanup_failed_activation() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$activated" != true ]]; then
    rm -f -- "$tmp" || true
    if [[ "$current_moved" == true ]]; then
      if [[ -L "$current" ]]; then
        rm -f -- "$current" || printf '%s\n' "release activation rollback could not remove $current" >&2
      elif [[ -e "$current" ]]; then
        printf '%s\n' "release activation rollback left existing $current in place" >&2
      fi
      if [[ ! -e "$current" && ! -L "$current" ]]; then
        if ! mv -Tf -- "$backup" "$current"; then
          printf '%s\n' "release activation rollback failed; restore $backup to $current immediately" >&2
        fi
      fi
    fi
  fi
  exit "$status"
}

trap cleanup_failed_activation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ln -s -- "$release" "$tmp"

if [[ -L "$current" || ! -e "$current" ]]; then
  mv -Tf -- "$tmp" "$current"
else
  [[ -d "$current" ]] || die "current must be a directory or symlink"
  [[ ! -e "$backup" && ! -L "$backup" ]] || die "rollback directory already exists"
  current_moved=true
  mv -T -- "$current" "$backup"
  mv -Tf -- "$tmp" "$current"
fi

[[ -L "$current" ]] || die "current was not activated as a symlink"
[[ "$(readlink -f -- "$current")" == "$release" ]] || die "current did not resolve to the requested release"
activated=true
trap - EXIT INT TERM
printf 'activated release %s\n' "$commit"
