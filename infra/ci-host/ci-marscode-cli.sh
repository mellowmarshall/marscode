#!/usr/bin/env bash
# Installs one MarsCode CLI (runlog or playbook) on a CI host from the synced
# payload's prebuilt bundle (packages/<name>/dist/bin.mjs), the same layout the
# post-merge sync uses locally: ~/.local/lib/marscode-tools/<name> points at an
# atomic release directory, and ~/.local/bin/<name> runs it with the host's node.
#
# It never replaces a ~/.local/bin/<name> that a MarsCode installer did not write (another
# install's link or file) unless the new CLI passes its flag-parity check, the same rule as
# scripts/ship/marscode-sync-parity.ts: runlog must print its --ci-suite begin and end lines;
# playbook has no parity with the original (it lacks subcommands the original's callers use),
# so it never replaces one. A refusal skips the install: it leaves everything in place, prints
# one "warning: skipped" line (which hosts provision reports) and exits 0.
#
# Usage: ci-marscode-cli.sh runlog|playbook
set -euo pipefail

# The marker line every MarsCode wrapper carries (marscode-sync writes the same one).
wrapper_marker='# Installed by MarsCode; reinstalls replace this file.'

name=${1:-}
case "$name" in
  runlog|playbook) ;;
  *) printf 'ci-marscode-cli.sh: usage: ci-marscode-cli.sh runlog|playbook\n' >&2; exit 64 ;;
esac

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
bundle="$script_dir/../../packages/$name/dist/bin.mjs"
[ -f "$bundle" ] || { printf 'ci-marscode-cli.sh: missing %s; hosts sync ships it\n' "$bundle" >&2; exit 1; }
node_bin=$(command -v node) || { printf 'ci-marscode-cli.sh: node is not on PATH\n' >&2; exit 1; }

lib_dir="$HOME/.local/lib/marscode-tools"
bin_dir="$HOME/.local/bin"
releases="$lib_dir/.releases"
mkdir -p "$releases" "$bin_dir"
stage=$(mktemp -d "$releases/$name.XXXXXX")
link_tmp="$lib_dir/.$name.link.$$"
wrapper_tmp="$bin_dir/.$name.wrapper.$$"
committed=0
cleanup() {
  rm -f "$link_tmp" "$wrapper_tmp"
  [ "$committed" = 1 ] || rm -rf "$stage"
}
trap cleanup EXIT

mkdir -p "$stage/dist"
printf '{"type":"module"}\n' > "$stage/package.json"
cp "$bundle" "$stage/dist/bin.mjs"
chmod 755 "$stage/dist/bin.mjs"

target="$lib_dir/$name"
bin="$bin_dir/$name"

# What sits at $bin when a MarsCode installer did not write it; empty when it did or nothing is there.
foreign_cli() {
  if [ -L "$bin" ]; then
    printf 'a link to %s' "$(readlink "$bin")"
  elif [ -e "$bin" ] && [ ! -f "$bin" ]; then
    printf 'not a regular file'
  elif [ -f "$bin" ]; then
    # Wrappers written before the marker name the release link's bundle, plain or as printf %q wrote it.
    if ! grep -qxF -- "$wrapper_marker" "$bin" && ! grep -qF -- "$target/dist/bin.mjs" "$bin" \
      && ! grep -qF -- "$(printf %q "$target/dist/bin.mjs")" "$bin"; then
      printf 'a file another install wrote'
    fi
  fi
}

# Why the staged CLI fails its flag-parity check; empty when it passes.
parity_problem() {
  case "$name" in
    runlog)
      local out rc=0 begin end
      out=$("$node_bin" "$stage/dist/bin.mjs" --ci-suite x -- true 2>/dev/null) || rc=$?
      [ "$rc" = 0 ] || { printf 'it exited %s' "$rc"; return; }
      begin=$(printf '%s\n' "$out" | sed -n 1p)
      end=$(printf '%s\n' "$out" | sed -n 2p)
      if [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" != 2 ] \
        || [[ ! "$begin" =~ ^ci-suite:\ begin\ x\ pid=([0-9]+)\ by=runlog$ ]]; then
        printf 'it printed %q' "${out:0:200}"; return
      fi
      local pid=${BASH_REMATCH[1]}
      if [[ ! "$end" =~ ^ci-suite:\ end\ x\ pass\ pid=([0-9]+)(\ cpu=[0-9]+\.[0-9][0-9])?\ by=runlog$ ]]; then
        printf 'it printed %q' "${out:0:200}"; return
      fi
      [ "${BASH_REMATCH[1]}" = "$pid" ] || printf 'its begin and end lines name different pids'
      ;;
    *) printf 'the MarsCode %s has no flag-parity check' "$name" ;;
  esac
}

