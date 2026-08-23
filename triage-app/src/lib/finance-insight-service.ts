import { NextRequest } from "next/server";
import {
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  defaultOccurrenceListQueryV1,
  financeInsightEvaluationResultV1,
  occurrenceIdSchema,
  parseEvaluationRequestV1,
  parseFinanceAutomationDeliveryAckRequestV1,
  parseFinanceAutomationDeliveryAckResultV1,
  parseFinanceAutomationJobRequestV1,
  parseFinanceAutomationJobResultV1,
  parseDocumentExpectationSignalsV1,
  parseOccurrenceActionRequestV1,
  parseOccurrenceActionResultV1,
  parseOccurrenceListQueryV1,
  parseOccurrenceListResponseV1,
  parseSourceFactBatchV1,
  parseSourceBatchReceiptV1,
  parseSourceGenerationCommitRequestV1,
  parseSourceGenerationCreateRequestV1,
  parseSourceGenerationResultV1,
  projectDocumentExpectationSignalsV1,
  sourceReferenceSchema,
  type SourceGenerationRecordV1,
} from "@rsocko/tyrion-finance-insights";
import { authenticateFinanceInsightRequest, FinanceInsightHttpError } from "@/lib/finance-insight-auth";
import {
  financeInsightJson,
  handleFinanceInsightError,
  MAX_DOCUMENT_EXPECTATION_RESPONSE_BYTES,
  readFinanceInsightJson,
} from "@/lib/finance-insight-http";
import { getFinanceInsightRuntime } from "@/lib/finance-insight-runtime";

const ARRAY_FILTERS = new Set([
  "kind",
  "sourceLifecycle",
  "analysisState",
  "severity",
  "baselineSufficiency",
]);
const SINGLE_FILTERS = new Set([
  "connectorRef",
  "updatedAfter",
  "limit",
  "cursor",
]);

