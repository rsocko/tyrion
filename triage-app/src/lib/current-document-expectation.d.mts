import type {
  FinanceInsightRuntime,
} from "./finance-insight-runtime";
import type {
  SourceGenerationRecordV1,
} from "@rsocko/tyrion-finance-insights";

export class CurrentDocumentExpectationSourceError extends Error {}

export function refreshCurrentDocumentExpectationGeneration(options: {
  runtime: FinanceInsightRuntime;
  bridgeBaseUrl: URL;
  bridgeToken: string;
  fetchImpl?: typeof fetch;
}): Promise<SourceGenerationRecordV1>;
