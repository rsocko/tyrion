import {
  defaultBillAmountToleranceMinorV1,
  parseBillMatchRequestV1,
  parseBillMatchRequestV2,
  rankBillMatchCandidatesV1,
  rankBillMatchCandidatesV2,
  type BillMatchTransactionV2,
} from "@rsocko/tyrion-finance-insights";
import { FinanceInsightContractValidationError } from "@rsocko/tyrion-finance-insights";
import { NextResponse } from "next/server";
import { financeInsightJson } from "@/lib/finance-insight-http";
import { getFinanceInsightRuntime } from "@/lib/finance-insight-runtime";

const BRIDGE_TIMEOUT_MS = 30_000;
const MAX_BRIDGE_RESPONSE_BYTES = 512 * 1024;
const MAX_ELIGIBLE_ACCOUNTS = 20;
const ACCOUNT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface BridgeTransactionSource {
  transactions: BillMatchTransactionV2[];
  incomplete: boolean;
  sourceAsOf: string;
}

export async function matchBillToTransactionsV1(
  body: unknown,
  bridgeBaseUrl: URL,
  bridgeToken: string,
  eligibleAccountConfiguration?: string
): Promise<NextResponse> {
  if (plainObject(body) && body.contractVersion === "2.0") {
    return matchBillToTransactionsV2(
      body,
      bridgeBaseUrl,
      bridgeToken,
      eligibleAccountConfiguration
    );
  }
  return matchBillToTransactionsLegacyV1(body, bridgeBaseUrl, bridgeToken);
}

async function matchBillToTransactionsLegacyV1(
  body: unknown,
  bridgeBaseUrl: URL,
  bridgeToken: string
): Promise<NextResponse> {
  const input = parseBillMatchRequestV1(body);
  const householdCurrency = await readHouseholdCurrency();
  if (householdCurrency instanceof NextResponse) return householdCurrency;
  if (input.currency !== householdCurrency) return currencyMismatch();

  const tolerance =
    input.amountToleranceMinor ??
    defaultBillAmountToleranceMinorV1(input.amountMinor);
  const query = createTransactionQuery(
    input.dueDate,
    input.dateWindowDays,
    input.amountMinor,
    tolerance,
    input.accountRef
  );
  const source = await fetchBridgeTransactions(
    bridgeBaseUrl,
    bridgeToken,
    query,
    false
  );
  if (source instanceof NextResponse) return source;
  if (source.incomplete) return queryTooBroad();
  return financeInsightJson(
    rankBillMatchCandidatesV1(input, source.transactions)
  );
}

async function matchBillToTransactionsV2(
  body: unknown,
  bridgeBaseUrl: URL,
  bridgeToken: string,
  eligibleAccountConfiguration?: string
): Promise<NextResponse> {
  const input = parseBillMatchRequestV2(body);
  const householdCurrency = await readHouseholdCurrency();
  if (householdCurrency instanceof NextResponse) return householdCurrency;
  if (input.currency !== householdCurrency) return currencyMismatch();

  const eligibleAccounts = parseEligibleAccounts(eligibleAccountConfiguration);
  if (!eligibleAccounts) {
    return gatewayError(
      503,
      "bill_match_eligible_accounts_unavailable",
      "Bill matching eligible accounts are unavailable"
    );
  }
  const anchorDate = input.dueDate ?? input.billDate;
  if (!anchorDate) {
    throw new FinanceInsightContractValidationError(
      "Invalid bill match request v2: dueDate or billDate is required"
    );
  }
  const tolerance =
    input.amountToleranceMinor ??
    defaultBillAmountToleranceMinorV1(input.expectedAmountMinor);
  const sources = await Promise.all(
    eligibleAccounts.map((accountRef) =>
      fetchBridgeTransactions(
        bridgeBaseUrl,
        bridgeToken,
        createTransactionQuery(
          anchorDate,
          input.dateWindowDays,
          input.expectedAmountMinor,
          tolerance,
          accountRef
        ),
        true
      )
    )
  );
  const resolvedSources: BridgeTransactionSource[] = [];
  for (const source of sources) {
    if (source instanceof NextResponse) return source;
    resolvedSources.push(source);
  }
  if (resolvedSources.some((source) => source.incomplete)) {
    return queryTooBroad();
  }

  const transactionsByRef = new Map<string, BillMatchTransactionV2>();
  for (let index = 0; index < resolvedSources.length; index += 1) {
    const expectedAccountRef = eligibleAccounts[index];
    for (const transaction of resolvedSources[index].transactions) {
      if (transaction.accountRef !== expectedAccountRef) {
        return invalidSourceResponse();
      }
      const previous = transactionsByRef.get(transaction.transactionRef);
      if (previous && JSON.stringify(previous) !== JSON.stringify(transaction)) {
        return invalidSourceResponse();
      }
      transactionsByRef.set(transaction.transactionRef, transaction);
    }
  }
  const transactions = [...transactionsByRef.values()];
  const sourceAsOf = resolvedSources
    .map((source) => source.sourceAsOf)
    .reduce((oldest, candidate) =>
      Date.parse(candidate) < Date.parse(oldest) ? candidate : oldest
    );
  if (!sourceAsOf) return invalidSourceResponse();

  return financeInsightJson(
    rankBillMatchCandidatesV2(input, transactions, {
      anchorDate,
      windowStart: shiftDate(anchorDate, -input.dateWindowDays),
      windowEnd: shiftDate(anchorDate, input.dateWindowDays),
      dateWindowDays: input.dateWindowDays,
      sourceAsOf,
      searchedAt: new Date().toISOString(),
      eligibleAccountCount: eligibleAccounts.length,
      candidatePoolSize: transactions.length,
    })
  );
}