export async function handleFinanceInsightRequest(
  request: NextRequest,
  segments: readonly string[]
) {
  try {
    authenticateFinanceInsightRequest(request);
    const runtime = await getFinanceInsightRuntime();
    if (
      request.method === "GET" &&
      segments.length === 2 &&
      segments[0] === "document-expectation-signals"
    ) {
      return await readDocumentExpectationSignalsV1(
        segments[1],
        request.nextUrl.searchParams,
        Promise.resolve(runtime)
      );
    }
    if (
      request.method === "POST" &&
      segments.length === 2 &&
      segments[0] === "automation" &&
      segments[1] === "jobs"
    ) {
      requireGate(runtime.gates.automationWrite);
      return financeInsightJson(
        parseFinanceAutomationJobResultV1(
          await runtime.runAutomation(
            parseFinanceAutomationJobRequestV1(
              await readFinanceInsightJson(request)
            )
          )
        )
      );
    }
    if (
      request.method === "POST" &&
      segments.length === 3 &&
      segments[0] === "automation" &&
      segments[1] === "deliveries" &&
      segments[2] === "ack"
    ) {
      requireGate(runtime.gates.automationWrite);
      return financeInsightJson(
        parseFinanceAutomationDeliveryAckResultV1(
          await runtime.acknowledgeAutomationDeliveries(
            parseFinanceAutomationDeliveryAckRequestV1(
              await readFinanceInsightJson(request)
            )
          )
        )
      );
    }
    if (
      request.method === "POST" &&
      segments.length === 1 &&
      segments[0] === "source-generations"
    ) {
      requireGate(runtime.gates.evaluationWrite);
      const body = parseSourceGenerationCreateRequestV1(
        await readFinanceInsightJson(request)
      );
      const result = await runtime.lifecycle.beginSourceGeneration(body);
      return financeInsightJson(sourceGenerationResult(result), 202);
    }
    if (
      request.method === "PUT" &&
      segments.length === 4 &&
      segments[0] === "source-generations" &&
      segments[2] === "batches"
    ) {
      requireGate(runtime.gates.evaluationWrite);
      const generationId = parsePathValue(
        sourceReferenceSchema,
        segments[1]
      );
      const batchIndex = parseBatchIndex(segments[3]);
      const body = parseSourceFactBatchV1(await readFinanceInsightJson(request));
      if (
        body.sourceGeneration !== generationId ||
        body.batchIndex !== batchIndex
      ) {
        throw new FinanceInsightHttpError("invalid_request");
      }
      await runtime.lifecycle.putSourceBatch(body);
      return financeInsightJson(
        parseSourceBatchReceiptV1({
          contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
          sourceGeneration: body.sourceGeneration,
          kind: body.kind,
          batchIndex: body.batchIndex,
          digest: body.digest,
          state: "accepted",
        })
      );
    }
    if (
      request.method === "POST" &&
      segments.length === 3 &&
      segments[0] === "source-generations" &&
      segments[2] === "commit"
    ) {
      requireGate(runtime.gates.evaluationWrite);
      const generationId = parsePathValue(
        sourceReferenceSchema,
        segments[1]
      );
      const body = parseSourceGenerationCommitRequestV1(
        await readFinanceInsightJson(request)
      );
      if (body.sourceGeneration !== generationId) {
        throw new FinanceInsightHttpError("invalid_request");
      }
      const source = await runtime.store.findSourceGenerationById(generationId);
      if (!source) throw new FinanceInsightHttpError("invalid_request");
      const committed = await runtime.lifecycle.commitSourceGeneration(
        source.request.connectorRef,
        body
      );
      if (committed.evaluation?.state === "queued") {
        await runtime.orchestrator.run(committed.evaluation.assignment);
      }
      return financeInsightJson(sourceGenerationResult(committed.generation));
    }
    if (
      request.method === "POST" &&
      segments.length === 1 &&
      segments[0] === "evaluations"
    ) {
      requireGate(runtime.gates.evaluationWrite);
      const body = parseEvaluationRequestV1(await readFinanceInsightJson(request));
      const evaluation = await runtime.lifecycle.retryEvaluation(body);
      const result =
        evaluation.state === "queued"
          ? await runtime.orchestrator.run(evaluation.assignment)
          : evaluation;
      return financeInsightJson(financeInsightEvaluationResultV1(result), 202);
    }
    if (
      request.method === "GET" &&
      segments.length === 1 &&
      segments[0] === "occurrences"
    ) {
      requireGate(runtime.gates.read);
      const query = parseListQuery(request.nextUrl.searchParams);
      return financeInsightJson(
        parseOccurrenceListResponseV1(
          await runtime.store.occurrences.list(query)
        )
      );
    }
    if (
      request.method === "GET" &&
      segments.length === 2 &&
      segments[0] === "occurrences"
    ) {
      requireGate(runtime.gates.read);
      const occurrenceId = parsePathValue(
        occurrenceIdSchema,
        segments[1]
      );
      const detail = await runtime.store.occurrences.getDetail(occurrenceId);
      if (!detail) throw new FinanceInsightHttpError("occurrence_not_found");
      return financeInsightJson(detail);
    }
    if (
      request.method === "POST" &&
      segments.length === 3 &&
      segments[0] === "occurrences" &&
      segments[2] === "actions"
    ) {
      requireGate(runtime.gates.actions);
      const occurrenceId = parsePathValue(
        occurrenceIdSchema,
        segments[1]
      );
      const policy = await runtime.store.policies.current();
      if (!policy?.featureGates.confirmedActions) {
        throw new FinanceInsightHttpError("insight_forbidden");
      }
      const body = parseOccurrenceActionRequestV1(
        await readFinanceInsightJson(request)
      );
      if (body.occurrenceId !== occurrenceId) {
        throw new FinanceInsightHttpError("invalid_request");
      }
      return financeInsightJson(
        parseOccurrenceActionResultV1(
          await runtime.store.occurrences.applyAction(body)
        )
      );
    }
    throw new FinanceInsightHttpError("insight_route_not_available");
  } catch (error) {
    return handleFinanceInsightError(error);
  }
}

