import {
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  canonicalDigestV1,
  isFinanceInsightStoreError,
  parseSourceFactBatchV1,
  parseSourceGenerationCommitRequestV1,
  parseSourceGenerationCreateRequestV1,
  sourceManifestDigestV1,
  sourceManifestKindDigestV1,
} from "@rsocko/tyrion-finance-insights";

const BRIDGE_CONTRACT_VERSION = "1.0";
const CONNECTOR_REF = "monarch-current-document-expectations";
const MAX_BRIDGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const FACT_KINDS = ["transaction", "recurring", "category", "account", "tag"];
const EMPTY_FACTS = Object.freeze([]);

let refreshTail = Promise.resolve();

export class CurrentDocumentExpectationSourceError extends Error {
  constructor() {
    super("Current document expectation source is unavailable");
    this.name = "CurrentDocumentExpectationSourceError";
  }
}

class CurrentDocumentExpectationPublicationOvertakenError extends Error {}

export function refreshCurrentDocumentExpectationGeneration(options) {
  const refresh = refreshTail.then(() => refreshGeneration(options));
  refreshTail = refresh.catch(() => undefined);
  return refresh;
}

async function refreshGeneration({
  runtime,
  bridgeBaseUrl,
  bridgeToken,
  fetchImpl = fetch,
}) {
  try {
    if (!(bridgeBaseUrl instanceof URL) || !validBridgeToken(bridgeToken)) {
      throw new CurrentDocumentExpectationSourceError();
    }
    let snapshot = await loadSnapshot(bridgeBaseUrl, bridgeToken, fetchImpl);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await publishSnapshot(runtime, snapshot);
      } catch (error) {
        if (attempt < 2 && retryablePublicationConflict(error)) {
          snapshot = await loadSnapshot(bridgeBaseUrl, bridgeToken, fetchImpl);
          continue;
        }
        throw error;
      }
    }
    throw new CurrentDocumentExpectationSourceError();
  } catch (error) {
    if (error instanceof CurrentDocumentExpectationSourceError) throw error;
    throw new CurrentDocumentExpectationSourceError();
  }
}

async function publishSnapshot(runtime, snapshot) {
  const current = await runtime.store.findCurrentSourceGeneration(CONNECTOR_REF);
  if (current && (await generationMatches(runtime, current, snapshot.digest))) {
    return current;
  }
  const latest = await runtime.store.findLatestSourceGeneration(CONNECTOR_REF);
  const sourceSequence = (latest?.request.sourceSequence ?? 0) + 1;
  if (!Number.isSafeInteger(sourceSequence)) {
    throw new CurrentDocumentExpectationSourceError();
  }
  const sourceGeneration = `owl-current-v1-${sourceSequence}-${snapshot.digest.slice(7, 39)}`;
  const publication = createPublication(snapshot, sourceGeneration, sourceSequence);
  await runtime.lifecycle.beginSourceGeneration(publication.request);
  for (const batch of publication.batches) {
    await runtime.lifecycle.putSourceBatch(batch);
  }
  const committed = await runtime.lifecycle.commitSourceGeneration(
    CONNECTOR_REF,
    publication.commit,
    current?.request.sourceGeneration ?? null
  );
  if (committed.evaluation?.state === "queued") {
    await runtime.orchestrator.run(committed.evaluation.assignment);
  }
  if (committed.generation.state !== "promoted") {
    throw new CurrentDocumentExpectationPublicationOvertakenError();
  }
  return committed.generation;
}

function retryablePublicationConflict(error) {
  return (
    error instanceof CurrentDocumentExpectationPublicationOvertakenError ||
    (isFinanceInsightStoreError(error) &&
      ["idempotency_conflict", "source_generation_conflict"].includes(
        error.descriptor.body.error.code
      ))
  );
}

async function generationMatches(runtime, generation, expectedDigest) {
  const projection = await runtime.store.loadProjection(
    generation.request.connectorRef,
    generation.request.sourceGeneration
  );
  return projection !== null && projectionDigest(projection) === expectedDigest;
}

