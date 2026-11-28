#!/usr/bin/env bash
# Installs one MarsCode CLI (runlog or playbook) on a CI host from the synced
# payload's prebuilt bundle (packages/<name>/dist/bin.mjs), the same layout the
# post-merge sync uses locally: ~/.local/lib/marscode-tools/<name> points at an
# atomic release directory, and ~/.local/bin/<name> runs it with the host's node.
#
# Usage: ci-marscode-cli.sh runlog|playbook
set -euo pipefail

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
if [ -e "$target" ] && [ ! -L "$target" ]; then
  mv "$target" "$releases/$name.legacy.$$"
fi
ln -s "$stage" "$link_tmp"
# GNU mv swaps the link atomically; BSD mv has no -T, so macOS falls back to ln -sfn.
mv -T "$link_tmp" "$target" 2>/dev/null || ln -sfn "$stage" "$target"

{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  printf "node_bin='%s'\n" "$node_bin"
  # shellcheck disable=SC2016 # literal text of the generated wrapper
  printf 'if [ ! -x "$node_bin" ]; then\n  node_bin="$(command -v node)"\nfi\n'
  printf "exec \"\$node_bin\" '%s/dist/bin.mjs' \"\$@\"\n" "$target"
} > "$wrapper_tmp"
chmod 755 "$wrapper_tmp"
mv -f "$wrapper_tmp" "$bin_dir/$name"
committed=1

for old in "$releases/$name".*; do
  [ "$old" = "$stage" ] || rm -rf "$old"
done
printf 'ci-marscode-cli.sh: installed %s\n' "$bin_dir/$name"
