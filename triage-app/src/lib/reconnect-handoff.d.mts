export type ReconnectViewState =
  | "checking"
  | "unavailable"
  | "unauthenticated"
  | "connected"
  | "expired"
  | "degraded";

export type ReconnectPhase =
  | "checking"
  | "unavailable"
  | "authentication-required"
  | "sync-required"
  | "recovered";

export type MissionControlHandoff =
  | { available: false }
  | { available: true; returnUrl: string };

export function isMissionControlRecoveryEntry(search: string): boolean;
export function reconnectPhase(
  viewState: ReconnectViewState,
  syncComplete: boolean
): ReconnectPhase;
export function resolveMissionControlHandoff(
  rawUrl: string | undefined,
  rawAllowedOrigins: string | undefined
): MissionControlHandoff;
