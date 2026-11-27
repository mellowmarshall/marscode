#!/usr/bin/env bash
# marscode's steps for the host ship queue.
# .tree-guard.conf names each step, and the queue runs the base branch's
# committed copy, so a branch cannot change how it ships.
#
#   ship-steps.sh body BODYFILE   refuse a body with no Closes #N, and a
#                                 branch whose PR already merged
#   ship-steps.sh install         refresh workspace deps with Vite+ hooks off
#   ship-steps.sh ci              run marscode's fast adaptive changed-file CI
#   ship-steps.sh merge PR        squash-merge the gated head: 0 merged,
#                                 75 the base moved, 76 transient
#   ship-steps.sh post-merge      build and atomically install MarsCode CLIs
#                                 from a detached temp/data worktree
set -u

ensure_vp_path() {
  local d
  if ! command -v vp >/dev/null 2>&1; then
    for d in "$HOME/.local/share/vite-plus/bin" "$HOME/.vite-plus/bin"; do
      if [ -x "$d/vp" ]; then
        export PATH="$d:$PATH"
        break
      fi
    done
  fi
  command -v vp >/dev/null 2>&1 || {
    echo "marscode ship-steps: vp (Vite+) not found on PATH ($PATH)" >&2
    return 1
  }
}

body() { # BODYFILE
  local merged
  grep -qiE '(^|[^[:alnum:]_])(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+(([[:alnum:]_.-]+/[[:alnum:]_.-]+)?#[0-9]+|https://github\.com/[^/[:space:]]+/[^/[:space:]]+/issues/[0-9]+)' "${1:?usage: ship-steps.sh body BODYFILE}" ||
    { echo 'the PR body names no issue: write "Closes #N"'; return 1; }
  merged=$(gh pr list -R "${SHIP_QUEUE_GH_REPO:?the host queue gives the GitHub repo}" \
    --head "${SHIP_QUEUE_BRANCH:?the host queue gives the branch}" --state merged \
    --json number -q '.[0].number // empty') ||
    { echo "cannot ask GitHub whether $SHIP_QUEUE_BRANCH already merged"; return 1; }
  [ -z "$merged" ] || { echo "PR #$merged already merged $SHIP_QUEUE_BRANCH: start a new branch for new work"; return 1; }
}

install_deps() {
  ensure_vp_path || return $?
  VP_GIT_HOOKS=0 vp install --frozen-lockfile
}

ci() {
  local base_ref="${SHIP_QUEUE_BASE_REF:-origin/main}"
  # Skip workspace install and check:changed when only ship-queue declaration/step files changed.
  local non_ship
  non_ship=$(git diff --name-only "$base_ref...HEAD" -- . ':!.tree-guard.conf' ':!scripts/ship/ship-steps.sh') || {
    echo "marscode ship-steps: cannot diff $base_ref...HEAD" >&2
    return 1
  }
  if [ -z "$non_ship" ]; then
    shellcheck scripts/ship/ship-steps.sh
    return $?
  fi
  ensure_vp_path || return $?
  if [ ! -d node_modules ]; then
    VP_GIT_HOOKS=0 vp install --frozen-lockfile || return $?
  fi
  vp run check:changed "$base_ref"
}

merge() { # PR
  local pr="${1:?usage: ship-steps.sh merge PR}" branch head out state rc=0
  local reason="${SHIP_QUEUE_REASON_FILE:-/dev/null}"
  branch=${SHIP_QUEUE_BASE_REF:?the host queue gives the base ref}
  branch=${branch#*/}
  head=$(git ls-remote origin "refs/heads/$branch" 2>/dev/null | cut -f1)
  [ -n "$head" ] || { echo "cannot read origin $branch" | tee "$reason"; return 76; }
  if [ "$head" != "${SHIP_QUEUE_ONTO:?the host queue gives the rebase base}" ]; then
    echo "$branch moved during the gate" | tee "$reason"
    return 75
  fi
  out=$(cd / && gh pr merge "$pr" -R "${SHIP_QUEUE_GH_REPO:?}" --squash \
    --match-head-commit "${SHIP_QUEUE_TIP:?the host queue gives the pushed head}" 2>&1) || rc=$?
  printf '%s\n' "$out"
  [ "$rc" -eq 0 ] && return 0
  case "$out" in
    *"timed out"*|*timeout*|*"HTTP 50"[0-9]*|*"connection reset"*)
      state=$(cd / && gh pr view "$pr" -R "$SHIP_QUEUE_GH_REPO" --json state -q .state 2>/dev/null)
      [ "$state" = MERGED ] && return 0
      echo "gh pr merge failed transiently (exit $rc)" > "$reason"
      return 76 ;;
  esac
  echo "gh pr merge exited $rc: $(printf '%s\n' "$out" | tail -n 1)" > "$reason"
  return "$rc"
}

