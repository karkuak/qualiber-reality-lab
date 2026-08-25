#!/usr/bin/env bash
# Removes one scratch root that run-example.sh created, and refuses anything else.
#
#   ./examples/trusted-local-neutral/cleanup-example.sh <scratch-root>
#
# `rm -rf` on an operator-supplied path is the single most destructive thing a
# worked example could hand someone, so this script establishes that the target
# is a directory *this example made* before it removes anything. Seven checks,
# each of which is a refusal:
#
#   1. exactly one argument, non-empty and absolute — a relative path means the
#      result depends on where the operator was standing;
#   2. no `..` anywhere in it;
#   3. it exists, is a real directory, and is not a symbolic link — a symlink's
#      target can be repointed between the check and the removal;
#   4. its own name carries this example's prefix;
#   5. it contains the ownership stamp run-example.sh writes, which is the check
#      that actually distinguishes "a directory this example created" from "a
#      directory whose name looks right";
#   6. its real parent is the temporary root run-example.sh creates scratch roots
#      in, so nothing outside that root is reachable at all;
#   7. it is not a filesystem root, not a shared temporary root, not a home
#      directory, not a git repository, and not an ancestor of one.
#
# Check 7 is redundant given checks 4-6, and is written out anyway: a guard whose
# safety depends on another guard being right is a guard nobody can audit alone.
set -euo pipefail

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 1
}

STAMP=".erl2-trusted-local-neutral-scratch"
PREFIX="erl2-trusted-local-neutral-"

[ "$#" -eq 1 ] || refuse "usage: cleanup-example.sh <scratch-root> (exactly one argument)"
target="$1"
[ -n "$target" ] || refuse "the scratch root must not be empty"

case "$target" in
  /*) ;;
  *) refuse "the scratch root must be an absolute path, not '$target'" ;;
esac
case "$target" in
  *..*) refuse "the scratch root must not contain '..': $target" ;;
esac

[ -e "$target" ] || refuse "no such path: $target"
[ ! -L "$target" ] || refuse "the scratch root must be a real directory, not a symbolic link: $target"
[ -d "$target" ] || refuse "the scratch root must be a directory: $target"

# Resolve physically, so every later comparison is about the same real directory
# the removal would act on rather than about the spelling of a path.
real_target="$(cd "$target" && pwd -P)"
name="$(basename "$real_target")"
case "$name" in
  "$PREFIX"*) ;;
  *) refuse "not a scratch root this example created (name lacks '$PREFIX'): $real_target" ;;
esac

[ -f "$real_target/$STAMP" ] || refuse "missing the ownership stamp $STAMP; this example did not create $real_target"

expected_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
real_parent="$(cd "$real_target/.." && pwd -P)"
[ "$real_parent" = "$expected_root" ] ||
  refuse "the scratch root must sit directly beneath $expected_root, not $real_parent"

for forbidden in / /tmp /private/tmp /var /var/tmp /private/var /usr /etc "$expected_root" "${HOME:-/nonexistent}"; do
  [ "$real_target" != "$forbidden" ] || refuse "refusing to remove $real_target"
done

[ ! -e "$real_target/.git" ] || refuse "$real_target is a git repository; refusing to remove it"
# An ancestor of a repository is as dangerous as the repository itself.
if command -v git >/dev/null 2>&1; then
  if find "$real_target" -maxdepth 3 -name .git -print -quit 2>/dev/null | grep -q .; then
    refuse "$real_target contains a git repository; refusing to remove it"
  fi
fi

rm -rf -- "$real_target"
printf 'removed %s\n' "$real_target"
