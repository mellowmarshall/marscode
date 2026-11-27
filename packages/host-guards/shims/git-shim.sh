#!/bin/bash -p
# MarsCode host `git` shim.
# Fast-path read-only git subcommands exec real `git` directly (zero Node startup).
# Mutating or suspicious invocations delegate to `marscode-host-guard`.
REAL_GIT='@REAL_GIT@'
HOST_GUARD='@HOST_GUARD@'
SHIM_DEPTH='@SHIM_DEPTH@'

if [ "$REAL_GIT" -ef "${BASH_SOURCE[0]}" ] || [ ! -x "$REAL_GIT" ]; then
  printf 'git shim: the real git (%s) is missing or is this shim; re-run install.sh\n' "$REAL_GIT" >&2
  exit 127
fi

if [ -r "$SHIM_DEPTH" ]; then
  # shellcheck source=/dev/null
  . "$SHIM_DEPTH"
  hg_shim_depth "${BASH_SOURCE[0]}" "$REAL_GIT"
fi

git_shim_ask=0
git_shim_cfg=0
git_shim_sub=""
git_shim_sub2=""
git_shim_cwd="$PWD"

[ -z "${GIT_CONFIG_PARAMETERS:-}${GIT_CONFIG_COUNT:-}${GIT_CONFIG_GLOBAL:-}${GIT_CONFIG_SYSTEM:-}" ] || git_shim_cfg=1

git_shim_args=("$@")
git_shim_i=0
while [ "$git_shim_i" -lt "$#" ]; do
  git_shim_a="${git_shim_args[git_shim_i]}"
  if [ -z "$git_shim_sub" ]; then
    case "$git_shim_a" in
      -c|--config-env)
        git_shim_cfg=1
        git_shim_i=$((git_shim_i + 1))
        ;;
      -C)
        git_shim_i=$((git_shim_i + 1))
        case "${git_shim_args[git_shim_i]:-}" in
          /*) git_shim_cwd="${git_shim_args[git_shim_i]}" ;;
          ?*) git_shim_cwd="$git_shim_cwd/${git_shim_args[git_shim_i]}" ;;
        esac
        ;;
      --git-dir|--work-tree|--namespace|--super-prefix|--attr-source|--list-cmds|--exec-path)
        git_shim_i=$((git_shim_i + 1))
        ;;
      -c*|--config-env=*)
        git_shim_cfg=1
        ;;
      -*) ;;
      *)
        git_shim_sub="$git_shim_a"
        case "$git_shim_sub" in
          status|log|diff|show|rev-parse|rev-list|ls-files|ls-tree|ls-remote|cat-file|for-each-ref|show-ref|\
          symbolic-ref|describe|blame|annotate|grep|shortlog|tag|restore|reset|add|rm|mv|\
          fetch|clone|init|remote|merge-base|name-rev|hash-object|update-index|write-tree|read-tree|\
          commit-tree|update-ref|reflog|gc|prune|fsck|count-objects|var|help|version|bisect|clean|archive|\
          format-patch|diff-tree|diff-index|diff-files|cherry|show-branch|whatchanged|apply|notes|submodule|\
          sparse-checkout|maintenance|check-ignore|check-attr|check-ref-format|mktree|mktag|verify-commit|\
          verify-tag|interpret-trailers|column|credential|rerere|range-diff|bundle|stripspace|unpack-objects|\
          pack-objects|index-pack|get-tar-commit-id|merge-file|merge-tree|patch-id|replace|repack|fast-export) ;;
          commit|checkout|switch|merge|cherry-pick|revert|am|push|stash|send-pack|http-push|subtree)
            git_shim_ask=1
            ;;
          worktree) ;;
          branch|rebase|pull)
            [ "$git_shim_cfg" = 0 ] || git_shim_ask=1
            ;;
          config) ;;
          *)
            git_shim_ask=1
            ;;
        esac
        ;;
    esac
  else
    if [ -z "$git_shim_sub2" ] && [[ "$git_shim_a" != -* ]]; then
      git_shim_sub2="$git_shim_a"
    fi
    if [ "$git_shim_sub" = "worktree" ] && [ "$git_shim_sub2" = "add" ]; then
      git_shim_ask=1
    fi
    if [ "$git_shim_sub" = "branch" ]; then
      case "$git_shim_a" in
        -a|--all|-r|--remotes|-l|--list|--show-current|-v|-vv|--merged|--no-merged|--contains|--no-contains|\
        --contains=*|--no-contains=*|--merged=*|--no-merged=*|--sort=*|--format=*) ;;
        *) git_shim_ask=1 ;;
      esac
    fi
    if [ "$git_shim_sub" = "config" ]; then
      case "${git_shim_a,,}" in
        core.hookspath|include.path|includeif.*) git_shim_ask=1 ;;
      esac
    fi
    case "$git_shim_a" in
      --) break ;;
      --no-v*) [ "${#git_shim_a}" -lt 6 ] || git_shim_ask=1 ;;
      -[A-Za-z]*)
        if [ "$git_shim_sub" = "commit" ]; then
          case "$git_shim_a" in *n*) git_shim_ask=1 ;; esac
        fi
        ;;
    esac
  fi
  git_shim_i=$((git_shim_i + 1))
done

if [ -n "${SKIP_CI:-}" ]; then
  case "$git_shim_sub" in
    commit|push|merge) git_shim_ask=1 ;;
  esac
fi

if [ "$git_shim_ask" = 1 ]; then
  if [ ! -x "$HOST_GUARD" ]; then
    printf 'git shim: %s is missing; refusing unguarded git %s\n' "$HOST_GUARD" "$git_shim_sub" >&2
    exit 2
  fi
  "$HOST_GUARD" git-check -- "$@" || exit $?
  if [ "$git_shim_sub" = "worktree" ] && [ "$git_shim_sub2" = "add" ]; then
    "$HOST_GUARD" install-check -- git "$@" || exit $?
  fi
  if [ "$git_shim_sub" = "push" ]; then
    "$HOST_GUARD" tree-check --kind push --cwd "$git_shim_cwd" -- "$@" || exit $?
  fi
fi

exec "$REAL_GIT" "$@"
