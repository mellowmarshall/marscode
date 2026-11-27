/**
 * PLAYBOOK §16 public-repo hygiene catalog: the closed lists of named failure classes, scanned
 * surfaces, and defense layers. The scanner reports by these ids and the playbook's evidence
 * validator requires every one of them in a receipt.
 */
export const HYGIENE_CLASSES = [
  "host-names",
  "ssh-targets",
  "home-paths",
  "data-layout",
  "private-repos",
  "owner-identity-in-code",
  "personal-domain",
  "commit-identity",
  "agent-session-ids",
  "network-identity",
  "operational-telemetry",
  "local-only-files",
] as const;

export const HYGIENE_SURFACES = ["tree", "history", "commit-metadata", "github-text"] as const;

export const HYGIENE_LAYERS = ["pre-commit", "ship-gate", "ci", "text-guard"] as const;

export type HygieneClass = (typeof HYGIENE_CLASSES)[number];
export type HygieneSurface = (typeof HYGIENE_SURFACES)[number];
export type HygieneLayer = (typeof HYGIENE_LAYERS)[number];
