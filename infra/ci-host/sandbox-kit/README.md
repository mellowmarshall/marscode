# sandbox-kit

A private sandbox for a repo, from one declaration file. The
sandbox runs the repo's Docker Compose stack on one server. A Cloudflare Tunnel
carries its traffic, and a Cloudflare Access door stands in front of its
hostname. Nothing on the server listens on a public port.

The kit keeps a strict provision-before-expose order and safety checks.

## Commands

Run these inside the repo. The kit works from the repo's root.

| Command                      | What it does                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox-kit check`          | Checks the declaration against the fleet shape and prints what it resolved. No network.                                              |
| `sandbox-kit edge`           | Makes the Access door, the service token, the tunnel and the DNS record on Cloudflare. Run it once, and again when the edge changes. |
| `sandbox-kit deploy`         | Brings the sandbox up to the checkout's commit. A checkout with uncommitted changes is refused.                                      |
| `sandbox-kit smoke [COMMIT]` | Runs the repo's smoke against the real URL, with the machines' Access token from Doppler.                                            |

## Give a new repo a sandbox

1. **Declare the facts in the fleet shape.** The kit reads these from it and
   never copies them:
   - a server under a provider's `servers`, with `remoteDir` (the stack's
     directory on the server) and, if you like, `sshHostVariable` (the
     variable that holds its ssh name; without it, the server's key is the
     ssh name);
   - a Doppler provider (`kind: doppler`) with its `project` and
     `configs.sbx.required` and `configs.sbx.optional`. The kit deploys `sbx`
     only. The other environment name is `prd`;
   - the hostname under `providers.cloudflare.hostnames`, and its zone under
     `providers.cloudflare.zones`.
2. **Write `deploy/sandbox/sandbox.json`** (schema below). It holds only what
   the fleet shape does not.
3. **Write a compose override and a smoke test.** The override adds the
   `cloudflared` service, which reads the tunnel token from the environment,
   and sets `pull_policy: never` on the app images. The smoke reads
   `SANDBOX_PUBLIC_URL`, `SANDBOX_EXPECTED_COMMIT` and the two Access token
   names from its environment.
4. **Run `sandbox-kit edge` once.** Put its token file's lines into Doppler
   `<project>/sbx`, then delete the file.
5. **Run `sandbox-kit deploy`.**
6. **Add a site-probe line** for the hostname (it answers 302) in
   `site-probe/site-probe.targets`. With probe addresses, add one for the ready
   path too (it answers 200 to the probe boxes only).

## The declaration

```json
{
  "fleetShape": "deploy/fleet-shape.json",
  "server": "example-app-a",
  "doppler": "doppler-example-app",
  "hostname": "test.example.com",
  "composeProject": "example-app",
  "composeFiles": [
    "docker-compose.prod.yml",
    "scripts/drills/staging-compose.local-images.yml",
    "deploy/sandbox/compose.sandbox.yml"
  ],
  "copy": { "apps/api/scripts/backup-db.sh": "apps/api/scripts/backup-db.sh" },
  "dirs": ["legal"],
  "images": [{ "image": "ghcr.io/example/demo-api", "dockerfile": "apps/api/Dockerfile" }],
  "env": { "EXAMPLE_TAG": "{tag}", "EXAMPLE_API_DIGEST": "sha256:local" },
  "ready": { "origin": "http://127.0.0.1:4100/ready", "path": "/ready" },
  "closedPaths": ["/", "/health", "/v1/profiles"],
  "accessToken": { "id": "SANDBOX_ACCESS_CLIENT_ID", "secret": "SANDBOX_ACCESS_CLIENT_SECRET" },
  "tunnelToken": "CLOUDFLARE_TUNNEL_TOKEN",
  "smoke": "pnpm exec playwright test --config e2e/sandbox/playwright.config.ts",
  "edge": {
    "accessApp": "example-sandbox-web",
    "policySourceApp": "example-ops-console",
    "serviceToken": "example-sandbox-checks",
    "tunnel": "example-sandbox",
    "probeApp": "example-sandbox-ready",
    "ingress": [
      { "path": "^/(v1|ws|ready|health)(/|$)", "service": "http://api:4100" },
      { "service": "http://web:3123" }
    ]
  }
}
```

- `composeFiles` go side by side into `remoteDir`, so their names must differ.
  `copy` maps repo files to paths under `remoteDir`. `dirs` are made empty
  under `remoteDir` for the stack to mount. `copy`, `dirs` and `env` are
  optional.
- Each image is built as `<image>:sha-<commit>` with the build arguments
  `APP_VERSION`, `BUILD_COMMIT` and `BUILD_TIME`.
- `env` adds lines to the host's environment file. `{tag}` becomes
  `sha-<commit>` and `{commit}` the commit. A name in `env` must not also come
  from Doppler.
- `ready.origin` is read on the server; it must be a loopback URL whose JSON
  holds `"commit":"<sha>"`. `ready.path` is the same check through the door.
- `tunnelToken` and both `accessToken` names must be in the Doppler config.
- `edge.ingress` rules get the hostname added; a final 404 catches the rest.
  Only the last rule may have no path.

## Safety

- The deploy compares the names in Doppler with the fleet shape first. A name
  on one side only stops it before the server changes.
- Values go from Doppler to the server and are never printed, logged or put
  in an argument. The machines' Access token is never written to the server.
- The server's `.env` is replaced only when the new file holds every required
  name and ends with the kit's last line. Else the old file stays.
- Each `closedPaths` entry must answer 302 without a token, and the ready path
  403 or 302. Any other answer fails the deploy.
- `edge` refuses a source policy that bypasses the door or lets everyone in,
  before it writes anything. It makes the Access application before the DNS
  record. It deletes stale policies before it writes new ones. It writes a new
  service token's secret to the token file (mode 0600) at once.
- A failed deploy is fixed forward. Nothing is rolled back.

## Settings

| Variable                                          | Used by | Meaning                                                                                                    |
| ------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `SANDBOX_KIT_DECLARATION`                         | all     | Another declaration path.                                                                                  |
| `SANDBOX_KIT_READY_TIMEOUT`                       | deploy  | Seconds to wait for the ready URL on the server, default 300.                                              |
| `SANDBOX_KIT_POLL_SECONDS`                        | deploy  | Seconds between two ready checks, default 5.                                                               |
| `SANDBOX_KIT_SMOKE=0`                             | deploy  | Skip the smoke.                                                                                            |
| `SANDBOX_KIT_EDGE_CONFIRM=provision-sandbox-edge` | edge    | Required: says you mean to change Cloudflare.                                                              |
| `SANDBOX_KIT_CF_PROVISION_API_TOKEN`              | edge    | Required: edits Access and tunnels of the account.                                                         |
| `SANDBOX_KIT_CF_DNS_API_TOKEN`                    | edge    | Edits the zone's DNS, when the first token cannot.                                                         |
| `SANDBOX_KIT_TOKEN_FILE`                          | edge    | Where the tunnel token and a new service token go, mode 0600.                                              |
| `SANDBOX_KIT_PROBE_IPS`                           | edge    | Probe box addresses, single hosts, comma separated. `none` deletes the probe application. Unset leaves it. |

## Install and test

`sandbox-kit/install.sh [BIN_DIR]` (default `~/.local/bin`) copies the kit to
`~/.local/lib/sandbox-kit` and links `sandbox-kit` to it. It needs bash,
python3, node, git, ssh, scp, docker, curl and the doppler CLI.

The tests need no network: `python3 test_sandbox_declaration.py`,
`python3 test_sandbox_deploy.py` (fake ssh, scp, docker, doppler and curl) and
`bash sandbox-edge.test.sh` (a fake Cloudflare).
