import {
  defaultBillAmountToleranceMinorV1,
  parseBillMatchRequestV1,
  rankBillMatchCandidatesV1,
  type BillMatchTransactionV1,
} from "@rsocko/tyrion-finance-insights";
import { FinanceInsightContractValidationError } from "@rsocko/tyrion-finance-insights";
import { NextResponse } from "next/server";
import { financeInsightJson } from "@/lib/finance-insight-http";
import { getFinanceInsightRuntime } from "@/lib/finance-insight-runtime";

const BRIDGE_TIMEOUT_MS = 30_000;
const MAX_BRIDGE_RESPONSE_BYTES = 512 * 1024;

export async function matchBillToTransactionsV1(
  body: unknown,
  bridgeBaseUrl: URL,
  bridgeToken: string
): Promise<NextResponse> {
  const input = parseBillMatchRequestV1(body);
  let householdCurrency: string;
  try {
    const runtime = await getFinanceInsightRuntime();
    const policy = await runtime.store.policies.current();
    if (!policy) {
      return gatewayError(
        503,
        "bill_match_configuration_unavailable",
        "Bill matching configuration is unavailable"
      );
    }
    householdCurrency = policy.currency;
  } catch {
    return gatewayError(
      503,
      "bill_match_configuration_unavailable",
      "Bill matching configuration is unavailable"
    );
  }
  if (input.currency !== householdCurrency) {
    return gatewayError(
      422,
      "bill_currency_mismatch",
      "Bill currency does not match the configured household currency"
    );
  }
  const tolerance =
    input.amountToleranceMinor ??
    defaultBillAmountToleranceMinorV1(input.amountMinor);
  const query = new URLSearchParams({
    start_date: shiftDate(input.dueDate, -input.dateWindowDays),
    end_date: shiftDate(input.dueDate, input.dateWindowDays),
    min_amount: minorToMoney(-(input.amountMinor + tolerance)),
    max_amount: minorToMoney(-Math.max(0, input.amountMinor - tolerance)),
    limit: "100",
  });
  if (input.accountRef) query.set("account_id", input.accountRef);

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
      return gatewayError(
        503,
        "bill_match_source_unavailable",
        "Transaction source is unavailable"
      );
    }
    if (
      !response.headers.get("content-type")?.toLowerCase().includes("application/json")
    ) {
      await response.body?.cancel().catch(() => undefined);
      return invalidSourceResponse();
    }
    const payload = await readBoundedJson(response);
    if (payload === null) return invalidSourceResponse();
    try {
      const source = parseBridgeTransactions(payload);
      if (source.incomplete) {
        return gatewayError(
          422,
          "bill_match_query_too_broad",
          "Bill match lookup must be narrowed"
        );
      }
      return financeInsightJson(
        rankBillMatchCandidatesV1(input, source.transactions)
      );
    } catch {
      return invalidSourceResponse();
    }
  } catch (error) {
    if (error instanceof FinanceInsightContractValidationError) throw error;
    return gatewayError(
      503,
      "bill_match_source_unavailable",
      "Transaction source is unavailable"
    );
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

function parseBridgeTransactions(value: unknown): {
  transactions: BillMatchTransactionV1[];
  incomplete: boolean;
} {
  if (!plainObject(value) || value.contractVersion !== "1.0") {
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
      !candidate.merchant.name.trim() ||
      candidate.merchant.name.length > 120 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(candidate.merchant.name) ||
      !plainObject(candidate.account) ||
      typeof candidate.account.id !== "string" ||
      !validReference(candidate.account.id) ||
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
    return {
      transactionRef: candidate.id,
      occurredOn: candidate.date,
      amountMinor,
      merchantName: candidate.merchant.name,
      accountRef: candidate.account.id,
      pending: candidate.isPending,
    };
  });
  return {
    transactions,
    incomplete:
      (value.total as number) > transactions.length ||
      value.page.nextCursor !== null,
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
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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
