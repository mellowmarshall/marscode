#!/usr/bin/env bash
# Installs the GNU userland on a macOS CI host, for the gnu-userland tool in
# ci-hosts.json (private-repo): GNU coreutils, sed, findutils and grep, and a
# setsid and a flock, so a CI step runs the same `stat -c`, `sed -i`,
# `date -d`, `touch -d`, `realpath -m`, `paste`, `timeout`, `setsid` and
# `flock -w` on every host. tar stays the Mac's own (bsdtar): it reads .xz
# itself, where GNU tar would need an xz the Mac lacks; what packs evidence
# speaks both (sq_evidence_pack).
# Before #646 the Mac ran BSD's, and every devtools suite failed there
# (job 11337: BSD paste emptied a test's PATH).
#
#   ci-gnu-userland.sh
#
# Each package is a pinned GNU release, built from its source tarball after
# the tarball's sha256 matches the one below (each recorded from a tarball
# whose GNU signature verified against ftp.gnu.org's gnu-keyring.gpg). setsid
# and flock are util-linux's, which does not build on macOS: two small C
# programs with util-linux's options (ci-setsid.c, ci-flock.c). Before,
# the Mac had a Python flock that read `-w 30 9` as descriptor 30, so every
# timed lock failed. Everything goes to a new
# ~/.local/share/ship-queue-ci/gnu-BUNDLE.XXXXXX directory, the gnu link
# switches to it with one rename (no step ever sees a half-built bundle), and
# the older ones go. CI_PATH_SETUP puts gnu/bin first on the CI's PATH.
# Linux hosts have the GNU userland natively: the tool is darwin-only.
set -euo pipefail

# The bundle's version, gnu/BUNDLE: the tool's probe reads it, and a change
# below raises it so every Mac is drift until it is rebuilt.
BUNDLE=6
PACKAGES=(
  "coreutils-9.5 cd328edeac92f6a665de9f323c93b712af1858bc2e0d88f3f7100469470a1b8a coreutils"
  "sed-4.9 6e226b732e1cd739464ad6862bd1a1aba42d7982922da7a53519631d24975181 sed"
  "findutils-4.10.0 1387e0b67ff247d2abde998f90dfbf70c1491391a59ddfecb8ae698789f0a4f5 findutils"
  "grep-3.11 1db2aedde89d0dea42b16d9528f894c8d15dae4e190b59aecc78f5a951276eab grep"
)

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(uname -s)" = Darwin ] || { echo "ci-gnu-userland: $(uname -s) has the GNU userland natively; nothing to install" >&2; exit 1; }
for c in cc make curl /usr/bin/tar; do command -v "$c" >/dev/null 2>&1 || { echo "ci-gnu-userland: $c is missing (an admin installs Xcode's command line tools)" >&2; exit 1; }; done
s="$HOME/.local/share/ship-queue-ci"
mkdir -p "$s"
cur=$(readlink "$s/gnu" 2>/dev/null || true)
if [ -n "$cur" ] && [ "$(cat "$s/gnu/BUNDLE" 2>/dev/null)" = "$BUNDLE" ]; then
  echo "gnu-userland: bundle $BUNDLE is in place ($s/$cur)"; exit 0
fi
d=$(mktemp -d "$s/gnu-$BUNDLE.XXXXXX")
src=$(mktemp -d)
# On any exit: the sources go, and the new bundle too unless gnu names it (a
# signal between the swap and here never deletes the bundle in use).
trap 'rm -rf "$src"; [ "$(readlink "$s/gnu" 2>/dev/null)" = "${d##*/}" ] || rm -rf "$d"' EXIT
chmod 0755 "$d"
jobs=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
for p in "${PACKAGES[@]}"; do
  read -r name want dir <<<"$p"
  curl -fsSL --retry 2 -o "$src/$name.tar.xz" "https://ftp.gnu.org/gnu/$dir/$name.tar.xz"
  have=$(shasum -a 256 "$src/$name.tar.xz")
  [ "${have%% *}" = "$want" ] || { echo "ci-gnu-userland: $name.tar.xz has sha256 ${have%% *}, not the pinned $want; nothing installed" >&2; exit 1; }
  # The system's tar (bsdtar), which reads .xz itself, whatever PATH this runs with.
  /usr/bin/tar -xJf "$src/$name.tar.xz" -C "$src"
  # No PCRE on the Mac: grep -P is the one GNU option it lacks.
  extra=(); [ "$dir" != grep ] || extra=(--disable-perl-regexp)
  ( cd "$src/$name" && ./configure --prefix="$d" --disable-nls --disable-dependency-tracking ${extra[@]+"${extra[@]}"} >"$src/$name.configure.log" 2>&1 &&
    make -j"$jobs" >"$src/$name.make.log" 2>&1 && make install >"$src/$name.install.log" 2>&1 ) ||
    { echo "ci-gnu-userland: $name did not build; the last lines:" >&2; tail -15 "$src/$name".*.log >&2; exit 1; }
done
# setsid and flock, as util-linux's: two small C programs beside this script
# (ci-setsid.c, ci-flock.c; ci-gnu-userland.test.sh holds them to util-linux).
cc -O2 -o "$d/bin/setsid" "$here/ci-setsid.c"
cc -O2 -o "$d/bin/flock" "$here/ci-flock.c"
echo "$BUNDLE" > "$d/BUNDLE"
for t in stat sed find grep timeout realpath paste; do "$d/bin/$t" --version >/dev/null 2>&1 ||
  { echo "ci-gnu-userland: $d/bin/$t does not run" >&2; exit 1; }; done
"$d/bin/setsid" -w true || { echo "ci-gnu-userland: $d/bin/setsid does not run" >&2; exit 1; }
"$d/bin/flock" -w 1 "$src/t.lock" true || { echo "ci-gnu-userland: $d/bin/flock does not run" >&2; exit 1; }
# The system's ln and mv: a provision runs this with an older bundle's GNU
# tools first on PATH, and GNU mv has no -h (private-repo).
/bin/ln -sfn "${d##*/}" "$s/.gnu.next"
# -h: replace the link itself, never move into the directory it names.
/bin/mv -fh "$s/.gnu.next" "$s/gnu"
k=$(readlink "$s/gnu")
for o in "$s"/gnu-*; do [ "${o##*/}" = "$k" ] || rm -rf -- "$o"; done
echo "installed gnu-userland: bundle $BUNDLE ($("$s/gnu/bin/stat" --version | head -1))"
