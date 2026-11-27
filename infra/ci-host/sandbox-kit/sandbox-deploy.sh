#!/usr/bin/env bash
# sandbox-kit deploy: bring the repo's sandbox up to this checkout's commit.
# `sandbox-kit deploy` runs this from the repo root. The repo's declaration and fleet shape
# say where and what (sandbox_declaration.py).
#
# In order, and it is safe to run again:
#   1. refuses a checkout with uncommitted changes;
#   2. compares the names in Doppler <project>/sbx with the fleet shape; a name on one side
#      only stops the deploy before anything on the host changes;
#   3. builds each declared image of HEAD here, if this machine lacks it;
#   4. copies the images to the host, if it lacks them;
#   5. copies the compose files and the files they mount;
#   6. writes the host's environment from Doppler to a 0600 file. Values go from Doppler to the
#      host; none is printed or stored here. The machines' Access token stays off the host. The
#      new file replaces the old one only when it is complete;
#   7. starts the stack with docker compose up -d --remove-orphans;
#   8. waits until the ready URL on the host reports this commit;
#   9. proves the door is closed: each closed path answers 302 without a token, and the ready
#      path answers 403 or 302;
#  10. waits until the ready path through the door, with the machines' token, reports this commit;
#  11. runs the repo's smoke against the real URL (sandbox-kit smoke).
# A deploy that fails is fixed forward: nothing is rolled back.
#
#   SANDBOX_KIT_READY_TIMEOUT   seconds to wait for the ready URL on the host, default 300
#   SANDBOX_KIT_POLL_SECONDS    seconds between two ready checks, default 5
#   SANDBOX_KIT_SMOKE=0         skip the smoke
set -euo pipefail

KIT="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
READY_TIMEOUT="${SANDBOX_KIT_READY_TIMEOUT:-300}"
POLL="${SANDBOX_KIT_POLL_SECONDS:-5}"
# The last line of a complete environment. The host keeps its old file unless the new one ends with it.
COMPLETE='# sandbox-kit: complete'

say() { printf '[sandbox-kit deploy] %s\n' "$*"; }
fail() { say "FAILED: $*"; exit 1; }

[ -z "$(git status --porcelain)" ] || { say "the checkout has uncommitted changes; deploy a commit"; exit 2; }
SHA="$(git rev-parse HEAD)"
assignments="$(python3 "$KIT/sandbox_declaration.py" shell "$SHA")"
eval "$assignments"
HOST="$sk_ssh_host"
DIR="$(printf '%q' "$sk_remote_dir")"
compose="docker compose --project-name $sk_compose_project --env-file .env"
for name in "${sk_compose_names[@]}"; do compose+=" -f $(printf '%q' "$name")"; done