# The playbook's design scan (the original playbook's scan in one file) goes where repos' design
# evidence runs it, ~/.local/lib/playbook/pb_design_scan.mjs, never over a file another install
# wrote. It has its own owner check, so it installs whether or not the CLI did.
install_design_scan() {
  local scan="$script_dir/../../packages/playbook/dist/pb_design_scan.mjs"
  [ "$name" = playbook ] && [ -f "$scan" ] || return 0
  local scan_marker="// ${wrapper_marker#\# }"
  local scan_dir="$HOME/.local/lib/playbook"
  local scan_dest="$scan_dir/pb_design_scan.mjs"
  if [ -L "$scan_dest" ] || { [ -e "$scan_dest" ] && [ ! -f "$scan_dest" ]; } \
    || { [ -f "$scan_dest" ] && [ "$(head -n 1 "$scan_dest" 2>/dev/null)" != "$scan_marker" ]; }; then
    printf 'ci-marscode-cli.sh: warning: skipped pb_design_scan.mjs: kept %s (another install wrote it, not installed by MarsCode); remove it to let MarsCode install its design scan.\n' "$scan_dest"
    return 0
  fi
  mkdir -p "$scan_dir"
  local scan_tmp="$scan_dir/.pb_design_scan.mjs.$$"
  { printf '%s\n' "$scan_marker"; cat "$scan"; } > "$scan_tmp"
  chmod 644 "$scan_tmp"
  mv -f "$scan_tmp" "$scan_dest"
  printf 'ci-marscode-cli.sh: installed %s\n' "$scan_dest"
}

foreign=$(foreign_cli)
if [ -n "$foreign" ]; then
  # The backticks are the message's literal text.
  # shellcheck disable=SC2016
  case "$name" in
    runlog) what='`runlog --ci-suite x -- true` prints its begin and end lines and exits 0' ;;
    *) what='' ;;
  esac
  problem=$(parity_problem)
  if [ -n "$problem" ]; then
    printf 'ci-marscode-cli.sh: warning: skipped %s: kept %s (%s, not installed by MarsCode) because %s%s; remove it to let MarsCode install its %s.\n' \
      "$name" "$bin" "$foreign" "$problem" "${what:+ (the check: $what)}" "$name"
    install_design_scan
    exit 0
  fi
fi

if [ -e "$target" ] && [ ! -L "$target" ]; then
  mv "$target" "$releases/$name.legacy.$$"
fi
ln -s "$stage" "$link_tmp"
# GNU mv swaps the link atomically; BSD mv has no -T, so macOS falls back to ln -sfn.
mv -T "$link_tmp" "$target" 2>/dev/null || ln -sfn "$stage" "$target"

# The single-quoted printf formats are the wrapper's literal text, expanded when it runs.
# shellcheck disable=SC2016
{
  printf '#!/usr/bin/env bash\n%s\nset -euo pipefail\n' "$wrapper_marker"
  printf 'node_bin=%q\n' "$node_bin"
  printf 'if [ ! -x "$node_bin" ]; then\n  node_bin="$(command -v node)"\nfi\n'
  printf 'exec "$node_bin" %q "$@"\n' "$target/dist/bin.mjs"
} > "$wrapper_tmp"
chmod 755 "$wrapper_tmp"
mv -f "$wrapper_tmp" "$bin"
committed=1

# Drop old releases, but never the one the link now names, and never a stage younger than ten
# minutes: a concurrent install of the same tool may not have linked it yet.
current=$(readlink "$target" || true)
find "$releases" -mindepth 1 -maxdepth 1 -name "$name.*" -mmin +10 -print | while IFS= read -r old; do
  [ "$old" = "$current" ] || rm -rf "$old"
done
printf 'ci-marscode-cli.sh: installed %s\n' "$bin_dir/$name"

install_design_scan
