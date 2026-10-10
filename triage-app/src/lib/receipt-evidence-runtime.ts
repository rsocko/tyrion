import { isAbsolute, relative, resolve } from "node:path";
import {
  ReceiptOrchestrationSqliteStoreV1,
} from "@rsocko/tyrion-finance-insights/receipt";

export interface ReceiptEvidenceRuntime {
  store: ReceiptOrchestrationSqliteStoreV1;
  identityNamespace: Uint8Array;
  gates: {
    read: boolean;
    write: boolean;
    recovery: boolean;
  };
}

let cachedRuntime: ReceiptEvidenceRuntime | undefined;

export function getReceiptEvidenceRuntime(
  environment: NodeJS.ProcessEnv = process.env
): ReceiptEvidenceRuntime {
  cachedRuntime ??= createReceiptEvidenceRuntime(environment);
  return cachedRuntime;
}

export function createReceiptEvidenceRuntime(
  environment: NodeJS.ProcessEnv
): ReceiptEvidenceRuntime {
  const path = requireExternalAbsolutePath(
    environment.TYRION_FINANCE_INSIGHT_STORE_PATH
  );
  const namespace = environment.TYRION_RECEIPT_IDENTITY_NAMESPACE;
  if (!namespace || namespace.length < 32) {
    throw new Error("receipt_evidence_runtime_unavailable");
  }
  return {
    store: new ReceiptOrchestrationSqliteStoreV1(path),
    identityNamespace: Buffer.from(namespace, "utf8"),
    gates: {
      read: environment.TYRION_RECEIPT_EVIDENCE_READ_ENABLED === "true",
      write: environment.TYRION_RECEIPT_REPLICA_WRITE_ENABLED === "true",
      recovery: environment.TYRION_RECEIPT_RECOVERY_ENABLED === "true",
    },
  };
}

function requireExternalAbsolutePath(value: string | undefined): string {
  if (!value || !isAbsolute(value)) {
    throw new Error("receipt_evidence_runtime_unavailable");
  }
  const path = resolve(value);
  const imageRoot = resolve(process.cwd(), "..");
  const pathFromImage = relative(imageRoot, path);
  if (
    pathFromImage === "" ||
    (!pathFromImage.startsWith("..") && !isAbsolute(pathFromImage))
  ) {
    throw new Error("receipt_evidence_runtime_unavailable");
  }
  return path;
}
