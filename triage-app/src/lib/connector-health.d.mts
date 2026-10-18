export const CONNECTOR_HEALTH_RESPONSE_BYTES: number;
export const CONNECTOR_HEALTH_TIMEOUT_MS: number;
export const MONARCH_CONTRACT_VERSION: "1.1";
export const SUPPORTED_MONARCH_CONTRACT_VERSIONS: Set<string>;

export type ComposedHealth = {
  ok: true;
  body: {
    contractVersion: "1.1";
    status: "ok" | "degraded";
    mode: "demo" | "live";
    reachable: boolean;
    authenticated: boolean;
    authState: "unauthenticated" | "connected" | "expired" | "degraded";
  };
};

export type ComposedHealthError = {
  ok: false;
  status: number;
  error: { code: string; message: string };
};

export function composeConnectorHealth(options: {
  baseUrl: URL;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ComposedHealth | ComposedHealthError>;
