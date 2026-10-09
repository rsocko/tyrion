export interface AccountCatalogItem {
  accountRef: string;
  displayName: string;
  type: string;
  maskHint: string | null;
  isActive: boolean;
}

export class AccountCatalogError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AccountCatalogError";
  }
}

export async function loadAccountCatalog(): Promise<AccountCatalogItem[]> {
  let response: Response;
  try {
    response = await fetch("/api/account-catalog", {
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new AccountCatalogError(0, "Accounts could not be loaded");
  }
  if (!response.ok) {
    throw new AccountCatalogError(response.status, "Accounts could not be loaded");
  }
  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("accounts" in value) ||
    !Array.isArray(value.accounts)
  ) {
    throw new AccountCatalogError(502, "Accounts could not be loaded");
  }
  return value.accounts as AccountCatalogItem[];
}
