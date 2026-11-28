// The one allowlist a declared step's environment is built from, local and remote.

/**
 * Worker variables every step may read: the shell, the locale, the temp directory, trust stores,
 * and toolchain homes. Proxies stay out: their URLs can carry credentials.
 */
const STEP_ENV_NAMES: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "XDG_CACHE_HOME",
  "COREPACK_HOME",
  "JAVA_HOME",
  "GOPATH",
  "GOCACHE",
  "GOMODCACHE",
  "RUSTC_WRAPPER",
  "SCCACHE_DIR",
  "SCCACHE_CACHE_SIZE",
  "SCCACHE_IDLE_TIMEOUT",
  "TURBO_CACHE_DIR",
  "UV_CACHE_DIR",
];

/** Toolchain and cache families; a name in one still drops when it looks like a credential. */
const STEP_ENV_PREFIXES: ReadonlyArray<string> = [
  "LC_",
  "CARGO_",
  "RUSTUP_",
  "PNPM_",
  "npm_config_",
];

/**
 * Words that mark a credential inside an allowed family (`CARGO_REGISTRY_TOKEN`,
 * `npm_config_//registry/:_authToken`, connection strings, and proxies such as
 * `npm_config_https_proxy`, whose URL can hold a user and password). Matched without case.
 */
const CREDENTIAL_WORDS: ReadonlyArray<string> = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "auth",
  "key",
  "proxy",
  "connection",
];

/**
 * The forge's own credentials, for the base-owned steps that read or write the forge: the body
 * check (`gh pr list`), `ship_merge` (`gh pr merge`), and the post-merge sync (`git fetch`). `gh` keeps its token in the desktop
 * keyring here, so the keyring's session bus is part of it. No install or CI step gets these.
 */
const FORGE_ENV_NAMES: ReadonlyArray<string> = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
];

/**
 * How the docker CLI finds its engine, for the shell that starts a job's services only: no step
 * gets them. Unset, the CLI uses its default socket (/var/run/docker.sock, or its context).
 */
const DOCKER_ENV_NAMES: ReadonlyArray<string> = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
];

interface StepEnvOptions {
  readonly forge?: boolean | undefined;
  readonly docker?: boolean | undefined;
}

function looksLikeCredential(name: string): boolean {
  const lower = name.toLowerCase();
  return CREDENTIAL_WORDS.some((word) => lower.includes(word));
}

function isAllowedStepEnvName(name: string, options: StepEnvOptions = {}): boolean {
  if (STEP_ENV_NAMES.includes(name)) return true;
  if (options.forge && FORGE_ENV_NAMES.includes(name)) return true;
  if (options.docker && DOCKER_ENV_NAMES.includes(name)) return true;
  return STEP_ENV_PREFIXES.some((p) => name.startsWith(p)) && !looksLikeCredential(name);
}

/**
 * The worker variables a local step starts from. The runner adds the toolchain's own values,
 * the `SHIP_QUEUE_*` context, and the declared secrets after this; nothing else reaches a step.
 */
export function allowlistedStepBaseEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  options: StepEnvOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value !== undefined && isAllowedStepEnvName(name, options)) out[name] = value;
  }
  return out;
}

/** A case pattern matching `word` in any letter case (bash 3.2 on macOS has no `${v,,}`). */
function anyCase(word: string): string {
  return [...word].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join("");
}

/**
 * Bash that unsets every exported variable outside the allowlist, for the first line of a remote
 * step, before the toolchain setup, the `SHIP_QUEUE_*` exports, and the stdin secret reader add
 * theirs. Shell bookkeeping (`PWD`, `OLDPWD`, `SHLVL`, `_`) stays, and with `docker` the names
 * the docker CLI reads (the services shell). Holds no single quote.
 */
export function buildRemoteEnvAllowlistScript(options: StepEnvOptions = {}): string {
  const docker = options.docker ? DOCKER_ENV_NAMES : [];
  const keep = [...STEP_ENV_NAMES, ...docker, "PWD", "OLDPWD", "SHLVL", "_"].join("|");
  const families = STEP_ENV_PREFIXES.map((p) => `${p}*`).join("|");
  const creds = CREDENTIAL_WORDS.map((w) => `*${anyCase(w)}*`).join("|");
  return [
    `for sq_v in $(compgen -e); do case "$sq_v" in ${keep}) ;; ${families}) case "$sq_v" in ${creds}) unset "$sq_v" 2>/dev/null ;; esac ;; *) unset "$sq_v" 2>/dev/null ;; esac; done`,
    `unset sq_v`,
  ].join("; ");
}
