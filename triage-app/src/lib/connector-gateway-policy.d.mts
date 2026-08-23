export const CONNECTOR_GATEWAY_BASE: "/api/connector/v1";
export const MAX_CONNECTOR_REQUEST_BODY_BYTES: number;
export const MAX_CONNECTOR_RESPONSE_BYTES: number;

export type ConnectorPolicyError = {
  allowed: false;
  status: number;
  error: { code: string; message: string };
};

export type AllowedBridgeConnectorRequest = {
  allowed: true;
  target: "bridge";
  upstreamPath: string;
  acceptsBody: boolean;
};

export type AllowedFinanceInsightConnectorRequest = {
  allowed: true;
  target: "finance-insight";
  acceptsBody: false;
};

export type AllowedConnectorRequest =
  | AllowedBridgeConnectorRequest
  | AllowedFinanceInsightConnectorRequest;

export function authenticateConnectorRequest(
  authorization: string | null,
  configuredToken: string | undefined
): ConnectorPolicyError | { allowed: true; token: string };

export function isBrowserConnectorRequest(headers: Headers): boolean;

export function evaluateConnectorRequest(
  method: string,
  segments: string[],
  searchParams: URLSearchParams
): AllowedConnectorRequest | ConnectorPolicyError;

export function parseCategoryMutation(
  value: unknown
): ConnectorPolicyError | { allowed: true; body: string };

export function resolveConnectorBridgeUrl(
  rawUrl: string | undefined
): { configured: false } | { configured: true; baseUrl: URL };