post_merge() {
  local primary target_ref wt_base work_root build_wt primary_real wt_base_real base_ref stripped_ref remote_name base_branch fetched_sha
  primary="${SHIP_QUEUE_PRIMARY:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  base_ref="${SHIP_QUEUE_BASE_REF:-origin/main}"
  if [[ "$base_ref" == refs/remotes/*/* ]]; then
    stripped_ref="${base_ref#refs/remotes/}"
    remote_name="${stripped_ref%%/*}"
    base_branch="${stripped_ref#*/}"
  elif [[ "$base_ref" == refs/heads/* ]]; then
    remote_name="origin"
    base_branch="${base_ref#refs/heads/}"
  elif [[ "$base_ref" == */* ]]; then
    remote_name="${base_ref%%/*}"
    base_branch="${base_ref#*/}"
  else
    remote_name="origin"
    base_branch="$base_ref"
  fi
  target_ref="${SHIP_QUEUE_BASE_SHA:-${base_ref}}"
  if git -C "$primary" fetch --quiet "$remote_name" "$base_branch"; then
    fetched_sha="$(git -C "$primary" rev-parse --verify "${remote_name}/${base_branch}^{commit}" 2>/dev/null || true)"
    if [ -n "$fetched_sha" ]; then
      if [ -z "${SHIP_QUEUE_BASE_SHA:-}" ] || git -C "$primary" merge-base --is-ancestor "$SHIP_QUEUE_BASE_SHA" "$fetched_sha" 2>/dev/null; then
        target_ref="$fetched_sha"
      fi
    fi
  else
    echo "marscode ship-steps: warning: git fetch $remote_name $base_branch failed; building $target_ref" >&2
  fi

  wt_base=""
  for candidate in "${SHIP_QUEUE_WORKTREE_ROOT:-}" "${SHIP_QUEUE_DATA_ROOT:-}" "${TMPDIR:-/tmp}"; do
    [ -n "$candidate" ] || continue
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then
      wt_base="$candidate"
      break
    fi
  done
  if [ -z "$wt_base" ]; then
    wt_base="${TMPDIR:-/tmp}"
  fi

  primary_real="$(cd "$primary" && pwd -P)"
  wt_base_real="$(cd "$wt_base" && pwd -P)"
  case "$wt_base_real" in
    "$primary_real"|"$primary_real"/*)
      wt_base="${TMPDIR:-/tmp}"
      ;;
  esac

  work_root="$(mktemp -d "${wt_base}/.marscode-post-merge.XXXXXX")" || {
    echo "marscode ship-steps: cannot create temporary build worktree directory under $wt_base" >&2
    return 1
  }
  build_wt="${work_root}/repo"

  (
    set -euo pipefail
    trap 'git -C "$primary" worktree remove --force "$build_wt" >/dev/null 2>&1 || true; rm -rf "$work_root"; git -C "$primary" worktree prune >/dev/null 2>&1 || true' EXIT

    ensure_vp_path
    git -C "$primary" worktree add --detach -q "$build_wt" "$target_ref"
    cd "$build_wt"
    VP_GIT_HOOKS=0 vp install --frozen-lockfile --ignore-scripts
    bash "$build_wt/scripts/install-marscode-tools.sh" "$@"
  )
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    body) body "${2:-}" ;;
    install) install_deps ;;
    ci) ci ;;
    merge) merge "${2:-}" ;;
    post-merge) shift; post_merge "$@" ;;
    *) sed -n '2,/^[^#]/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  esac
fi
