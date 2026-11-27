#!/usr/bin/env python3
"""The repo's sandbox declaration, checked and joined with its fleet shape (private-repo).

The declaration (default deploy/sandbox/sandbox.json) holds only what the fleet shape does not.
Everything the fleet shape holds is read from it: the server's remote directory and ssh variable,
the Doppler project and its sbx names, the hostname's zone. Nothing here touches the network.

  sandbox_declaration.py check [--declaration PATH]          print what it resolved
  sandbox_declaration.py shell [--declaration PATH] COMMIT   bash assignments for sandbox-kit
  sandbox_declaration.py edge  [--declaration PATH]          the edge plan, JSON, for sandbox-edge.mjs

Run from the repo root. Every path is relative to it.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys

DEFAULT_DECLARATION = "deploy/sandbox/sandbox.json"
# The kit deploys the sandbox only. The other environment name is prd.
DOPPLER_CONFIG = "sbx"

REPO_PATH = re.compile(r"^(?!/)(?!.*(^|/)\.\.(/|$))[A-Za-z0-9._][A-Za-z0-9._/-]*$")
REMOTE_DIR = re.compile(r"^/(?!.*(^|/)\.\.(/|$))[A-Za-z0-9._/-]+$")
ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
# An ssh name: never an option (no leading dash), no spaces.
SSH_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
CF_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
IMAGE = re.compile(r"^[a-z0-9]+([._/-][a-z0-9]+)*$")
HOSTNAME = re.compile(r"^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$")
URL_PATH = re.compile(r"^/[A-Za-z0-9._~/-]*$")
LOOPBACK_URL = re.compile(r"^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?/[A-Za-z0-9._~/-]*$")
SERVICE = re.compile(r"^(https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?|http_status:[1-5][0-9]{2})$")

REQUIRED_KEYS = {"fleetShape", "server", "doppler", "hostname", "composeProject", "composeFiles", "images",
                 "ready", "closedPaths", "accessToken", "tunnelToken", "smoke", "edge"}
OPTIONAL_KEYS = {"copy", "dirs", "env"}
EDGE_KEYS = {"accessApp", "policySourceApp", "serviceToken", "tunnel", "probeApp", "ingress"}


class DeclarationError(Exception):
    """A declaration or fleet shape that the kit refuses. The message says which field and why."""


def _need(condition: bool, message: str) -> None:
    if not condition:
        raise DeclarationError(message)


def _match(pattern: re.Pattern, value, field: str) -> str:
    _need(isinstance(value, str) and bool(pattern.match(value)), f"{field}: {value!r} is not valid")
    return value


def _keys(obj, required: set, optional: set, field: str) -> None:
    _need(isinstance(obj, dict), f"{field}: must be an object")
    missing = sorted(required - obj.keys())
    unknown = sorted(obj.keys() - required - optional)
    _need(not missing, f"{field}: missing {', '.join(missing)}")
    _need(not unknown, f"{field}: unknown {', '.join(unknown)}")


def _repo_file(root: str, value, field: str) -> str:
    """A regular file that git tracks. An ignored file or a symlink is not part of the commit a deploy is of."""
    path = _match(REPO_PATH, value, field)
    listed = subprocess.run(["git", "-C", root, "ls-files", "-s", "--", path], capture_output=True, text=True).stdout.split("\n")
    modes = [line.split(" ", 1)[0] for line in listed if line.endswith("\t" + path)]
    _need(modes in (["100644"], ["100755"]) and os.path.isfile(os.path.join(root, path)),
          f"{field}: {path} is not a regular file that git tracks")
    return path


def _list(value, field: str) -> list:
    _need(isinstance(value, list) and len(value) > 0, f"{field}: must be a non-empty list")
    return value


def validate_ingress(rules) -> list[dict]:
    """Each rule has a service and an optional path regex. A rule without a path catches the rest, so only the last may lack one."""
    rules = _list(rules, "edge.ingress")
    out = []
    for index, rule in enumerate(rules):
        field = f"edge.ingress[{index}]"
        _keys(rule, {"service"}, {"path"}, field)
        _match(SERVICE, rule["service"], f"{field}.service")
        if "path" in rule:
            _need(isinstance(rule["path"], str) and rule["path"] != "" and "\n" not in rule["path"], f"{field}.path: must be a regex")
            re.compile(rule["path"])
        else:
            _need(index == len(rules) - 1, f"{field}: a rule without a path must be the last")
        out.append(dict(rule))
    return out


def validate(declaration, root: str) -> dict:
    """The declaration's own fields, checked. Files it names must exist in the repo."""
    d = declaration
    _keys(d, REQUIRED_KEYS, OPTIONAL_KEYS, "declaration")
    _repo_file(root, d["fleetShape"], "fleetShape")
    _match(SSH_NAME, d["server"], "server")
    _need(isinstance(d["doppler"], str) and d["doppler"] != "", "doppler: must name a fleet shape provider")
    _match(HOSTNAME, d["hostname"], "hostname")
    _match(SLUG, d["composeProject"], "composeProject")
    compose = [_repo_file(root, f, f"composeFiles[{i}]") for i, f in enumerate(_list(d["composeFiles"], "composeFiles"))]
    names = [os.path.basename(f) for f in compose]
    _need(len(set(names)) == len(names), "composeFiles: two files share a name; the host keeps them side by side")
    copy = d.get("copy", {})
    _need(isinstance(copy, dict), "copy: must map repo files to host paths")
    for source, target in copy.items():
        _repo_file(root, source, f"copy[{source!r}]")
        _match(REPO_PATH, target, f"copy[{source!r}] target")
        _need(not target.startswith(".env") and target not in names,
              f"copy[{source!r}] target: {target} is the host's environment file or a compose file; the kit writes those")
    dirs = d.get("dirs", [])
    _need(isinstance(dirs, list), "dirs: must be a list")
    for i, path in enumerate(dirs):
        _match(REPO_PATH, path, f"dirs[{i}]")
    for i, image in enumerate(_list(d["images"], "images")):
        _keys(image, {"image", "dockerfile"}, set(), f"images[{i}]")
        _match(IMAGE, image["image"], f"images[{i}].image")
        _repo_file(root, image["dockerfile"], f"images[{i}].dockerfile")
    env = d.get("env", {})
    _need(isinstance(env, dict), "env: must map names to values")
    for name, value in env.items():
        _match(ENV_NAME, name, f"env name {name!r}")
        _need(isinstance(value, str) and "\n" not in value and "\r" not in value, f"env[{name}]: must be one line of text")
    _keys(d["ready"], {"origin", "path"}, set(), "ready")
    _match(LOOPBACK_URL, d["ready"]["origin"], "ready.origin")
    _match(URL_PATH, d["ready"]["path"], "ready.path")
    for i, path in enumerate(_list(d["closedPaths"], "closedPaths")):
        _match(URL_PATH, path, f"closedPaths[{i}]")
    _keys(d["accessToken"], {"id", "secret"}, set(), "accessToken")
    _match(ENV_NAME, d["accessToken"]["id"], "accessToken.id")
    _match(ENV_NAME, d["accessToken"]["secret"], "accessToken.secret")
    _need(d["accessToken"]["id"] != d["accessToken"]["secret"], "accessToken: id and secret must be two names")
    _match(ENV_NAME, d["tunnelToken"], "tunnelToken")
    _need(d["tunnelToken"] not in d["accessToken"].values(), "tunnelToken: must differ from the access token names")
    _need(isinstance(d["smoke"], str) and d["smoke"].strip() != "", "smoke: must be a command")
    _keys(d["edge"], EDGE_KEYS, set(), "edge")
    for key in sorted(EDGE_KEYS - {"ingress"}):
        _match(CF_NAME, d["edge"][key], f"edge.{key}")
    _need(d["edge"]["accessApp"] != d["edge"]["probeApp"], "edge: accessApp and probeApp must differ")
    _need(d["edge"]["accessApp"] != d["edge"]["policySourceApp"], "edge: accessApp must not be its own policy source")
    validate_ingress(d["edge"]["ingress"])
    return d


