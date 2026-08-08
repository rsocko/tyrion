const routePolicy = Object.freeze({
  health: { method: "GET", requiresToken: false },
  "auth/status": { method: "GET", requiresToken: true },
  "auth/login": { method: "POST", requiresToken: true },
  "auth/login-with-cookies": { method: "POST", requiresToken: true },
  "auth/logout": { method: "POST", requiresToken: true },
  sync: { method: "POST", requiresToken: true },
});

const error = (status, code, message) => ({
  allowed: false,
  status,
  error: { code, message },
});

export function evaluateBridgeRequest(method, segments, searchParams) {
  const path = Array.isArray(segments) ? segments.join("/") : "";
  const policy = routePolicy[path];
  if (!policy) {
    return error(
      404,
      "bridge_route_not_available",
      "This bridge operation is not available through the operational UI proxy"
    );
  }
  if (method !== policy.method) {
    return error(405, "method_not_allowed", "Method not allowed for this bridge operation");
  }

  const keys = [...new Set(searchParams.keys())];
  if (path !== "sync" && keys.length > 0) {
    return error(422, "invalid_query", "Query parameters are not accepted for this bridge operation");
  }

  let query = "";
  if (path === "sync") {
    if (keys.some((key) => key !== "days") || searchParams.getAll("days").length > 1) {
      return error(422, "invalid_query", "Only one days parameter is accepted");
    }
    const rawDays = searchParams.get("days") || "30";
    if (!/^[0-9]+$/.test(rawDays)) {
      return error(422, "invalid_query", "Sync days must be an integer from 1 through 90");
    }
    const days = Number(rawDays);
    if (days < 1 || days > 90) {
      return error(422, "invalid_query", "Sync days must be an integer from 1 through 90");
    }
    query = `?days=${days}`;
  }

  return {
    allowed: true,
    requiresToken: policy.requiresToken,
    upstreamPath: `/${path}${query}`,
  };
}

export function resolveBridgeConfiguration(rawUrl, token, requiresToken) {
  let baseUrl;
  try {
    baseUrl = new URL(rawUrl || "http://127.0.0.1:8100");
  } catch {
    return { configured: false };
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.pathname !== "/" && baseUrl.pathname !== "")
  ) {
    return { configured: false };
  }
  if (requiresToken && !token) {
    return { configured: false };
  }
  return {
    configured: true,
    baseUrl,
    token: requiresToken ? token : undefined,
  };
}