async function readHouseholdCurrency(): Promise<string | NextResponse> {
  try {
    const runtime = await getFinanceInsightRuntime();
    const policy = await runtime.store.policies.current();
    if (policy) return policy.currency;
  } catch {
    // Return the stable configuration error below.
  }
  return gatewayError(
    503,
    "bill_match_configuration_unavailable",
    "Bill matching configuration is unavailable"
  );
}

function parseEligibleAccounts(value: string | undefined): string[] | null {
  if (!value) return null;
  const accounts = value.split(",").map((account) => account.trim());
  if (
    accounts.length < 1 ||
    accounts.length > MAX_ELIGIBLE_ACCOUNTS ||
    accounts.some((account) => !ACCOUNT_REF.test(account)) ||
    new Set(accounts).size !== accounts.length
  ) {
    return null;
  }
  return accounts;
}

function createTransactionQuery(
  anchorDate: string,
  dateWindowDays: number,
  amountMinor: number,
  tolerance: number,
  accountRef?: string
): URLSearchParams {
  const query = new URLSearchParams({
    start_date: shiftDate(anchorDate, -dateWindowDays),
    end_date: shiftDate(anchorDate, dateWindowDays),
    min_amount: minorToMoney(-(amountMinor + tolerance)),
    max_amount: minorToMoney(-Math.max(0, amountMinor - tolerance)),
    limit: "100",
  });
  if (accountRef) query.set("account_id", accountRef);
  return query;
}

