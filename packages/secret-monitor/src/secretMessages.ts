/** Method calls on these interfaces are what the monitor observes. */
const SECRET_INTERFACES = [
  "org.freedesktop.Secret.Service",
  "org.freedesktop.Secret.Collection",
  "org.freedesktop.Secret.Item",
  "org.freedesktop.Secret.Session",
] as const;

/**
 * Session plumbing every client performs. Logging it buries the real events at several lines per
 * `op` call. SearchItems is kept: what a caller went looking for has audit value even when it
 * never reads the secret.
 */
const ROUTINE_MEMBERS: ReadonlySet<string> = new Set(["OpenSession", "Close"]);

/** `BecomeMonitor` match rules: method calls on each Secret Service interface. */
export const monitorMatchRules = (): ReadonlyArray<string> =>
  SECRET_INTERFACES.map((iface) => `type='method_call',interface='${iface}'`);

/** The fields of a monitored D-Bus message that classification reads. */
export interface ObservedMessage {
  readonly isMethodCall: boolean;
  readonly interface: string | undefined;
  readonly member: string | undefined;
  readonly sender: string | undefined;
  readonly body: ReadonlyArray<unknown>;
}

export type SecretCall =
  /** Session plumbing: never logged, but its sender is resolved while it is still alive. */
  | { readonly kind: "routine"; readonly sender: string | undefined }
  | {
      readonly kind: "audit";
      readonly sender: string | undefined;
      readonly interface: string;
      readonly member: string;
    }
  | {
      readonly kind: "getSecrets";
      readonly sender: string | undefined;
      readonly interface: string;
      readonly paths: ReadonlyArray<string>;
    };

const isSecretInterface = (iface: string | undefined): iface is string =>
  iface !== undefined && (SECRET_INTERFACES as ReadonlyArray<string>).includes(iface);

/** GetSecrets takes the item object paths as its first argument (`ao`). */
const itemPaths = (body: ReadonlyArray<unknown>): ReadonlyArray<string> => {
  const first = body[0];
  if (!Array.isArray(first)) return [];
  return first.filter((path): path is string => typeof path === "string");
};

/**
 * Classifies one monitored message. Returns null for anything that is not a Secret Service
 * method call, and for calls made by the monitor's own connections.
 */
export const classifySecretMessage = (
  message: ObservedMessage,
  ownNames: ReadonlySet<string>,
): SecretCall | null => {
  if (!message.isMethodCall || !isSecretInterface(message.interface)) return null;
  const { sender, member } = message;
  if (sender !== undefined && ownNames.has(sender)) return null;
  if (member === "GetSecrets") {
    return {
      kind: "getSecrets",
      sender,
      interface: message.interface,
      paths: itemPaths(message.body),
    };
  }
  if (member === undefined || ROUTINE_MEMBERS.has(member)) return { kind: "routine", sender };
  return { kind: "audit", sender, interface: message.interface, member };
};

/** A read is quiet only when every item it reads is a quiet item. */
export const isQuietRead = (
  paths: ReadonlyArray<string>,
  quietPaths: ReadonlySet<string>,
): boolean => paths.length > 0 && paths.every((path) => quietPaths.has(path));

/** SearchItems replies `(ao unlocked, ao locked)`; both name matching items. */
export const parseSearchItemsReply = (body: ReadonlyArray<unknown>): ReadonlySet<string> => {
  const paths = new Set<string>();
  for (const part of body.slice(0, 2)) {
    if (!Array.isArray(part)) continue;
    for (const path of part) if (typeof path === "string") paths.add(path);
  }
  return paths;
};