async function loadSnapshot(baseUrl, token, fetchImpl) {
  const [accountsResponse, recurringResponse] = await Promise.all([
    fetchBridgeJson(baseUrl, "/accounts", token, fetchImpl),
    fetchBridgeJson(baseUrl, "/recurring", token, fetchImpl),
  ]);
  const accountEnvelope = requireEnvelope(accountsResponse, "accounts", 1_000);
  const recurringEnvelope = requireEnvelope(recurringResponse, "recurring", 5_000);
  const accounts = accountEnvelope.items.map(normalizeAccount).sort(bySourceRef);
  const recurring = recurringEnvelope.items.map(normalizeRecurring).sort(bySourceRef);
  const sourceAsOf =
    Date.parse(accountEnvelope.fetchedAt) <= Date.parse(recurringEnvelope.fetchedAt)
      ? accountEnvelope.fetchedAt
      : recurringEnvelope.fetchedAt;
  return {
    accounts,
    recurring,
    sourceAsOf,
    digest: canonicalDigestV1([accounts, recurring]),
  };
}

async function fetchBridgeJson(baseUrl, path, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(new URL(path, baseUrl), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CurrentDocumentExpectationSourceError();
  }
  if (
    !response.ok ||
    response.headers.get("x-monarch-contract-version") !== BRIDGE_CONTRACT_VERSION ||
    !response.headers.get("content-type")?.toLowerCase().includes("application/json")
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new CurrentDocumentExpectationSourceError();
  }
  const bytes = await readBoundedResponse(response);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CurrentDocumentExpectationSourceError();
  }
}

async function readBoundedResponse(response) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_BRIDGE_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new CurrentDocumentExpectationSourceError();
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CurrentDocumentExpectationSourceError();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BRIDGE_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CurrentDocumentExpectationSourceError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function requireEnvelope(value, itemKey, maximumItems) {
  if (
    !isPlainObject(value) ||
    value.contractVersion !== BRIDGE_CONTRACT_VERSION ||
    !isPlainObject(value.provenance) ||
    !["demo", "live"].includes(value.provenance.provider) ||
    !validTimestamp(value.provenance.fetchedAt) ||
    !Array.isArray(value[itemKey]) ||
    value[itemKey].length > maximumItems
  ) {
    throw new CurrentDocumentExpectationSourceError();
  }
  return { fetchedAt: new Date(value.provenance.fetchedAt).toISOString(), items: value[itemKey] };
}

function normalizeAccount(value) {
  if (
    !isPlainObject(value) ||
    typeof value.displayName !== "string" ||
    typeof value.type !== "string" ||
    typeof value.isActive !== "boolean" ||
    (value.institution !== null &&
      value.institution !== undefined &&
      typeof value.institution !== "string") ||
    (value.mask !== null &&
      value.mask !== undefined &&
      typeof value.mask !== "string")
  ) {
    throw new CurrentDocumentExpectationSourceError();
  }
  const institutionName =
    value.institution === null || value.institution === undefined
      ? undefined
      : optionalBoundedAccountIdentityText(value.institution);
  const displayName = optionalBoundedAccountIdentityText(value.displayName);
  const lastFour = accountLastFour(value.mask);
  return {
    sourceRef: sourceReference(value.id),
    ...(displayName ? { displayName } : {}),
    ...(institutionName ? { institutionName } : {}),
    accountType: accountType(value.type),
    ...(lastFour ? { accountLastFour: lastFour } : {}),
    active: value.isActive,
  };
}

function normalizeRecurring(value) {
  if (
    !isPlainObject(value) ||
    typeof value.merchant !== "string" ||
    !Number.isFinite(value.amount) ||
    typeof value.frequency !== "string" ||
    (value.nextExpectedDate !== null &&
      value.nextExpectedDate !== undefined &&
      !validCalendarDate(value.nextExpectedDate)) ||
    (value.account !== null &&
      value.account !== undefined &&
      (!isPlainObject(value.account) || typeof value.account.id !== "string")) ||
    (value.category !== null &&
      value.category !== undefined &&
      (!isPlainObject(value.category) || typeof value.category.id !== "string"))
  ) {
    throw new CurrentDocumentExpectationSourceError();
  }
  const amountMinor = Math.round(value.amount * 100);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new CurrentDocumentExpectationSourceError();
  }
  return {
    sourceRef: sourceReference(value.id),
    displayName: normalizedDisplayName(value.merchant),
    amountMinor,
    cadence: cadence(value.frequency),
    nextDate: value.nextExpectedDate ?? null,
    categoryRef: value.category ? sourceReference(value.category.id) : null,
    accountRef: value.account ? sourceReference(value.account.id) : null,
    active: true,
  };
}