async function fetchBridgeTransactions(
  bridgeBaseUrl: URL,
  bridgeToken: string,
  query: URLSearchParams,
  requireDecisionGradeFields: boolean
): Promise<BridgeTransactionSource | NextResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const headers = new Headers({ Accept: "application/json" });
    headers.set("Authorization", ["Bearer", bridgeToken].join(" "));
    const response = await fetch(
      new URL(`/transactions?${query.toString()}`, bridgeBaseUrl),
      {
        method: "GET",
        headers,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return sourceUnavailable();
    }
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json")
    ) {
      await response.body?.cancel().catch(() => undefined);
      return invalidSourceResponse();
    }
    const payload = await readBoundedJson(response);
    if (payload === null) return invalidSourceResponse();
    try {
      return parseBridgeTransactions(payload, requireDecisionGradeFields);
    } catch {
      return invalidSourceResponse();
    }
  } catch (error) {
    if (error instanceof FinanceInsightContractValidationError) throw error;
    return sourceUnavailable();
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedJson(response: Response): Promise<unknown | null> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!Number.isSafeInteger(Number(declared)) ||
      Number(declared) < 0 ||
      Number(declared) > MAX_BRIDGE_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BRIDGE_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function parseBridgeTransactions(
  value: unknown,
  requireDecisionGradeFields: boolean
): BridgeTransactionSource {
  const normalizedSourceAsOf =
    plainObject(value) && plainObject(value.provenance)
      ? normalizeUtcTimestamp(value.provenance.fetchedAt)
      : "";
  if (
    !plainObject(value) ||
    value.contractVersion !== "1.0" ||
    (requireDecisionGradeFields && !normalizedSourceAsOf)
  ) {
    throw new Error("invalid bridge transaction response");
  }
  if (!Array.isArray(value.transactions) || value.transactions.length > 100) {
    throw new Error("invalid bridge transaction response");
  }
  if (
    !Number.isSafeInteger(value.total) ||
    (value.total as number) < value.transactions.length ||
    !plainObject(value.page) ||
    !Number.isSafeInteger(value.page.limit) ||
    (value.page.limit as number) < 1 ||
    (value.page.limit as number) > 500 ||
    !(
      value.page.nextCursor === null ||
      (typeof value.page.nextCursor === "string" &&
        value.page.nextCursor.length >= 1 &&
        value.page.nextCursor.length <= 128)
    )
  ) {
    throw new Error("invalid bridge transaction response");
  }
  const transactions = value.transactions.map((candidate) => {
    if (
      !plainObject(candidate) ||
      typeof candidate.id !== "string" ||
      !validReference(candidate.id) ||
      typeof candidate.date !== "string" ||
      !validCalendarDate(candidate.date) ||
      typeof candidate.amount !== "number" ||
      !Number.isFinite(candidate.amount) ||
      !plainObject(candidate.merchant) ||
      typeof candidate.merchant.name !== "string" ||
      !validDisplay(candidate.merchant.name, 160) ||
      !plainObject(candidate.account) ||
      typeof candidate.account.id !== "string" ||
      !validReference(candidate.account.id) ||
      (requireDecisionGradeFields &&
        (typeof candidate.account.displayName !== "string" ||
          !validDisplay(candidate.account.displayName, 120) ||
          !(
            candidate.account.mask === null ||
            candidate.account.mask === undefined ||
            typeof candidate.account.mask === "string"
          ))) ||
      typeof candidate.isPending !== "boolean"
    ) {
      throw new Error("invalid bridge transaction response");
    }
    const amountMinor = Math.round(candidate.amount * 100);
    if (
      !Number.isSafeInteger(amountMinor) ||
      Math.abs(amountMinor) > 100_000_000_000
    ) {
      throw new Error("invalid bridge transaction response");
    }
    const displayName = candidate.account.displayName;
    const mask = candidate.account.mask;
    return {
      transactionRef: candidate.id,
      occurredOn: candidate.date,
      amountMinor,
      merchantName: candidate.merchant.name,
      payee: candidate.merchant.name,
      accountRef: candidate.account.id,
      accountDisplayName:
        typeof displayName === "string" && validDisplay(displayName, 120)
          ? displayName
          : "Unavailable",
      accountLastFour:
        typeof mask === "string" && /^[0-9]{4}$/.test(mask) ? mask : null,
      pending: candidate.isPending,
    };
  });
  return {
    transactions,
    incomplete:
      (value.total as number) > transactions.length ||
      value.page.nextCursor !== null,
    sourceAsOf: normalizedSourceAsOf || "1970-01-01T00:00:00.000Z",
  };
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function minorToMoney(value: number): string {
  return (value / 100).toFixed(2);
}

function validReference(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function normalizeUtcTimestamp(value: unknown): string {
  if (typeof value !== "string") return "";
  const parsed = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) ||
    Number.isNaN(parsed.getTime())
  ) {
    return "";
  }
  return parsed.toISOString();
}

function validDisplay(value: string, maximum: number): boolean {
  return (
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function invalidSourceResponse(): NextResponse {
  return gatewayError(
    502,
    "invalid_bill_match_source_response",
    "Transaction source returned an invalid response"
  );
}

function sourceUnavailable(): NextResponse {
  return gatewayError(
    503,
    "bill_match_source_unavailable",
    "Transaction source is unavailable"
  );
}

function queryTooBroad(): NextResponse {
  return gatewayError(
    422,
    "bill_match_query_too_broad",
    "Bill match lookup must be narrowed"
  );
}

function currencyMismatch(): NextResponse {
  return gatewayError(
    422,
    "bill_currency_mismatch",
    "Bill currency does not match the configured household currency"
  );
}

function gatewayError(
  status: number,
  code: string,
  message: string
): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}
