import { createReadStream } from "node:fs";
import { z } from "zod";
import {
  receiptOpaqueReferenceV1,
  type ReceiptNativeEvidenceV1,
  type ReceiptReplicaLifecycleV1,
} from "@rsocko/tyrion-finance-insights/receipt";
import { ReceiptEvidenceHttpError } from "@/lib/receipt-evidence-auth";

const BRIDGE_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
export const MONARCH_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

const bridgeReceiptSchema = z.strictObject({
  id: z.string().min(1).max(512),
  source: z.enum(["upload", "email"]),
  status: z.enum(["processing", "awaiting_match", "matched", "failed"]),
  createdAt: z.string().datetime({ offset: true }).nullable(),
  linkedTransactionId: z.string().min(1).max(512).nullable(),
  attachments: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(512),
        mediaType: z
          .enum(["image/jpeg", "image/png", "application/pdf"])
          .nullable(),
        sizeBytes: z.number().int().nonnegative().nullable(),
        downloadAvailable: z.boolean(),
      })
    )
    .max(8),
});

const bridgeReceiptResponseSchema = z.object({
  receipt: bridgeReceiptSchema,
});

type BridgeReceipt = z.infer<typeof bridgeReceiptSchema>;

export class ReceiptBridgeAdapter {
  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
    private readonly identityNamespace: Uint8Array
  ) {}

  static fromEnvironment(
    identityNamespace: Uint8Array,
    environment: NodeJS.ProcessEnv = process.env
  ): ReceiptBridgeAdapter {
    const token = environment.BRIDGE_API_TOKEN;
    if (!token || token.length < 32) throw unavailable();
    let url: URL;
    try {
      url = new URL(environment.BRIDGE_URL ?? "");
    } catch {
      throw unavailable();
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw unavailable();
    }
    return new ReceiptBridgeAdapter(url, token, identityNamespace);
  }

  async create(): Promise<BridgeReceipt> {
    return this.request("/receipts", {
      method: "POST",
      headers: this.headers(),
    });
  }

  async upload(
    receiptId: string,
    artifactPath: string,
    mediaType: string
  ): Promise<BridgeReceipt> {
    const headers = this.headers();
    headers.set("Content-Type", mediaType);
    return this.request(`/receipts/${encodeURIComponent(receiptId)}/content`, {
      method: "PUT",
      headers,
      body: createReadStream(artifactPath) as unknown as BodyInit,
      duplex: "half",
    });
  }

  async get(receiptId: string): Promise<BridgeReceipt> {
    return this.request(`/receipts/${encodeURIComponent(receiptId)}`, {
      method: "GET",
      headers: this.headers(),
    });
  }

  publicReference(receiptId: string): string {
    return receiptOpaqueReferenceV1(
      "receipt",
      this.identityNamespace,
      receiptId
    );
  }

  evidence(receipt: BridgeReceipt, observedAt: string): {
    lifecycle: ReceiptReplicaLifecycleV1;
    evidence: ReceiptNativeEvidenceV1;
  } {
    const transactionRef = receipt.linkedTransactionId
      ? receiptOpaqueReferenceV1(
          "transaction",
          this.identityNamespace,
          receipt.linkedTransactionId
        )
      : null;
    return {
      lifecycle:
        receipt.status === "matched"
          ? "matched"
          : receipt.status === "awaiting_match"
            ? "awaiting_transaction"
            : receipt.status === "failed"
              ? "failed"
              : "processing",
      evidence: {
        receiptSource: receipt.source,
        receiptState: receipt.status,
        transactionRef,
        attachmentCount: receipt.attachments.length,
        sourceAsOf: receipt.createdAt
          ? new Date(receipt.createdAt).toISOString()
          : null,
        observedAt,
      },
    };
  }

  private headers(): Headers {
    return new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    });
  }

  private async request(
    path: string,
    init: RequestInit & { duplex?: "half" }
  ): Promise<BridgeReceipt> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        ...init,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ReceiptEvidenceHttpError(
          503,
          "receipt_bridge_unavailable",
          "Monarch receipt processing is unavailable"
        );
      }
      const payload = await readBoundedJson(response);
      return bridgeReceiptResponseSchema.parse(payload).receipt;
    } catch (error) {
      if (error instanceof ReceiptEvidenceHttpError) throw error;
      throw new ReceiptEvidenceHttpError(
        503,
        "receipt_bridge_unavailable",
        "Monarch receipt processing is unavailable"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("oversized_response");
    }
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

function unavailable(): ReceiptEvidenceHttpError {
  return new ReceiptEvidenceHttpError(
    503,
    "receipt_bridge_not_configured",
    "Monarch receipt processing is not configured"
  );
}
