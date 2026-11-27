"""MarsCode-owned Python bridge for ~/.local/lib/hg_t3_grant.py.

Preserves the exact module API expected by legacy host-guard callers (`hg_override.py`,
`host_guard.py`) while routing check-first protected-diff bundle inspection through
MarsCode's `marscode-guard` CLI with a strictly scrubbed subprocess environment.

Security invariants:
- `T3_GUARD_GRANT_SOCKET` and `MARSCODE_GUARD_BIN` overrides are rejected outside test mode.
- Parent dir + socket ownership/mode + no-symlink checks are enforced.
- `SO_PEERCRED` (Linux) / `LOCAL_PEERCRED`+`LOCAL_PEERPID` (macOS) verifies peer UID and
  (outside test mode) the live T3 server PID recorded in `server-runtime.json`.
- `marscode-guard inspect-bundle` runs under a minimal scrubbed environment (`PATH`, `HOME`)
  so caller-controlled `NODE_OPTIONS`, `GIT_*`, or `LD_*` cannot influence bundle digests.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Mapping

SOCKET_ENV = "T3_GUARD_GRANT_SOCKET"
TIMEOUT_ENV = "T3_GUARD_REQUEST_TIMEOUT"
CLI_ENV = "MARSCODE_GUARD_BIN"
DEFAULT_SOCKET_NAME = "t3-guard-grant.sock"
CHECK_TIMEOUT = 0.3
DEFAULT_REQUEST_TIMEOUT = 300.0
MIN_REQUEST_TIMEOUT = 1.0
MAX_REQUEST_TIMEOUT = 600.0
MAX_RESPONSE_BYTES = 65536
_BUNDLABLE_GUARDS = frozenset({"ship-queue", "playbook"})
_BUNDLE_CACHE: dict[tuple[str, tuple[str, ...], str], dict | None] = {}


def _passwd_home() -> str:
    try:
        import pwd
        return os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)
    except KeyError:
        return os.path.realpath(os.path.expanduser("~"))


def _is_test_install() -> bool:
    try:
        from hg_proc import _is_test_install as _proc_is_test_install
        return _proc_is_test_install()
    except ImportError:
        return os.environ.get("HOST_GUARDS_TEST") == "1"


def t3_server_pid() -> int | None:
    try:
        from hg_proc import t3_server_pid as _proc_t3_server_pid
        return _proc_t3_server_pid()
    except ImportError:
        import json

        runtime_path = os.path.join(_passwd_home(), ".t3", "userdata", "server-runtime.json")
        try:
            st = os.lstat(runtime_path)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or (st.st_mode & 0o077) != 0:
                return None
            with open(runtime_path, encoding="utf-8") as fh:
                pid = json.load(fh).get("pid")
            return pid if isinstance(pid, int) and not isinstance(pid, bool) and pid > 1 else None
        except (OSError, ValueError):
            return None


def _is_private_owned_dir(path: str, uid: int) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == uid and (st.st_mode & 0o077) == 0


def _default_socket_dir() -> str:
    """Matches GuardSocketPath.ts defaultGuardSocketPath() order on Linux/macOS."""
    uid = os.getuid()
    run_dir = f"/run/user/{uid}"
    if _is_private_owned_dir(run_dir, uid):
        return os.path.realpath(run_dir)
    xdg = os.environ.get("XDG_RUNTIME_DIR", "").strip()
    if xdg and _is_private_owned_dir(xdg, uid):
        return os.path.realpath(xdg)
    return os.path.join(os.path.realpath("/tmp"), f"t3-guard-{uid}")


def socket_path(env: Mapping[str, str] | None = None) -> str | None:
    """Verified owner-only Unix socket path, or None if unavailable/untrusted."""
    source = os.environ if env is None else env
    test_mode = _is_test_install()
    if SOCKET_ENV in source:
        override = source.get(SOCKET_ENV, "").strip()
        if not override or not test_mode:
            return None
        path = override
    else:
        path = os.path.join(_default_socket_dir(), DEFAULT_SOCKET_NAME)

    try:
        st = os.lstat(path)
        pst = os.lstat(os.path.dirname(path))
    except OSError:
        return None
    uid = os.getuid()
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != uid or (st.st_mode & 0o077) != 0:
        return None
    if not stat.S_ISDIR(pst.st_mode) or pst.st_uid != uid:
        return None
    if not test_mode and (pst.st_mode & 0o077) != 0:
        return None
    if os.path.realpath(path) != os.path.abspath(path):
        return None
    return path


def available(env: Mapping[str, str] | None = None) -> bool:
    return socket_path(env) is not None


def argv_digest(command: list[str]) -> str:
    import hashlib

    payload = "\0".join(command).encode("utf-8", errors="surrogateescape")
    return hashlib.sha256(payload).hexdigest()


def _request_timeout(env: Mapping[str, str] | None = None, explicit: float | None = None) -> float:
    if explicit is not None:
        return max(MIN_REQUEST_TIMEOUT, min(MAX_REQUEST_TIMEOUT, float(explicit)))
    raw = (os.environ if env is None else env).get(TIMEOUT_ENV, "").strip()
    if raw:
        try:
            return max(MIN_REQUEST_TIMEOUT, min(MAX_REQUEST_TIMEOUT, float(raw)))
        except ValueError:
            pass
    return DEFAULT_REQUEST_TIMEOUT


def _marscode_guard_bin(source: Mapping[str, str]) -> str | None:
    """Resolve the owner-trusted `marscode-guard` CLI binary, or None."""
    uid = os.getuid()
    if _is_test_install() and source.get(CLI_ENV, "").strip():
        cand = source.get(CLI_ENV, "").strip()
    else:
        cand = os.path.join(_passwd_home(), ".local", "bin", "marscode-guard")
    try:
        st = os.lstat(cand)
        pst = os.lstat(os.path.dirname(cand))
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode) or not os.access(cand, os.X_OK):
        return None
    if st.st_uid not in (0, uid) or (st.st_mode & 0o022) != 0:
        return None
    if not stat.S_ISDIR(pst.st_mode) or pst.st_uid not in (0, uid) or (pst.st_mode & 0o022) != 0:
        return None
    return cand


def _inspect_bundle(guard: str, command: list[str], cwd: str, source: Mapping[str, str]) -> dict | None:
    """Invoke `marscode-guard inspect-bundle` under a scrubbed env (cached per process)."""
    guard_norm = guard.strip().lower()
    if guard_norm not in _BUNDLABLE_GUARDS:
        return None
    real_cwd = os.path.realpath(cwd) if cwd else os.getcwd()
    cache_key = (guard_norm, tuple(command), real_cwd)
    if cache_key in _BUNDLE_CACHE:
        return _BUNDLE_CACHE[cache_key]
    cli = _marscode_guard_bin(source)
    if not cli:
        return None
    import json
    import subprocess

    argv = [cli, "inspect-bundle", guard, "--cwd", real_cwd, "--", *command]
    scrubbed_env = {"PATH": "/usr/bin:/bin", "HOME": _passwd_home()}
    bundle: dict | None = None
    try:
        res = subprocess.run(
            argv, capture_output=True, text=True, timeout=3.0, check=False, env=scrubbed_env,
        )
        if res.returncode == 0 and res.stdout.strip():
            parsed = json.loads(res.stdout)
            if isinstance(parsed, dict):
                bundle = parsed
    except (OSError, subprocess.SubprocessError, ValueError):
        bundle = None
    _BUNDLE_CACHE[cache_key] = bundle
    return bundle


def _peer_pid_uid(sock) -> tuple[int, int] | None:
    import socket
    import struct
    import sys

    if hasattr(socket, "SO_PEERCRED"):
        try:
            creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
            peer_pid, peer_uid, _peer_gid = struct.unpack("3i", creds)
            return peer_pid, peer_uid
        except OSError:
            return None
    if sys.platform == "darwin":
        try:
            xucred = sock.getsockopt(0, 0x001, 76)
            _ver, peer_uid = struct.unpack_from("II", xucred, 0)
            (peer_pid,) = struct.unpack("i", sock.getsockopt(0, 0x002, struct.calcsize("i")))
            return peer_pid, peer_uid
        except (OSError, struct.error):
            return None
    return None


def _is_valid_boot_unit_file(unit_path: str, uid: int) -> bool:
    from hg_proc import _UNTRUSTED_EXE_PREFIXES

    if not unit_path:
        return False
    real_path = os.path.realpath(unit_path)
    if real_path.startswith(_UNTRUSTED_EXE_PREFIXES) or "/systemd/transient/" in real_path:
        return False
    try:
        st = os.lstat(real_path)
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and st.st_uid in (0, uid)


def _has_installed_t3_boot_unit() -> bool:
    import subprocess
    from hg_proc import _canonical_home

    uid = os.getuid()
    systemctl = "/usr/bin/systemctl" if os.path.isfile("/usr/bin/systemctl") else "/bin/systemctl"
    if os.path.isfile(systemctl):
        try:
            res = subprocess.run(
                [systemctl, "--user", "show", "-p", "FragmentPath", "-p", "Transient", "t3code.service"],
                env={"PATH": "/usr/bin:/bin", "XDG_RUNTIME_DIR": f"/run/user/{uid}"},
                capture_output=True, text=True, timeout=2,
            )
            if res.returncode == 0:
                props = dict(line.split("=", 1) for line in res.stdout.splitlines() if "=" in line)
                if props.get("Transient", "").strip() != "no":
                    return False
                return _is_valid_boot_unit_file(props.get("FragmentPath", "").strip(), uid)
        except (OSError, subprocess.SubprocessError):
            pass

    candidates = ["/etc/systemd/user/t3code.service", "/usr/lib/systemd/user/t3code.service"]
    canon = _canonical_home()
    if canon:
        candidates.insert(0, os.path.join(canon, ".config", "systemd", "user", "t3code.service"))
    return any(_is_valid_boot_unit_file(p, uid) for p in candidates)


def _verify_peer(sock) -> bool:
    creds = _peer_pid_uid(sock)
    if creds is None:
        return False
    peer_pid, peer_uid = creds
    if peer_uid != os.getuid():
        return False
    if _is_test_install():
        return True
    server_pid = t3_server_pid()
    if server_pid is None or peer_pid != server_pid:
        return False
    try:
        import re
        from hg_proc import _SYSTEMD_USER_SERVICE_RE, is_agent_cgroup, is_agent_process
    except ImportError:
        return True
    try:
        with open(f"/proc/{peer_pid}/cgroup", encoding="utf-8") as fh:
            cg = fh.read()
    except OSError:
        cg = ""
    if cg:
        if _SYSTEMD_USER_SERVICE_RE.search(cg):
            is_t3_svc = bool(re.search(r"/user@\d+\.service/(?:[^/\n]+/)*t3code\.service(?:\s|$)", cg))
            if not (is_t3_svc and _has_installed_t3_boot_unit()):
                return False
        if "app-t3code-agents" in cg or "t3code-" in cg or is_agent_cgroup(cg):
            return False
    return not is_agent_process(start=peer_pid, test_override=False)


def _rpc(path: str, req: dict, timeout: float) -> tuple[dict | None, str]:
    """Send one NDJSON request and read one NDJSON response under a wall-clock deadline."""
    import json
    import socket
    import time

    line = (json.dumps(req, separators=(",", ":")) + "\n").encode("utf-8")
    deadline = time.monotonic() + timeout
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(max(0.001, deadline - time.monotonic()))
            sock.connect(path)
            if not _verify_peer(sock):
                return None, "peer"
            sock.sendall(line)
            chunks: list[bytes] = []
            total = 0
            found_nl = False
            while total < MAX_RESPONSE_BYTES:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None, "timeout"
                sock.settimeout(remaining)
                chunk = sock.recv(min(4096, MAX_RESPONSE_BYTES - total))
                if not chunk:
                    break
                nl = chunk.find(b"\n")
                if nl != -1:
                    chunks.append(chunk[:nl])
                    found_nl = True
                    break
                chunks.append(chunk)
                total += len(chunk)
            if total >= MAX_RESPONSE_BYTES and not found_nl:
                return None, "protocol"
    except TimeoutError:
        return None, "timeout"
    except OSError:
        return None, "unreachable"
    if not chunks:
        return None, "protocol"
    try:
        data = json.loads(b"".join(chunks).decode("utf-8", errors="replace"))
    except ValueError:
        return None, "protocol"
    return (data, "") if isinstance(data, dict) else (None, "protocol")


def _valid_grant(resp: dict | None, fallback_reason: str = "") -> dict | None:
    if not isinstance(resp, dict) or resp.get("ok") is not True:
        return None
    grant_id = resp.get("grant_id")
    if not isinstance(grant_id, str):
        return None
    gid = grant_id.strip()
    if not gid or any(ord(c) < 32 or ord(c) == 127 for c in gid):
        return None
    approved_by = resp.get("approved_by")
    if approved_by is not None and approved_by != "" and approved_by != "human":
        return None
    reason = resp.get("reason")
    reason_str = (reason.strip() if isinstance(reason, str) else "") or fallback_reason.strip() or "Approved via T3 input request"
    thread_id = resp.get("thread_id")
    approved_via = resp.get("approved_via")
    out: dict = {
        "grant_id": gid,
        "reason": reason_str,
        "thread_id": thread_id.strip() if isinstance(thread_id, str) else "",
        "approved_by": "human",
        "approved_via": approved_via.strip() if isinstance(approved_via, str) else "",
    }
    if resp.get("scope") in ("once", "bundle"):
        out["scope"] = resp["scope"]
    if isinstance(resp.get("signature"), str) and resp["signature"]:
        out["signature"] = resp["signature"]
    return out


def _base_req(
    op: str, guard: str, command: list[str], cwd: str,
    source: Mapping[str, str], session: str, thread_id: str,
) -> dict:
    req: dict = {
        "v": 1, "op": op, "guard": guard, "command": command,
        "argv_sha256": argv_digest(command),
        "cwd": os.path.realpath(cwd) if cwd else "",
        "thread_id": thread_id or source.get("T3CODE_THREAD_ID", "").strip(),
        "session": session, "pid": os.getpid(),
    }
    bundle = _inspect_bundle(guard, command, cwd, source)
    if bundle is not None:
        req["bundle"] = bundle
    return req


def peek(
    guard: str, command: list[str], cwd: str, env: Mapping[str, str] | None = None,
    *, session: str = "", thread_id: str = "", _sock: str | None = None,
) -> bool:
    """Non-consuming check whether a pre-approved once or bundle grant exists."""
    path = _sock if _sock is not None else socket_path(env)
    if not path:
        return False
    source = os.environ if env is None else env
    resp, err = _rpc(path, _base_req("peek", guard, command, cwd, source, session, thread_id), CHECK_TIMEOUT)
    return err == "" and isinstance(resp, dict) and resp.get("ok") is True


def check_with_err(
    guard: str, command: list[str], cwd: str, env: Mapping[str, str] | None = None,
    *, session: str = "", thread_id: str = "", _sock: str | None = None,
) -> tuple[dict | None, str]:
    """Consume a pre-approved once grant or match a stored bundle grant."""
    path = _sock if _sock is not None else socket_path(env)
    if not path:
        return None, "unreachable"
    source = os.environ if env is None else env
    resp, err = _rpc(path, _base_req("check", guard, command, cwd, source, session, thread_id), CHECK_TIMEOUT)
    return (None, err) if err else (_valid_grant(resp), "")


def check(
    guard: str, command: list[str], cwd: str, env: Mapping[str, str] | None = None,
    *, session: str = "", thread_id: str = "", _sock: str | None = None,
) -> dict | None:
    grant, _err = check_with_err(guard, command, cwd, env, session=session, thread_id=thread_id, _sock=_sock)
    return grant


def enqueue(
    guard: str, command: list[str], cwd: str, refusal: str, proposed_reason: str = "",
    env: Mapping[str, str] | None = None, *, session: str = "", thread_id: str = "",
    consume_existing: bool = True, _sock: str | None = None,
) -> tuple[dict | None, bool, bool, str]:
    """Submit a non-blocking T3 approval request (never blocks PreToolUse hooks)."""
    path = _sock if _sock is not None else socket_path(env)
    if not path:
        return None, False, False, ""
    source = os.environ if env is None else env
    req = _base_req("request", guard, command, cwd, source, session, thread_id)
    req["wait"] = False
    req["consume_existing"] = consume_existing
    req["refusal"] = refusal.splitlines()[0] if refusal else ""
    req["proposed_reason"] = proposed_reason.strip()
    resp, err = _rpc(path, req, CHECK_TIMEOUT)
    if err == "peer":
        return None, False, False, "T3 approval broker peer verification failed"
    if err or not isinstance(resp, dict):
        return None, False, False, "T3 approval broker did not respond"
    if resp.get("already_approved") is True:
        return None, True, False, ""
    grant = _valid_grant(resp, fallback_reason=proposed_reason)
    if grant is not None:
        return grant, False, False, ""
    if resp.get("queued") is True or resp.get("ok") is True:
        return None, False, True, "approval requested in T3 Code; re-run the exact command once approved"
    return None, False, False, str(resp.get("detail") or resp.get("error") or "could not enqueue T3 approval")


def request(
    guard: str, command: list[str], cwd: str, refusal: str, proposed_reason: str = "",
    env: Mapping[str, str] | None = None, *, session: str = "", thread_id: str = "",
    timeout: float | None = None, _sock: str | None = None,
) -> tuple[dict | None, str, bool]:
    """Ask MarsCode / T3 Code to raise a native human input request for this override."""
    path = _sock if _sock is not None else socket_path(env)
    if not path:
        return None, "", False
    source = os.environ if env is None else env
    req = _base_req("request", guard, command, cwd, source, session, thread_id)
    req["refusal"] = refusal.splitlines()[0] if refusal else ""
    req["proposed_reason"] = proposed_reason.strip()
    resp, err = _rpc(path, req, _request_timeout(source, timeout))
    if err == "timeout":
        return None, "timed out waiting for T3 owner approval", False
    if err == "peer":
        return None, "T3 approval broker peer verification failed", False
    if err or resp is None:
        return None, "T3 approval broker did not respond", False
    grant = _valid_grant(resp, fallback_reason=proposed_reason)
    if grant is not None:
        return grant, "", False
    denied = bool(resp.get("denied"))
    detail = str(resp.get("detail") or resp.get("error") or ("denied by owner via T3" if denied else "not approved"))
    return None, detail, denied
