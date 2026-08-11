import type { EvidenceRecordV1 } from '../contracts/occurrence-v1.js';

export interface DocumentEvidenceQueryV1 {
  connectorRef: string;
  sourceGeneration: string;
  entitySourceRef: string;
}

export interface DocumentEvidencePortV1 {
  find(query: DocumentEvidenceQueryV1): Promise<readonly EvidenceRecordV1[]>;
}

export class NoDocumentEvidenceV1 implements DocumentEvidencePortV1 {
  async find(): Promise<readonly EvidenceRecordV1[]> {
    return [];
  }
}