def _server(providers: dict, name: str) -> dict:
    found = [p["servers"][name] for p in providers.values()
             if isinstance(p, dict) and isinstance(p.get("servers"), dict) and name in p["servers"]]
    _need(len(found) == 1, f"server: {name} is declared {len(found)} times in the fleet shape's providers; it must be once")
    server = found[0]
    remote_dir = _match(REMOTE_DIR, server.get("remoteDir"), f"fleet shape server {name}.remoteDir")
    variable = server.get("sshHostVariable")
    if variable is not None:
        _match(ENV_NAME, variable, f"fleet shape server {name}.sshHostVariable")
    return {"name": name, "remoteDir": remote_dir, "sshHostVariable": variable}


def _doppler(providers: dict, name: str) -> dict:
    provider = providers.get(name)
    _need(isinstance(provider, dict), f"doppler: {name} is not a fleet shape provider")
    _need(provider.get("kind", "doppler") == "doppler", f"doppler: provider {name} is kind {provider.get('kind')!r}, not doppler")
    project = _match(SLUG, provider.get("project"), f"fleet shape provider {name}.project")
    config = (provider.get("configs") or {}).get(DOPPLER_CONFIG)
    _need(isinstance(config, dict), f"doppler: provider {name} declares no configs.{DOPPLER_CONFIG}")
    required = config.get("required", [])
    optional = config.get("optional", [])
    for field, names in (("required", required), ("optional", optional)):
        _need(isinstance(names, list), f"fleet shape {name}.configs.{DOPPLER_CONFIG}.{field}: must be a list")
        for item in names:
            _match(ENV_NAME, item, f"fleet shape {name}.configs.{DOPPLER_CONFIG}.{field}")
    return {"project": project, "config": DOPPLER_CONFIG, "required": sorted(required), "optional": sorted(optional)}


