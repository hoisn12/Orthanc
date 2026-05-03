#!/usr/bin/env sh

set -eu

if [ "${CI:-}" = "true" ]; then
  exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: this command must run inside a git worktree." >&2
  exit 1
fi

repo_root=$(git rev-parse --show-toplevel)
git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
main_checkout=$(cd "$git_common_dir/.." && pwd -P)
expected_parent=$(cd "$main_checkout/../Orthanc-worktrees" && pwd -P)
repo_parent=$(cd "$repo_root/.." && pwd -P)
repo_name=$(basename "$repo_root")

if [ "$repo_parent" != "$expected_parent" ]; then
  cat >&2 <<EOF
error: Orthanc work must run from a sibling worktree.

Current path:
  $repo_root

Expected pattern:
  $expected_parent/<branch-or-ticket>

Create one with:
  git worktree add ../Orthanc-worktrees/<branch-or-ticket> -b <branch>
EOF
  exit 1
fi

case "$git_common_dir" in
  */Orthanc/.git)
    ;;
  *)
    cat >&2 <<EOF
error: this directory is not linked to the Orthanc main checkout.

Current path:
  $repo_root

Git common dir:
  $git_common_dir
EOF
    exit 1
    ;;
esac

if [ "$repo_name" = "Orthanc" ]; then
  echo "error: do not work directly inside the main Orthanc checkout." >&2
  exit 1
fi