on_host() { ssh -o BatchMode=yes "$HOST" "$@"; }
served_commit() { sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p'; }

say "commit $SHA to $sk_server (ssh $HOST)"

# Declared against actual, before the host changes: the names in the Doppler config are the
# names the fleet shape declares for it.
say "comparing the names in Doppler $sk_doppler_project/$sk_doppler_config with the fleet shape"
doppler secrets --project "$sk_doppler_project" --config "$sk_doppler_config" --only-names --json \
  | python3 "$KIT/sandbox_doppler.py" names \
  || fail "Doppler and the fleet shape disagree (names above); fix the one that is wrong"

for ((i = 0; i < ${#sk_images[@]}; i++)); do
  image="${sk_images[$i]}"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    say "building $image"
    docker build -q -f "${sk_dockerfiles[$i]}" \
      --build-arg "APP_VERSION=$sk_tag" --build-arg "BUILD_COMMIT=$SHA" --build-arg "BUILD_TIME=$(git show -s --format=%cI HEAD)" \
      -t "$image" . >/dev/null
  fi
done

missing=()
for image in "${sk_images[@]}"; do
  on_host docker image inspect "$image" >/dev/null 2>&1 || missing+=("$image")
done
if [ "${#missing[@]}" -gt 0 ]; then
  say "copying ${#missing[@]} image(s)"
  docker save "${missing[@]}" | gzip -1 | on_host 'gunzip | docker load' >/dev/null
fi

say "copying the compose files"
dirs="$DIR"
for target in ${sk_dirs[@]+"${sk_dirs[@]}"}; do dirs+=" $(printf '%q' "$sk_remote_dir/$target")"; done
for target in ${sk_copy_to[@]+"${sk_copy_to[@]}"}; do dirs+=" $(printf '%q' "$(dirname "$sk_remote_dir/$target")")"; done
on_host "mkdir -p $dirs"
scp -q -o BatchMode=yes "${sk_compose_files[@]}" "$HOST:$sk_remote_dir/"
for ((i = 0; i < ${#sk_copy_from[@]}; i++)); do
  scp -q -o BatchMode=yes "${sk_copy_from[$i]}" "$HOST:$sk_remote_dir/${sk_copy_to[$i]}"
done

say "writing the environment from Doppler $sk_doppler_project/$sk_doppler_config"
# The host checks the new file before it replaces the old one: every required name is there, and
# the last line is the one this side writes only after Doppler answered in full. The `|| exit 1`
# is needed: errexit does not act inside a list that `||` follows.
accept="umask 077 && cat > $DIR/.env.next && { tail -n 1 $DIR/.env.next | grep -qxF '$COMPLETE'"
for name in ${sk_host_names[@]+"${sk_host_names[@]}"}; do accept+=" && grep -q '^$name=' $DIR/.env.next"; done
accept+=" && mv $DIR/.env.next $DIR/.env || { rm -f $DIR/.env.next; false; }; }"
{
  doppler secrets download --project "$sk_doppler_project" --config "$sk_doppler_config" --no-file --format docker \
    | grep -vE "^($sk_access_id|$sk_access_secret)=" || exit 1
  [ "${#sk_env_lines[@]}" -eq 0 ] || printf '%s\n' "${sk_env_lines[@]}"
  printf '%s\n' "$COMPLETE"
} | on_host "$accept" \
  || fail "the environment from Doppler is incomplete; the host keeps its last one"

say "starting the stack"
on_host "cd $DIR && $compose up -d --remove-orphans" >/dev/null

say "waiting for $sk_ready_origin to report $SHA (up to ${READY_TIMEOUT}s)"
deadline=$((SECONDS + READY_TIMEOUT))
served=""
while :; do
  served="$(on_host "curl -fsS --max-time 5 $(printf '%q' "$sk_ready_origin")" 2>/dev/null | served_commit || true)"
  [ "$served" = "$SHA" ] && break
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep "$POLL"
done
[ "$served" = "$SHA" ] \
  || fail "$sk_ready_origin reports '${served:-nothing}' after ${READY_TIMEOUT}s; see: ssh $HOST 'cd $sk_remote_dir && $compose logs --tail 50'"
say "ready on the host: the sandbox serves $SHA"

# The same question through the real URL: the DNS name, the edge, the Access door and the tunnel.
# Without the token the door must answer, not the app.
say "checking $sk_public_url through the door"
headers="$(mktemp)"; chmod 600 "$headers"; trap 'rm -f "$headers"' EXIT
doppler secrets download --project "$sk_doppler_project" --config "$sk_doppler_config" --no-file --format json \
  | python3 "$KIT/sandbox_doppler.py" headers "$sk_access_id" "$sk_access_secret" > "$headers" \
  || fail "cannot read the machines' Access token from Doppler"
# The redirect must go to Cloudflare Access: an app that redirects to its own login page also
# answers 302, with no door in front of it.
for path in "${sk_closed_paths[@]}"; do
  closed="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "$sk_public_url$path" || true)"
  [[ "$closed" =~ ^302\ https://[a-z0-9-]+\.cloudflareaccess\.com/ ]] \
    || fail "$sk_public_url$path answers ${closed%% *} without the door's token; it must answer 302 to the Cloudflare Access login"
done
# The ready path has its own application for the uptime probe: 403 for anyone else, or the login
# when that application does not exist.
closed="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$sk_public_url$sk_ready_path" || true)"
case "$closed" in 302|403) ;; *) fail "$sk_public_url$sk_ready_path answers $closed without the door's token; it must answer 403 or 302" ;; esac
through=""
deadline=$((SECONDS + 60))
while :; do
  through="$(curl -fsS --max-time 15 -H @"$headers" "$sk_public_url$sk_ready_path" 2>/dev/null | served_commit || true)"
  [ "$through" = "$SHA" ] && break
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep "$POLL"
done
[ "$through" = "$SHA" ] || fail "through the door, $sk_public_url$sk_ready_path reports '${through:-nothing}'"
say "ready through the door: $sk_public_url serves $SHA"

[ "${SANDBOX_KIT_SMOKE:-1}" != 0 ] || exit 0
say "running the smoke against $sk_public_url"
"$KIT/sandbox-kit" smoke "$SHA"