def _zone(cloudflare: dict, hostname: str) -> str:
    _need(hostname in (cloudflare.get("hostnames") or {}), f"hostname: {hostname} is not in the fleet shape's providers.cloudflare.hostnames")
    zones = [z for z in (cloudflare.get("zones") or {}) if hostname == z or hostname.endswith("." + z)]
    _need(len(zones) == 1, f"hostname: {hostname} ends with {len(zones)} declared zones; it must be one")
    return zones[0]


def resolve(declaration: dict, fleet: dict) -> dict:
    """The declaration joined with the fleet shape: one object the deploy, the smoke and the edge read."""
    providers = fleet.get("providers")
    _need(isinstance(providers, dict), "fleet shape: no providers")
    d = declaration
    server = _server(providers, d["server"])
    doppler = _doppler(providers, d["doppler"])
    cloudflare = providers.get("cloudflare")
    _need(isinstance(cloudflare, dict), "fleet shape: no providers.cloudflare")
    zone = _zone(cloudflare, d["hostname"])
    declared = set(doppler["required"]) | set(doppler["optional"])
    for name in (d["tunnelToken"], d["accessToken"]["id"], d["accessToken"]["secret"]):
        _need(name in declared, f"{name} is not declared in {d['doppler']}.configs.{DOPPLER_CONFIG}")
    env = d.get("env", {})
    clash = sorted(set(env) & declared)
    _need(not clash, f"env: {', '.join(clash)} also come from Doppler; a name has one source")
    access = {d["accessToken"]["id"], d["accessToken"]["secret"]}
    return {
        "server": server,
        "sshHost": _match(SSH_NAME, os.environ.get(server["sshHostVariable"] or "", "") or server["name"], "the server's ssh name"),
        "doppler": doppler,
        "hostname": d["hostname"],
        "zone": zone,
        "publicUrl": f"https://{d['hostname']}",
        "composeProject": d["composeProject"],
        "composeFiles": list(d["composeFiles"]),
        "copy": dict(d.get("copy", {})),
        "dirs": list(d.get("dirs", [])),
        "images": [dict(i) for i in d["images"]],
        "env": dict(env),
        # The host's environment file is complete when it holds these: Doppler's required names but the
        # machines' Access token (never written to the host), and the declaration's own names.
        "hostNames": sorted((set(doppler["required"]) - access) | set(env)),
        "ready": dict(d["ready"]),
        "closedPaths": list(d["closedPaths"]),
        "accessToken": dict(d["accessToken"]),
        "tunnelToken": d["tunnelToken"],
        "smoke": d["smoke"],
        "edge": {**{k: d["edge"][k] for k in sorted(EDGE_KEYS - {"ingress"})},
                 "ingress": validate_ingress(d["edge"]["ingress"])},
    }


def load(path: str = DEFAULT_DECLARATION, root: str = ".") -> dict:
    """Read, check and resolve the declaration at PATH under ROOT."""
    full = os.path.join(root, path)
    _need(os.path.isfile(full), f"no declaration at {path}")
    try:
        with open(full, encoding="utf-8") as fh:
            declaration = json.load(fh)
    except json.JSONDecodeError as exc:
        raise DeclarationError(f"{path}: not JSON ({exc})") from exc
    validate(declaration, root)
    with open(os.path.join(root, declaration["fleetShape"]), encoding="utf-8") as fh:
        try:
            fleet = json.load(fh)
        except json.JSONDecodeError as exc:
            raise DeclarationError(f"{declaration['fleetShape']}: not JSON ({exc})") from exc
    return resolve(declaration, fleet)


def edge_plan(resolved: dict) -> dict:
    """What sandbox-edge.mjs needs, and nothing secret."""
    return {**resolved["edge"], "zone": resolved["zone"], "hostname": resolved["hostname"],
            "probePath": resolved["ready"]["path"],
            "tokenNames": {"tunnel": resolved["tunnelToken"], "id": resolved["accessToken"]["id"],
                           "secret": resolved["accessToken"]["secret"]}}


