#!/usr/bin/env bash
# Keeps a CI host's Docker engine answering. OrbStack on the
# Mac hangs or stops while the Mac sleeps unused; before #874 the queue read
# the client's version only, and a hung engine surfaced as docker-shared-root
# "needs-admin".
#
#   ci-docker-engine.sh heal              0 when the engine answers, restarting it
#                                         first where a user can; 1 with the reason;
#                                         3 when another heal holds the lock
#   ci-docker-engine.sh watch             the launchd agent's run: heal, then the
#                                         daily cleanup, logged in $DIR/watch.log
#   ci-docker-engine.sh install-watchdog  (macOS) the launchd agent that runs
#                                         `watch` every 10 minutes and at load
#
# The heal restarts only an engine the user owns: OrbStack and Docker Desktop
# (quit, then relaunch), or a rootless dockerd (its systemd user unit). A
# system dockerd is an admin's to restart, and a missing docker an admin's to
# install: the reason says so. An engine that fails one ask is asked again
# before anything restarts, so a busy engine is never killed under a CI job;
# one heal at a time (a lock), an app that ignores its quit is killed, and
# after two failed restarts the watchdog tries at most once an hour.
# The cleanup removes only what regenerates: build cache older than 7 days and
# dangling images. Never a container or a volume: the Mac is also a person's.
#
# /bin/bash on a Mac is 3.2, and launchd runs this with it: no bash 4 here.
set -u

LABEL=ship-queue-ci.docker-watchdog
# The watchdog's version: the docker-watchdog tool's probe reads it, and a
# change to the agent raises it, so every Mac is drift until it is reinstalled.
WATCHDOG_VERSION=1
DIR="$HOME/.local/share/ship-queue-ci/docker-watchdog"

# CMD's exit, or 124 when it outlasts SECONDS (killed). No timeout(1) on a
# bare Mac.
within() { # SECONDS CMD...
  local s=$1 p w=0
  shift
  "$@" &
  p=$!
  while kill -0 "$p" 2>/dev/null; do
    if [ "$w" -ge "$s" ]; then
      kill -TERM "$p" 2>/dev/null; sleep 1; kill -KILL "$p" 2>/dev/null
      wait "$p" 2>/dev/null
      return 124
    fi
    sleep 1; w=$((w + 1))
  done
  wait "$p"
}

answers() { within 20 docker version --format '{{.Server.Version}}' >/dev/null 2>&1; }

# Which engine the client talks to: orbstack, desktop, rootless or system.
engine() {
  local ctx
  ctx=$(within 10 docker context show 2>/dev/null) || ctx=""
  case "$ctx" in
    orbstack) echo orbstack ;;
    desktop-linux|default-desktop*) echo desktop ;;
    rootless) echo rootless ;;
    colima|colima-*) echo "$ctx" ;;
    *)
      if [ "$(uname -s)" = Darwin ] && [ -d /Applications/OrbStack.app ]; then echo orbstack
      elif [ "$(uname -s)" = Darwin ] && [ -d /Applications/Docker.app ]; then echo desktop
      else echo system; fi ;;
  esac
}

# Up to 180 s for the engine to answer after a restart.
wait_answers() {
  local i=0
  while [ "$i" -lt 18 ]; do answers && return 0; sleep 10; i=$((i + 1)); done
  return 1
}

# 0 once no process of these names runs, within 15 s; 1 when one still does
# (a wedged app ignores its quit).
gone() { # NAME...
  local i=0 n busy
  while [ "$i" -lt 15 ]; do
    busy=""
    for n in "$@"; do ! pgrep -x "$n" >/dev/null 2>&1 || busy=1; done
    [ -n "$busy" ] || return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}

restart() { # ENGINE -> 0 when it answers again; 1 with the reason on stdout
  local p
  case "$1" in
    orbstack)
      within 60 orb stop >/dev/null 2>&1
      killall OrbStack >/dev/null 2>&1
      gone OrbStack "OrbStack Helper" || { echo "OrbStack did not quit; killed" >&2; killall -KILL OrbStack "OrbStack Helper" >/dev/null 2>&1; sleep 2; }
      open -ga OrbStack || { echo "OrbStack could not be opened again"; return 1; } ;;
    desktop)
      within 30 osascript -e 'quit app "Docker"' >/dev/null 2>&1
      gone "Docker Desktop" Docker || { killall -KILL "Docker Desktop" Docker >/dev/null 2>&1; sleep 2; }
      open -ga Docker || { echo "Docker Desktop could not be opened again"; return 1; } ;;
    colima|colima-*)
      # The context colima-PROFILE is that profile's engine; colima is the default's.
      p=${1#colima}; p=${p#-}
      within 180 colima restart ${p:+"$p"} >/dev/null 2>&1 || { echo "colima restart ${p:-default} failed"; return 1; } ;;
    rootless)
      within 60 systemctl --user restart docker >/dev/null 2>&1 ||
        { echo "systemctl --user restart docker failed"; return 1; } ;;
    *)
      echo "the engine is the system's dockerd: an admin restarts it (sudo systemctl restart docker)"
      return 1 ;;
  esac
  wait_answers || { echo "the $1 engine was restarted and still does not answer after 180 s"; return 1; }
}

