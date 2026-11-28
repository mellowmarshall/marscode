# shellcheck shell=bash
# Real binaries at host-guards shim destinations, for install.sh (sourced, never run): telling a
# shim from a real binary, finding the real binary for a name, and keeping any binary a shim would
# replace in $INSTALL_DIR/real. Reads install.sh's BIN_DIR, GUARDS_DIR, INSTALL_DIR, DRY_RUN,
# BIN_SHIMS and GUARD_SHIMS.

# True when the file is a host-guards shim: this installer's, or one an older devtools install
# wrote. Each kind is matched by its exact header, so a user's own wrapper that merely mentions
# host-guards is never taken for a shim:
#   - a bash shim: line 1 `#!/bin/bash -p`, line 2 "# MarsCode host ... shim" (or the older
#     "# Host ... shim"), and the shim's own REAL... assignment;
#   - a devtools package-manager guard: a link to home-dev-install-guard.py;
#   - a devtools cloud CLI guard: line 1 `#!/usr/bin/env bash`, line 2
#     "# managed by devtools/host-guards: ...", line 3 running exp-cli-guard.py.
is_guard_shim() {
  local line1="" line2="" line3="" header
  if [ -L "$1" ]; then
    case "$(readlink "$1")" in */home-dev-install-guard.py | home-dev-install-guard.py) return 0 ;; esac
  fi
  { IFS= read -r line1 && IFS= read -r line2; } <"$1" 2>/dev/null || return 1
  if [ "$line1" = "#!/usr/bin/env bash" ]; then
    case "$line2" in "# managed by devtools/host-guards: "*) ;; *) return 1 ;; esac
    line3="$(sed -n 3p "$1" 2>/dev/null)"
    case "$line3" in "exec /usr/bin/python3 -IB "*exp-cli-guard.py*) return 0 ;; *) return 1 ;; esac
  fi
  [ "$line1" = "#!/bin/bash -p" ] || return 1
  case "$line2" in "# MarsCode host "*shim* | "# Host "*shim*) ;; *) return 1 ;; esac
  header="$(head -c 4096 "$1" 2>/dev/null | tr -d '\000')" || return 1
  printf '%s\n' "$header" | grep -Eq "^REAL[A-Z_]*='"
}

# A free name for a kept-aside binary: NAME.displaced.TIME.PID[.N], never an existing path.
displaced_name() {
  local base name n=0
  base="$1.displaced.$(date +%s).$$"
  name="$base"
  while [ -e "$name" ] || [ -L "$name" ]; do
    n=$((n + 1))
    name="$base.$n"
  done
  printf '%s\n' "$name"
}

# Physical directory of a path (its parent's symlinks resolved, not the file's own link).
phys_dir() {
  (cd "$(dirname "$1")" 2>/dev/null && pwd -P) || printf '%s\n' "$(dirname "$1")"
}

phys_of() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
}

# True when the path is where this installer writes a shim ($BIN_DIR or $GUARDS_DIR).
is_shim_dest() {
  local dir name
  dir="$(phys_dir "$1")"
  name="$(basename "$1")"
  if [ "$dir" = "$(phys_of "$BIN_DIR")" ]; then
    case " $BIN_SHIMS " in *" $name "*) return 0 ;; esac
  fi
  if [ "$dir" = "$(phys_of "$GUARDS_DIR")" ]; then
    case " $GUARD_SHIMS " in *" $name "*) return 0 ;; esac
  fi
  return 1
}