function createPublication(snapshot, sourceGeneration, sourceSequence) {
  const facts = {
    transaction: EMPTY_FACTS,
    recurring: snapshot.recurring,
    category: EMPTY_FACTS,
    account: snapshot.accounts,
    tag: EMPTY_FACTS,
  };
  const batches = [];
  for (const kind of FACT_KINDS) {
    for (let index = 0; index * 250 < facts[kind].length; index += 1) {
      const batchFacts = facts[kind].slice(index * 250, (index + 1) * 250);
      batches.push(
        parseSourceFactBatchV1({
          contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
          sourceGeneration,
          kind,
          batchIndex: index,
          facts: batchFacts,
          digest: canonicalDigestV1(batchFacts),
          idempotencyKey: `${sourceGeneration}-${kind}-${index}`,
        })
      );
    }
  }
  const manifest = FACT_KINDS.map((kind) => ({
    kind,
    batchCount: Math.ceil(facts[kind].length / 250),
    itemCount: facts[kind].length,
    digest: sourceManifestKindDigestV1(kind, batches),
  }));
  const coverageDate = snapshot.sourceAsOf.slice(0, 10);
  const request = parseSourceGenerationCreateRequestV1({
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    connectorRef: CONNECTOR_REF,
    sourceGeneration,
    sourceSequence,
    sourceAsOf: snapshot.sourceAsOf,
    coverageStart: coverageDate,
    coverageEnd: coverageDate,
    currency: "USD",
    bridgeContractVersion: BRIDGE_CONTRACT_VERSION,
    capturedConstituents: manifest.map((entry) => ({
      kind: entry.kind,
      generationRef: `${sourceGeneration}-${entry.kind}`,
      sourceAsOf: snapshot.sourceAsOf,
      itemCount: entry.itemCount,
      digest: canonicalDigestV1(facts[entry.kind]),
    })),
    manifest,
    idempotencyKey: `${sourceGeneration}-begin`,
  });
  return {
    request,
    batches,
    commit: parseSourceGenerationCommitRequestV1({
      contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
      sourceGeneration,
      expectedSourceSequence: sourceSequence,
      manifestDigest: sourceManifestDigestV1(manifest),
      idempotencyKey: `${sourceGeneration}-commit`,
    }),
  };
}

function projectionDigest(projection) {
  return canonicalDigestV1([projection.accounts, projection.recurring]);
}

function accountType(value) {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (/\bchecking\b/.test(normalized)) return "checking";
  if (/\bsavings?\b/.test(normalized)) return "savings";
  if (/\bcredit\b/.test(normalized)) return "credit";
  if (/\bcash\b/.test(normalized)) return "cash";
  if (/\bloan\b|\bmortgage\b|\bdebt\b/.test(normalized)) return "loan";
  if (/\binvestment\b|\bbrokerage\b|\bretirement\b/.test(normalized)) {
    return "investment";
  }
  return "other";
}

function cadence(value) {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (/weekly|every week/.test(normalized) && !/biweekly|two weeks|2 weeks/.test(normalized)) {
    return "weekly";
  }
  if (/biweekly|two weeks|2 weeks|fortnight/.test(normalized)) return "biweekly";
  if (/monthly|every month/.test(normalized)) return "monthly";
  if (/quarterly|three months|3 months/.test(normalized)) return "quarterly";
  if (/semiannual|semi-annual|six months|6 months|twice.*year/.test(normalized)) {
    return "semiannual";
  }
  if (/annual|yearly|every year/.test(normalized)) return "annual";
  return "unknown";
}

function sourceReference(value) {
  if (typeof value !== "string") throw new CurrentDocumentExpectationSourceError();
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < 1 ||
    normalized.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new CurrentDocumentExpectationSourceError();
  }
  return normalized;
}

function normalizedDisplayName(value) {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new CurrentDocumentExpectationSourceError();
  }
  return normalized;
}

function optionalBoundedAccountIdentityText(value) {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function accountLastFour(value) {
  if (value === null || value === undefined) return undefined;
  const digits = value.normalize("NFKC").match(/[0-9]/g) ?? [];
  return digits.length >= 4 ? digits.slice(-4).join("") : undefined;
}

function validBridgeToken(value) {
  return typeof value === "string" && value.length >= 32;
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(
      value
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function validCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function bySourceRef(left, right) {
  return left.sourceRef < right.sourceRef ? -1 : left.sourceRef > right.sourceRef ? 1 : 0;
}
