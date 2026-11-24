import * as Schema from "effect/Schema";
import { readLocalStorageValue, useLocalStorage } from "../hooks/useLocalStorage";

export const GuardNotificationModeSchema = Schema.Literals(["follow", "always", "silent", "off"]);
export type GuardNotificationMode = typeof GuardNotificationModeSchema.Type;

export const CompletedShipLingerMinutesSchema = Schema.Literals(["0", "5", "15"]);
export type CompletedShipLingerMinutes = typeof CompletedShipLingerMinutesSchema.Type;

const DefaultFleetConsoleTabSchema = Schema.Literals(["machines", "reaper"]);
export type DefaultFleetConsoleTab = typeof DefaultFleetConsoleTabSchema.Type;

export const DEFAULT_GUARD_NOTIFICATION_MODE: GuardNotificationMode = "follow";
export const DEFAULT_SHOW_SIDEBAR_JOB_STATUS = true;
export const DEFAULT_COMPLETED_SHIP_LINGER_MINUTES: CompletedShipLingerMinutes = "5";
export const DEFAULT_FLEET_CONSOLE_TAB: DefaultFleetConsoleTab = "machines";

const GUARD_NOTIFICATION_MODE_KEY = "t3code:devtools:guard-notification-mode:v1";
const SHOW_SIDEBAR_JOB_STATUS_KEY = "t3code:devtools:show-sidebar-job-status:v1";
const COMPLETED_SHIP_LINGER_KEY = "t3code:devtools:completed-ship-linger-min:v1";
const DEFAULT_FLEET_CONSOLE_TAB_KEY = "t3code:devtools:default-fleet-tab:v1";

export function readGuardNotificationMode(): GuardNotificationMode {
  return readLocalStorageValue(
    GUARD_NOTIFICATION_MODE_KEY,
    DEFAULT_GUARD_NOTIFICATION_MODE,
    GuardNotificationModeSchema,
  );
}

export function useGuardNotificationMode() {
  return useLocalStorage(
    GUARD_NOTIFICATION_MODE_KEY,
    DEFAULT_GUARD_NOTIFICATION_MODE,
    GuardNotificationModeSchema,
  );
}

export function useShowSidebarJobStatus() {
  return useLocalStorage(
    SHOW_SIDEBAR_JOB_STATUS_KEY,
    DEFAULT_SHOW_SIDEBAR_JOB_STATUS,
    Schema.Boolean,
  );
}

export function useCompletedShipLingerMinutes() {
  return useLocalStorage(
    COMPLETED_SHIP_LINGER_KEY,
    DEFAULT_COMPLETED_SHIP_LINGER_MINUTES,
    CompletedShipLingerMinutesSchema,
  );
}

export function readDefaultFleetConsoleTab(): DefaultFleetConsoleTab {
  return readLocalStorageValue(
    DEFAULT_FLEET_CONSOLE_TAB_KEY,
    DEFAULT_FLEET_CONSOLE_TAB,
    DefaultFleetConsoleTabSchema,
  );
}

export function useDefaultFleetConsoleTab() {
  return useLocalStorage(
    DEFAULT_FLEET_CONSOLE_TAB_KEY,
    DEFAULT_FLEET_CONSOLE_TAB,
    DefaultFleetConsoleTabSchema,
  );
}
