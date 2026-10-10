import { createReadStream } from "node:fs";
import {
  parseReceiptIntakeResultV1,
  type ReceiptIntakeResultV1,
} from "@rsocko/tyrion-finance-insights/receipt";
import { ReceiptEvidenceHttpError } from "@/lib/receipt-evidence-auth";

const OWL_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export const OWL_FORWARD_HEADERS = [
  "x-owl-source-channel",
  "x-owl-source-occurrence-version",
  "x-owl-source-occurrence",
  "x-owl-connector-ref",
  "x-owl-source-observed-at",
  "x-owl-transform-version",
  "x-owl-normalized-fingerprint",
  "x-owl-normalized-version",
  "x-owl-semantic-fingerprint",
  "x-owl-semantic-version",
] as const;

export class ReceiptOwlClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly token: string
  ) {}

  static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env
  ): ReceiptOwlClient {
    const token = environment.OWL_RECEIPT_INTAKE_API_TOKEN;
    if (!token || token.length < 32) {
      throw unavailable();
    }
    let url: URL;
    try {
      url = new URL(environment.OWL_RECEIPT_INTAKE_URL ?? "");
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
    return new ReceiptOwlClient(url, token);
  }

  async submit(
    artifactPath: string,
    mediaType: string,
    sourceHeaders: Headers
  ): Promise<ReceiptIntakeResultV1> {
    const headers = this.headers();
    headers.set("Content-Type", mediaType);
    for (const name of OWL_FORWARD_HEADERS) {
      const value = sourceHeaders.get(name);
      if (value !== null) headers.set(name, value);
    }
    return (await this.request(
      new URL("/api/receipt-intake/v1/occurrences", this.baseUrl),
      {
        method: "POST",
        headers,
        body: createReadStream(artifactPath) as unknown as BodyInit,
        duplex: "half",
      }
    ))!;
  }

  async get(intakeRef: string): Promise<ReceiptIntakeResultV1> {
    return (await this.request(
      new URL(
        `/api/receipt-intake/v1/occurrences/${encodeURIComponent(intakeRef)}`,
        this.baseUrl
      ),
      { method: "GET", headers: this.headers() }
    ))!;
  }

  async lookup(
    identity:
      | { sourceOccurrenceId: string }
      | { blobSha256: string }
  ): Promise<ReceiptIntakeResultV1 | null> {
    const headers = this.headers();
    if ("sourceOccurrenceId" in identity) {
      headers.set("X-OWL-Source-Occurrence", identity.sourceOccurrenceId);
    } else {
      headers.set("X-OWL-Blob-SHA256", identity.blobSha256);
    }
    return await this.request(
      new URL("/api/receipt-intake/v1/lookup", this.baseUrl),
      { method: "GET", headers },
      true
    );
  }

  async reconcile(intakeRef: string): Promise<ReceiptIntakeResultV1> {
    return (await this.request(
      new URL(
        `/api/receipt-intake/v1/occurrences/${encodeURIComponent(intakeRef)}/reconcile`,
        this.baseUrl
      ),
      { method: "POST", headers: this.headers() }
    ))!;
  }

  private headers(): Headers {
    return new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    });
  }

  private async request(
    url: URL,
    init: RequestInit & { duplex?: "half" },
    allowNotFound = false
  ): Promise<ReceiptIntakeResultV1 | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OWL_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (allowNotFound && response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ReceiptEvidenceHttpError(
          503,
          "receipt_intake_unavailable",
          "Canonical receipt intake is unavailable"
        );
      }
      return parseReceiptIntakeResultV1(
        await readBoundedJson(response, MAX_RESPONSE_BYTES)
      );
    } catch (error) {
      if (error instanceof ReceiptEvidenceHttpError) throw error;
      throw new ReceiptEvidenceHttpError(
        503,
        "receipt_intake_unavailable",
        "Canonical receipt intake is unavailable"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
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
    "receipt_intake_not_configured",
    "Canonical receipt intake is not configured"
  );
}
