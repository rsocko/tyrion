export type AllowedBridgeRequest = {
  allowed: true;
  requiresToken: boolean;
  upstreamPath: string;
};

export type RejectedBridgeRequest = {
  allowed: false;
  status: number;
  error: { code: string; message: string };
};

export function evaluateBridgeRequest(
  method: string,
  segments: string[],
  searchParams: URLSearchParams
): AllowedBridgeRequest | RejectedBridgeRequest;

export function resolveBridgeConfiguration(
  rawUrl: string | undefined,
  token: string | undefined,
  requiresToken: boolean
):
  | { configured: false }
  | { configured: true; baseUrl: URL; token: string | undefined };
