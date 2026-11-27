#!/usr/bin/env bash
# Installs one of the fleet-check CLIs (fly, hcloud, op, doppler) on a CI
# host, for the toolchain in ci-hosts.json (private-repo): the live fleet
# checks list the Fly, Hetzner, 1Password and Doppler accounts with them, and
# a CI host without them reported every one UNPROVEN.
#
#   ci-fleet-tools.sh fly|hcloud|op|doppler
#
# Each is a pinned release for Linux x86_64 (WSL included), Linux aarch64 or macOS arm64,
# checked against the sha256 below before anything is installed: the project's
# published checksums where it has them (fly, hcloud, doppler, kept current by
# `ship-queue deps` through sq_pins.json, private-repo), else the digest
# recorded from the download (op, raised by hand). The binaries go to the CI's own
# directory, ~/.local/share/ship-queue-ci/bin (on every CI step's PATH,
# CI_PATH_SETUP), never ~/.local/bin: an agent's shell finds ~/.local/bin
# before the private-repo' shims, so a raw fly there would step around them.
set -euo pipefail

tool=${1:?usage: ci-fleet-tools.sh fly|hcloud|op|doppler}
platform=$(uname -sm)
dest="$HOME/.local/share/ship-queue-ci/bin"

# TOOL PLATFORM -> "URL SHA256 MEMBER"
release() {
  case "$1 $2" in
    "fly Linux x86_64") echo "https://github.com/superfly/flyctl/releases/download/v0.4.117/flyctl_0.4.117_Linux_x86_64.tar.gz fe4ec2dbd1d125578e2902f70931fca6670e325cfb658706324492d681986f2c flyctl" ;;
    "fly Linux aarch64") echo "https://github.com/superfly/flyctl/releases/download/v0.4.117/flyctl_0.4.117_Linux_arm64.tar.gz 2f7371ba710b62c0dd44aa2890e9e3cc2859b67cba948e5f2dc251146db62cb8 flyctl" ;;
    "fly Darwin arm64") echo "https://github.com/superfly/flyctl/releases/download/v0.4.117/flyctl_0.4.117_macOS_arm64.tar.gz 9004d6ef13d0a1469be36c5c15416351e014d731dd9a9e0c12269cf02c778682 flyctl" ;;
    "hcloud Linux x86_64") echo "https://github.com/hetznercloud/cli/releases/download/v1.70.2/hcloud-linux-amd64.tar.gz b844bd28240112b0254183ba5266d0a0f59a6167c196636936459755efb88050 hcloud" ;;
    "hcloud Linux aarch64") echo "https://github.com/hetznercloud/cli/releases/download/v1.70.2/hcloud-linux-arm64.tar.gz 05820ba0e3141b212c7cff036d1bd7cd35843e96d7033c2036ffe76253ebbea8 hcloud" ;;
    "hcloud Darwin arm64") echo "https://github.com/hetznercloud/cli/releases/download/v1.70.2/hcloud-darwin-arm64.tar.gz bdf2dd7e199a30f9096c0b5b2c7d4f6c4d5d6c9599bbe1f3a067cbf9c007634f hcloud" ;;
    "op Linux x86_64") echo "https://cache.agilebits.com/dist/1P/op2/pkg/v2.41.0/op_linux_amd64_v2.41.0.zip 498bbaa154f0d90749325a14e04488fcd84930a426ae92ebf421d2a7d793a80a op" ;;
    "op Linux aarch64") echo "https://cache.agilebits.com/dist/1P/op2/pkg/v2.41.0/op_linux_arm64_v2.41.0.zip bc4ac99201909f96f67e7a89601dbf5388f991aca53120db6fc3f1666dff706b op" ;;
    "op Darwin arm64") echo "https://cache.agilebits.com/dist/1P/op2/pkg/v2.41.0/op_darwin_arm64_v2.41.0.zip 83da93b6d90726ac5111ce4f6993a9504ee420b7a299b9d145041886cd13c6ca op" ;;
    "doppler Linux x86_64") echo "https://github.com/DopplerHQ/cli/releases/download/3.77.1/doppler_3.77.1_linux_amd64.tar.gz 001f89a42629f9cb827cd86683c4c2dbf87c6299a8d6130643b98044bf5ed80a doppler" ;;
    "doppler Linux aarch64") echo "https://github.com/DopplerHQ/cli/releases/download/3.77.1/doppler_3.77.1_linux_arm64.tar.gz a7f4be5b30295921dfe1cdc34f905cd017210ec3264a47d46e315ab09cb03e1c doppler" ;;
    "doppler Darwin arm64") echo "https://github.com/DopplerHQ/cli/releases/download/3.77.1/doppler_3.77.1_macOS_arm64.tar.gz e0033d287811de122e7a353a4d548f72ff3103b3010147ce80299f28b5313df2 doppler" ;;
  esac
}

read -r url want member <<<"$(release "$tool" "$platform")" || true
[ -n "${url:-}" ] || { echo "ci-fleet-tools: no pinned $tool build for $platform" >&2; exit 1; }
tmp=$(mktemp -d)
# Names of this run's own beside the tool: two provisions of one tool at once
# (a host update and a job's provide step) never rename each other's file
# away, as two writers of the queue's library did (private-repo).
next="$dest/.$member.next.$$" link="$dest/.fly.next.$$"
trap 'rm -rf "$tmp"; rm -f "$next" "$link"' EXIT
# A run that was killed leaves its names behind: removed once its pid is gone.
for t in "$dest"/.*.next.[0-9]*; do
  [ -e "$t" ] || [ -L "$t" ] || continue
  kill -0 "${t##*.}" 2>/dev/null || rm -f "$t"
done
curl -fsSL --retry 2 -o "$tmp/archive" "$url"
if command -v sha256sum >/dev/null 2>&1; then have=$(sha256sum "$tmp/archive"); else have=$(shasum -a 256 "$tmp/archive"); fi
[ "${have%% *}" = "$want" ] || { echo "ci-fleet-tools: $url has sha256 ${have%% *}, not the pinned $want; nothing installed" >&2; exit 1; }
case "$url" in
  *.zip) python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3])' "$tmp/archive" "$member" "$tmp" ;;
  *) tar -xzf "$tmp/archive" -C "$tmp" "$member" ;;
esac
mkdir -p "$dest"
install -m 0755 "$tmp/$member" "$next"
mv -f "$next" "$dest/$member"
# flyctl answers to fly as well, as its own installer links it: made beside
# it and renamed over it, so a second install at the same time never finds
# the link half made (ln -sf removes it first).
if [ "$tool" = fly ]; then
  ln -sfn flyctl "$link"
  mv -f "$link" "$dest/fly"
fi
echo "installed $tool: $("$dest/$tool" version 2>/dev/null | head -1 || "$dest/$tool" --version 2>/dev/null | head -1)"
