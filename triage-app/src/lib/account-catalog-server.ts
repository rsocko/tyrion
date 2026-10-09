const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_ACCOUNTS = 1_000;
const TIMEOUT_MS = 10_000;
const ACCOUNT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface AccountCatalogEntry {
  accountRef: string;
  displayName: string;
  type: string;
  maskHint: string | null;
  isActive: boolean;
}

export class AccountCatalogServerError extends Error {
  constructor(readonly code: "unavailable" | "invalid") {
    super("Account catalog is unavailable");
    this.name = "AccountCatalogServerError";
  }
}

function bridgeConfiguration() {
  let baseUrl: URL;
  try {
    baseUrl = new URL(process.env.BRIDGE_URL || "http://127.0.0.1:8100");
  } catch {
    return null;
  }
  const token = process.env.BRIDGE_API_TOKEN;
  if (
    !token ||
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.pathname !== "/" && baseUrl.pathname !== "")
  ) {
    return null;
  }
  return { baseUrl, token };
}

function text(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > maximum
  ) {
    throw new AccountCatalogServerError("invalid");
  }
  return value;
}

function parseCatalog(payload: unknown): AccountCatalogEntry[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AccountCatalogServerError("invalid");
  }
  const accounts = (payload as Record<string, unknown>).accounts;
  if (!Array.isArray(accounts) || accounts.length > MAX_ACCOUNTS) {
    throw new AccountCatalogServerError("invalid");
  }
  const references = new Set<string>();
  return accounts.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AccountCatalogServerError("invalid");
    }
    const account = value as Record<string, unknown>;
    const accountRef = text(account.id, "account id", 128);
    if (!ACCOUNT_REF.test(accountRef) || references.has(accountRef)) {
      throw new AccountCatalogServerError("invalid");
    }
    references.add(accountRef);
    const mask =
      account.mask === null || account.mask === undefined
        ? null
        : text(account.mask, "account mask", 32);
    const safeMask = mask?.replace(/\D/g, "").slice(-4) || "";
    if (typeof account.isActive !== "boolean") {
      throw new AccountCatalogServerError("invalid");
    }
    return {
      accountRef,
      displayName: text(account.displayName, "display name", 160),
      type: text(account.type, "account type", 80),
      maskHint: safeMask ? `Ending in ${safeMask}` : null,
      isActive: account.isActive,
    };
  });
}

export async function loadAccountCatalogServer(): Promise<AccountCatalogEntry[]> {
  const configuration = bridgeConfiguration();
  if (!configuration) throw new AccountCatalogServerError("unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/accounts", configuration.baseUrl), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.token}`,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    ) {
      throw new AccountCatalogServerError("unavailable");
    }
    const declaredLength = Number(response.headers.get("content-length") || "0");
    if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_RESPONSE_BYTES) {
      throw new AccountCatalogServerError("invalid");
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new AccountCatalogServerError("invalid");
    }
    return parseCatalog(JSON.parse(new TextDecoder().decode(body)));
  } catch (error) {
    if (error instanceof AccountCatalogServerError) throw error;
    throw new AccountCatalogServerError("unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