def shell_assignments(resolved: dict, commit: str) -> str:
    """bash assignments, every value quoted. {tag} and {commit} in env values become the image tag and the commit."""
    _need(bool(re.match(r"^[0-9a-f]{40}$", commit)), f"commit: {commit!r} is not a full commit id")
    tag = f"sha-{commit}"
    q = shlex.quote
    arr = lambda items: "(" + " ".join(q(i) for i in items) + ")"
    env_lines = [f"{k}={v.replace('{tag}', tag).replace('{commit}', commit)}" for k, v in resolved["env"].items()]
    scalars = {
        "sk_server": resolved["server"]["name"], "sk_ssh_host": resolved["sshHost"],
        "sk_remote_dir": resolved["server"]["remoteDir"], "sk_doppler_project": resolved["doppler"]["project"],
        "sk_doppler_config": resolved["doppler"]["config"], "sk_public_url": resolved["publicUrl"],
        "sk_compose_project": resolved["composeProject"], "sk_tag": tag,
        "sk_ready_origin": resolved["ready"]["origin"], "sk_ready_path": resolved["ready"]["path"],
        "sk_access_id": resolved["accessToken"]["id"], "sk_access_secret": resolved["accessToken"]["secret"],
        "sk_smoke": resolved["smoke"],
    }
    arrays = {
        "sk_compose_files": resolved["composeFiles"],
        "sk_compose_names": [os.path.basename(f) for f in resolved["composeFiles"]],
        "sk_copy_from": list(resolved["copy"].keys()), "sk_copy_to": list(resolved["copy"].values()),
        "sk_dirs": resolved["dirs"],
        "sk_images": [f"{i['image']}:{tag}" for i in resolved["images"]],
        "sk_dockerfiles": [i["dockerfile"] for i in resolved["images"]],
        "sk_env_lines": env_lines, "sk_host_names": resolved["hostNames"],
        "sk_closed_paths": resolved["closedPaths"],
    }
    lines = [f"{k}={q(v)}" for k, v in scalars.items()] + [f"{k}={arr(v)}" for k, v in arrays.items()]
    return "\n".join(lines) + "\n"


def summary(resolved: dict) -> str:
    r = resolved
    rows = [
        ("server", f"{r['server']['name']} (ssh {r['sshHost']}, dir {r['server']['remoteDir']})"),
        ("doppler", f"{r['doppler']['project']}/{r['doppler']['config']}: {len(r['doppler']['required'])} required, "
                    f"{len(r['doppler']['optional'])} optional"),
        ("url", f"{r['publicUrl']} (zone {r['zone']})"),
        ("compose", f"project {r['composeProject']}: {' '.join(r['composeFiles'])}"),
        ("images", " ".join(i["image"] for i in r["images"])),
        ("copy", " ".join(f"{s}->{t}" for s, t in r["copy"].items()) or "none"),
        ("ready", f"{r['ready']['origin']} on the host, {r['ready']['path']} through the door"),
        ("closed", " ".join(r["closedPaths"])),
        ("host env", f"{len(r['hostNames'])} names must be present; {r['accessToken']['id']} and "
                     f"{r['accessToken']['secret']} stay off the host"),
        ("edge", f"app {r['edge']['accessApp']} (policies from {r['edge']['policySourceApp']}), probe app "
                 f"{r['edge']['probeApp']}, tunnel {r['edge']['tunnel']}, {len(r['edge']['ingress'])} ingress rules"),
        ("smoke", r["smoke"]),
    ]
    return "".join(f"{k:9} {v}\n" for k, v in rows)


def main(argv: list[str]) -> int:
    args = list(argv)
    path = os.environ.get("SANDBOX_KIT_DECLARATION") or DEFAULT_DECLARATION
    if "--declaration" in args:
        at = args.index("--declaration")
        _need(at + 1 < len(args), "--declaration needs a path")
        path = args[at + 1]
        del args[at:at + 2]
    if not args or args[0] not in ("check", "shell", "edge"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    resolved = load(path)
    if args[0] == "check":
        sys.stdout.write(summary(resolved))
    elif args[0] == "edge":
        print(json.dumps(edge_plan(resolved)))
    else:
        _need(len(args) == 2, "shell needs the commit")
        sys.stdout.write(shell_assignments(resolved, args[1]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except DeclarationError as exc:
        print(f"sandbox-kit: {exc}", file=sys.stderr)
        sys.exit(1)