export async function readDocumentExpectationSignalsV1(
  sourceGenerationValue: string | undefined,
  searchParams: URLSearchParams,
  runtimePromise = getFinanceInsightRuntime()
) {
  const runtime = await runtimePromise;
  requireGate(runtime.gates.read);
  const sourceGeneration = parsePathValue(
    sourceReferenceSchema,
    sourceGenerationValue
  );
  const connectorRef = parseSingleRequiredQuery(searchParams, "connectorRef");
  const source = await runtime.store.sourceGenerations.find(
    connectorRef,
    sourceGeneration
  );
  const projection = await runtime.store.loadProjection(
    connectorRef,
    sourceGeneration
  );
  if (!source || !projection) {
    throw new FinanceInsightHttpError("source_generation_not_found");
  }
  return financeInsightJson(
    parseDocumentExpectationSignalsV1(
      projectDocumentExpectationSignalsV1(
        {
          connectorRef,
          sourceGeneration,
          sourceAsOf: source.request.sourceAsOf,
          completeness: "complete",
          accounts: projection.accounts,
          recurring: projection.recurring,
          knownOutgoingRecurringRefs:
            await runtime.store.loadRecurringObligationRefs(
              connectorRef,
              sourceGeneration
            ),
        },
        runtime.identityNamespace
      )
    ),
    200,
    MAX_DOCUMENT_EXPECTATION_RESPONSE_BYTES
  );
}

function requireGate(enabled: boolean): void {
  if (!enabled) throw new FinanceInsightHttpError("insight_service_not_configured");
}

function sourceGenerationResult(record: SourceGenerationRecordV1) {
  if (record.state === "expired" || record.state === "rejected") {
    throw new FinanceInsightHttpError("stale_source_generation");
  }
  return parseSourceGenerationResultV1({
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    connectorRef: record.request.connectorRef,
    sourceGeneration: record.request.sourceGeneration,
    sourceSequence: record.request.sourceSequence,
    state: record.state,
    detectorSetVersion: record.assignedDetectorSetVersion,
    policyVersion: record.assignedPolicyVersion,
  });
}

function parsePathValue<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false };
  },
  value: string | undefined
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new FinanceInsightHttpError("invalid_request");
  }
  return result.data;
}

function parseBatchIndex(value: string | undefined): number {
  if (!value || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new FinanceInsightHttpError("invalid_request");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new FinanceInsightHttpError("invalid_request");
  }
  return parsed;
}

function parseSingleRequiredQuery(
  search: URLSearchParams,
  key: string
): string {
  if (
    [...search.keys()].some((candidate) => candidate !== key) ||
    search.getAll(key).length !== 1
  ) {
    throw new FinanceInsightHttpError("invalid_filter");
  }
  return parsePathValue(sourceReferenceSchema, search.get(key) ?? undefined);
}

function parseListQuery(search: URLSearchParams) {
  for (const key of search.keys()) {
    if (!ARRAY_FILTERS.has(key) && !SINGLE_FILTERS.has(key)) {
      throw new FinanceInsightHttpError("invalid_filter");
    }
  }
  for (const key of SINGLE_FILTERS) {
    if (search.getAll(key).length > 1) {
      throw new FinanceInsightHttpError("invalid_filter");
    }
  }
  const defaults = defaultOccurrenceListQueryV1();
  const limitValue = search.get("limit");
  const analysisState = search.has("analysisState")
    ? search.getAll("analysisState")
    : defaults.analysisState;
  if (limitValue !== null && !/^[1-9]\d*$/.test(limitValue)) {
    throw new FinanceInsightHttpError("invalid_filter");
  }
  try {
    return parseOccurrenceListQueryV1({
      kind: search.getAll("kind"),
      sourceLifecycle: search.has("sourceLifecycle")
        ? search.getAll("sourceLifecycle")
        : analysisState.some((state) => state !== "qualified")
          ? []
          : defaults.sourceLifecycle,
      analysisState,
      severity: search.getAll("severity"),
      baselineSufficiency: search.getAll("baselineSufficiency"),
      connectorRef: search.get("connectorRef"),
      updatedAfter: search.get("updatedAfter"),
      limit: limitValue === null ? defaults.limit : Number(limitValue),
      cursor: search.get("cursor"),
    });
  } catch {
    throw new FinanceInsightHttpError("invalid_filter");
  }
}