# A real binary for NAME. A shim is skipped. Paths are recorded as found, never fully resolved:
# a version manager's bin/NAME is often a link to one multiplexer binary that dispatches on its
# own name. A shim destination is special, because the shim is written there: a link there is
# followed one step (to a target still named NAME); a real file there is returned as is, and
# keep_real moves it aside before its shim is written.
find_real_bin() {
  local name="$1"
  local fallback="$2"
  local candidate="" kept="$INSTALL_DIR/real/$1"
  IFS=: read -r -a path_parts <<<"${PATH:-/usr/local/bin:/usr/bin:/bin}"
  for dir in "${path_parts[@]}" /usr/local/bin /usr/bin /bin "$fallback"; do
    [ -n "$dir" ] || continue
    if [ "$dir" = "$fallback" ]; then candidate="$fallback"; else candidate="$dir/$name"; fi
    if is_shim_dest "$candidate"; then
      # A shim destination holds this installer's shim or something put there since. The binary
      # an earlier run kept in real/ comes first (it may be recorded in host-guards.json); a file
      # at the destination is used only when nothing was kept, and keep_real then keeps it. Any
      # other file there is kept aside by atomic_render_shim. A link is returned as the link.
      if [ -x "$kept" ] && ! is_guard_shim "$kept"; then
        printf '%s\n' "$kept"
        return 0
      fi
      if [ -x "$candidate" ] && [ ! -d "$candidate" ] && ! is_guard_shim "$candidate"; then
        printf '%s\n' "$candidate"
        return 0
      fi
      continue
    fi
    [ -x "$candidate" ] && [ -f "$candidate" ] || continue
    if is_guard_shim "$candidate"; then
      continue
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

# A real binary sitting where its own shim goes is moved to $INSTALL_DIR/real first and recorded
# there, so writing the shim neither destroys it nor makes the shim run itself. Sets KEPT_REAL.
# Renames NEW over KEPT itself; a KEPT that is a link to a directory is replaced, not entered.
replace_kept() {
  if [ -d "$2" ] && [ ! -L "$2" ]; then
    rm -f "$1"
    printf 'install.sh: fatal: %s is a directory, not a binary or shim\n' "$2" >&2
    exit 1
  fi
  if mv -T -f "$1" "$2" 2>/dev/null; then return 0; fi
  # BSD mv has no -T: drop a kept link first so the rename cannot land inside its target.
  if [ -L "$2" ]; then rm -f "$2"; fi
  mv -f "$1" "$2"
}

# Destinations whose binary this run kept (atomic_render_shim keeps any other one aside).
KEPT_SOURCES=" "

# KEPT_REAL is the result install.sh reads after each call.
# shellcheck disable=SC2034
keep_real() {
  local real="$1" kept="" target=""
  KEPT_REAL="$real"
  [ -n "$real" ] && is_shim_dest "$real" || return 0
  if is_guard_shim "$real"; then
    printf 'install.sh: fatal: %s is where a shim is written, not a real binary\n' "$real" >&2
    exit 1
  fi
  kept="$INSTALL_DIR/real/$(basename "$real")"
  KEPT_SOURCES="$KEPT_SOURCES$real "
  # Never write over a binary an earlier run kept (host-guards.json may record it): keep this one
  # beside it instead, and record that copy.
  if { [ -e "$kept" ] || [ -L "$kept" ]; } && ! is_guard_shim "$kept"; then
    if [ ! -L "$real" ] && [ ! -L "$kept" ] && cmp -s "$real" "$kept"; then
      KEPT_REAL="$kept"
      return 0
    fi
    kept="$(displaced_name "$kept")"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    # Nothing changes in a dry run, so the binary is still at its old path.
    printf '[dry-run] keep real binary %s at %s\n' "$real" "$kept"
    return 0
  fi
  mkdir -p "$INSTALL_DIR/real"
  if [ -L "$real" ]; then
    # Keep a link as a link (absolute), under the same name: a multiplexer dispatches on it. A link
    # to another shim destination (fly -> flyctl) is followed past it, because a shim replaces
    # that file too: a link there would run the other shim, which would run this one again.
    target="$real"
    local hops=0 next=""
    while [ -L "$target" ] && is_shim_dest "$target" && [ "$hops" -lt 16 ]; do
      next="$(readlink "$target")"
      case "$next" in /*) ;; *) next="$(phys_dir "$target")/$next" ;; esac
      target="$next"
      hops=$((hops + 1))
    done
    if is_shim_dest "$target"; then
      # The chain ends at a file where a shim goes: keep that file's bytes, never a link to it.
      if [ ! -f "$target" ] || is_guard_shim "$target"; then
        printf 'install.sh: fatal: %s leads to %s, which is not a real binary\n' "$real" "$target" >&2
        exit 1
      fi
      cp -p "$target" "$kept.new.$$" || { rm -f "$kept.new.$$"; exit 1; }
    else
      ln -s "$target" "$kept.new.$$"
    fi
    replace_kept "$kept.new.$$" "$kept"
  else
    # Copy, never move: the original stays in place until its shim replaces it, so an install
    # that stops early never takes the tool off PATH. Copy to a new name, then rename over the
    # old entry, so a link an earlier run kept there is replaced, never written through.
    cp -p "$real" "$kept.new.$$" || { rm -f "$kept.new.$$"; exit 1; }
    replace_kept "$kept.new.$$" "$kept"
  fi
  KEPT_REAL="$kept"
}

same_root() { # A B: true when both name the same directory (a leading ~ is HOME; links resolved)
  local a="$1" b="$2"
  case "$a" in \~) a="$HOME" ;; \~/*) a="$HOME/${a#\~/}" ;; esac
  case "$b" in \~) b="$HOME" ;; \~/*) b="$HOME/${b#\~/}" ;; esac
  [ ! -d "$a" ] || a="$(phys_of "$a")"
  [ ! -d "$b" ] || b="$(phys_of "$b")"
  [ "${a%/}" = "${b%/}" ]
}

# Keeps a binary at a shim destination that this run did not choose, as real/NAME.displaced.TIME
# (a link stays a link). Nothing records it; it is kept so a shim never destroys a user's binary.
keep_displaced() {
  local dst="$1" kept target=""
  kept="$(displaced_name "$INSTALL_DIR/real/$(basename "$dst")")"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] keep displaced binary %s at %s\n' "$dst" "$kept"
    return 0
  fi
  mkdir -p "$INSTALL_DIR/real"
  if [ -L "$dst" ]; then
    target="$(readlink "$dst")"
    case "$target" in /*) ;; *) target="$(phys_dir "$dst")/$target" ;; esac
    ln -s "$target" "$kept.new.$$"
  else
    cp -p "$dst" "$kept.new.$$" || { rm -f "$kept.new.$$"; exit 1; }
  fi
  replace_kept "$kept.new.$$" "$kept"
  printf 'install.sh: kept %s (not the binary its shim runs) at %s\n' "$dst" "$kept"
}
