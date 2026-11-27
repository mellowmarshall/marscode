"""A repo fixture with a sandbox declaration and fleet shape for sandbox-kit tests."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


def fleet_shape(remote_dir: str = "/opt/demo") -> dict:
    return {
        "providers": {
            "hetzner": {"kind": "hetzner", "servers": {
                "demo-app-a": {"status": "provisioned", "remoteDir": remote_dir, "sshHostVariable": "DEMO_SANDBOX_HOST"}}},
            "cloudflare": {
                "zones": {"demo.example": {"registrar": "Cloudflare"}},
                "hostnames": {"test.demo.example": {"target": "web"}, "demo.example": {"target": "proxy"}}},
            "doppler-demo": {"kind": "doppler", "project": "demo", "configs": {
                "sbx": {"required": ["CLOUDFLARE_TUNNEL_TOKEN", "SANDBOX_ACCESS_CLIENT_ID", "SANDBOX_ACCESS_CLIENT_SECRET",
                                     "SESSION_SECRET", "POSTGRES_PASSWORD"],
                        "optional": ["SENTRY_DSN"]},
                "prd": {}}},
        }
    }


def declaration() -> dict:
    return {
        "fleetShape": "deploy/fleet-shape.json",
        "server": "demo-app-a",
        "doppler": "doppler-demo",
        "hostname": "test.demo.example",
        "composeProject": "demo",
        "composeFiles": ["docker-compose.prod.yml", "deploy/sandbox/compose.sandbox.yml"],
        "copy": {"apps/api/scripts/backup-db.sh": "apps/api/scripts/backup-db.sh"},
        "dirs": ["legal"],
        "images": [{"image": "ghcr.io/example/demo-api", "dockerfile": "apps/api/Dockerfile"},
                   {"image": "ghcr.io/example/demo-web", "dockerfile": "apps/web/Dockerfile"}],
        "env": {"DEMO_TAG": "{tag}", "DEMO_API_DIGEST": "sha256:local"},
        "ready": {"origin": "http://127.0.0.1:4100/ready", "path": "/ready"},
        "closedPaths": ["/", "/health", "/v1/profiles"],
        "accessToken": {"id": "SANDBOX_ACCESS_CLIENT_ID", "secret": "SANDBOX_ACCESS_CLIENT_SECRET"},
        "tunnelToken": "CLOUDFLARE_TUNNEL_TOKEN",
        "smoke": "pnpm exec playwright test --config e2e/sandbox/playwright.config.ts",
        "edge": {
            "accessApp": "demo-sandbox-web", "policySourceApp": "ops-console", "serviceToken": "demo-sandbox-checks",
            "tunnel": "demo-sandbox", "probeApp": "demo-sandbox-ready",
            "ingress": [{"path": "^/(v1|ws|ready|health)(/|$)", "service": "http://api:4100"},
                        {"path": "^/media(/|$)", "service": "http_status:404"},
                        {"service": "http://web:3123"}],
        },
    }


REPO_FILES = ("docker-compose.prod.yml", "deploy/sandbox/compose.sandbox.yml", "apps/api/scripts/backup-db.sh",
              "apps/api/Dockerfile", "apps/web/Dockerfile")


def write_repo(root: Path, decl: dict | None = None, fleet: dict | None = None, commit: bool = False) -> Path:
    """The repo at ROOT, a git repo that tracks its declared files, the declaration and the fleet shape. With COMMIT, one commit."""
    for rel in REPO_FILES:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"# {rel}\n")
    (root / "deploy/sandbox/sandbox.json").write_text(json.dumps(declaration() if decl is None else decl, indent=2))
    (root / "deploy/fleet-shape.json").write_text(json.dumps(fleet_shape() if fleet is None else fleet, indent=2))
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.test",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.test", "GIT_CONFIG_GLOBAL": os.devnull}
    steps = [["init", "-q", "-b", "main"], ["add", "-A"]] + ([["commit", "-q", "--no-verify", "-m", "fixture"]] if commit else [])
    for args in steps:
        subprocess.run(["git", "-C", str(root), *args], check=True, env=env)
    return root
