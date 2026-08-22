const MISSION_CONTROL_SOURCE = "mission-control";

export function isMissionControlRecoveryEntry(search) {
  const parameters = new URLSearchParams(search);
  return (
    [...parameters.keys()].every((key) => key === "source") &&
    parameters.getAll("source").length === 1 &&
    parameters.get("source") === MISSION_CONTROL_SOURCE
  );
}

export function reconnectPhase(viewState, syncComplete) {
  if (viewState === "checking") return "checking";
  if (viewState === "unavailable") return "unavailable";
  if (viewState !== "connected") return "authentication-required";
  return syncComplete ? "recovered" : "sync-required";
}

export function resolveMissionControlHandoff(rawUrl, rawAllowedOrigins) {
  if (!rawUrl || !rawAllowedOrigins) return { available: false };

  const allowedOrigins = parseAllowedOrigins(rawAllowedOrigins);
  if (!allowedOrigins) return { available: false };

  let returnUrl;
  try {
    returnUrl = new URL(rawUrl);
  } catch {
    return { available: false };
  }
  if (
    returnUrl.protocol !== "https:" ||
    returnUrl.username ||
    returnUrl.password ||
    returnUrl.search ||
    returnUrl.hash ||
    !allowedOrigins.has(returnUrl.origin)
  ) {
    return { available: false };
  }
  return { available: true, returnUrl: returnUrl.toString() };
}

function parseAllowedOrigins(rawAllowedOrigins) {
  const origins = rawAllowedOrigins.split(",").map((value) => value.trim());
  if (origins.length === 0 || origins.some((value) => !value)) return null;

  const parsed = new Set();
  for (const value of origins) {
    let origin;
    try {
      origin = new URL(value);
    } catch {
      return null;
    }
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.origin !== value.replace(/\/$/, "")
    ) {
      return null;
    }
    parsed.add(origin.origin);
  }
  return parsed;
}