# One heal at a time on a host: provision's and the agent's never restart the
# engine together. A lock older than 15 minutes is a killed heal's.
lock() {
  mkdir -p "$DIR" || return 1
  if ! mkdir "$DIR/heal.lock" 2>/dev/null; then
    [ -n "$(find "$DIR/heal.lock" -maxdepth 0 -mmin +15 2>/dev/null)" ] || return 1
    rm -rf "$DIR/heal.lock"; mkdir "$DIR/heal.lock" 2>/dev/null || return 1
  fi
  trap 'rm -rf "$DIR/heal.lock"' EXIT
}

heal() {
  local e why
  command -v docker >/dev/null 2>&1 ||
    { echo "docker is not installed: an admin installs OrbStack, Docker Desktop or docker-ce"; return 1; }
  answers && return 0
  sleep 20
  answers && return 0
  lock || { echo "another heal is restarting the engine"; return 3; }
  e=$(engine)
  why=$(restart "$e") || { echo "$why"; return 1; }
  echo "the $e engine did not answer; restarted, and it answers"
}

cleanup() {
  within 300 docker builder prune -f --filter until=168h >/dev/null 2>&1
  within 300 docker image prune -f >/dev/null 2>&1
  return 0
}

stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }

watch() {
  local out day fails r
  # No docker on this Mac: nothing to watch, and nothing to log every 10 minutes.
  command -v docker >/dev/null 2>&1 || return 0
  mkdir -p "$DIR" || return 1
  # One old log kept, so it never grows without end.
  if [ -f "$DIR/watch.log" ] && [ "$(wc -c < "$DIR/watch.log")" -gt 1048576 ]; then mv -f "$DIR/watch.log" "$DIR/watch.log.1"; fi
  # Two failed restarts in a row: then at most one an hour, so an engine that
  # cannot come back (an update dialog, a VM that will not start) is not
  # killed and relaunched every 10 minutes for ever.
  fails=$(cat "$DIR/failures" 2>/dev/null) || fails=0
  case "$fails" in ''|*[!0-9]*) fails=0 ;; esac
  if [ "$fails" -ge 2 ] && [ -n "$(find "$DIR/failures" -mmin -60 2>/dev/null)" ]; then return 1; fi
  out=$(heal); r=$?
  if [ "$r" = 0 ]; then
    rm -f "$DIR/failures"
    [ -z "$out" ] || echo "$(stamp) $out" >> "$DIR/watch.log"
  elif [ "$r" = 3 ]; then
    # Another heal (a provision's) is restarting it: not this run's failure.
    return 0
  else
    echo $((fails + 1)) > "$DIR/failures"
    echo "$(stamp) FAILED: $out" >> "$DIR/watch.log"
    return 1
  fi
  day=$(date +%Y-%m-%d)
  [ "$(cat "$DIR/cleaned" 2>/dev/null)" != "$day" ] || return 0
  cleanup
  echo "$day" > "$DIR/cleaned"
  echo "$(stamp) cleanup: build cache older than 7 days, dangling images" >> "$DIR/watch.log"
}

install_watchdog() {
  local plist="$HOME/Library/LaunchAgents/$LABEL.plist" uid
  [ "$(uname -s)" = Darwin ] || { echo "ci-docker-engine: the watchdog is a launchd agent: macOS only" >&2; return 1; }
  uid=$(id -u)
  mkdir -p "$DIR" "$HOME/Library/LaunchAgents" || return 1
  # Its own copy: a provision replaces the devtools copy under a running agent.
  cp -f "${BASH_SOURCE[0]}" "$DIR/ci-docker-engine.sh.next" || return 1
  cat > "$plist.next" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/ci-docker-engine.sh</string><string>watch</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/.orbstack/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>$DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$DIR/launchd.log</string>
</dict>
</plist>
PLIST
  # Every provision runs this (refresh): an agent already running this script
  # and plist is left as it is, never stopped mid-run.
  if cmp -s "$DIR/ci-docker-engine.sh.next" "$DIR/ci-docker-engine.sh" && cmp -s "$plist.next" "$plist" &&
    launchctl print "gui/$uid/$LABEL" >/dev/null 2>&1; then
    rm -f "$DIR/ci-docker-engine.sh.next" "$plist.next"
    echo "$WATCHDOG_VERSION" > "$DIR/VERSION"
    return 0
  fi
  mv -f "$DIR/ci-docker-engine.sh.next" "$DIR/ci-docker-engine.sh" && mv -f "$plist.next" "$plist" || return 1
  launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1
  launchctl bootstrap "gui/$uid" "$plist" ||
    { echo "ci-docker-engine: launchctl bootstrap gui/$uid $plist failed (no one logged in at the Mac's screen?)" >&2; return 1; }
  echo "$WATCHDOG_VERSION" > "$DIR/VERSION"
}

case "${1:-}" in
  heal) heal ;;
  watch) watch ;;
  install-watchdog) install_watchdog ;;
  *) echo "usage: ci-docker-engine.sh heal|watch|install-watchdog" >&2; exit 2 ;;
esac
