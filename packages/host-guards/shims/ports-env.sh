# shellcheck shell=bash
# Fast pure-bash .env.ports loader (zero Node startup on normal commands).

ports_env_find_dir() {
  local dir="${1:-$PWD}"
  while [ -n "$dir" ]; do
    if [ -f "$dir/.env.ports" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    [ "$dir" != "/" ] || return 1
    dir="${dir%/*}"
    [ -n "$dir" ] || dir="/"
  done
  return 1
}

ports_env_load() { # DIR
  local where="$1"
  local same=0
  [ "${HG_PORTS_DIR:-}" = "$where" ] && same=1

  if [ "$same" = 0 ] && [ -n "${HG_PORTS_NAMES:-}" ]; then
    local name pair k v cur
    for name in $HG_PORTS_NAMES; do
      case "$name" in
        [A-Z]*_PORT)
          local expected="" found=0
          for pair in ${HG_PORTS_VALUES:-}; do
            k="${pair%%=*}"
            v="${pair#*=}"
            if [ "$k" = "$name" ]; then
              expected="$v"
              found=1
              break
            fi
          done
          cur="${!name-}"
          if [ "$found" = 0 ] || [ "$cur" = "$expected" ]; then
            unset "$name"
          fi
          ;;
      esac
    done
  fi

  local ours="" values="" line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      [A-Z]*_PORT=[0-9]*)
        key="${line%%=*}"
        val="${line#*=}"
        case "$val" in *[!0-9]*|'') continue ;; esac
        if [ -z "${!key+x}" ]; then
          export "$key=$val"
          ours="${ours:+$ours }$key"
          values="${values:+$values }$key=$val"
        elif [ "$same" = 1 ]; then
          case " ${HG_PORTS_NAMES:-} " in
            *" $key "*)
              ours="${ours:+$ours }$key"
              values="${values:+$values }$key=${!key}"
              ;;
          esac
        fi
        ;;
    esac
  done < "$where/.env.ports"

  export HG_PORTS_DIR="$where" HG_PORTS_NAMES="$ours" HG_PORTS_VALUES="$values"
}

ports_env_exec() { # REAL ARGS...
  local real="$1"
  shift
  local where=""
  if where="$(ports_env_find_dir "$PWD")"; then
    ports_env_load "$where"
  fi
  exec "$real" "$@"
}
