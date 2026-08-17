import type {
  FinanceMutationCurrentState,
  FinanceMutationOperation,
  FinanceMutationToolName,
  FinanceMutationValue,
} from './contracts.js';

export interface StoredFinanceMutationProposal {
  readonly tokenDigest: string;
  readonly householdScope: string;
  readonly actorId: string;
  readonly operation: FinanceMutationOperation;
  readonly transactionRef: string;
  readonly oldValue: FinanceMutationValue | null;
  readonly newValue: FinanceMutationValue;
  readonly categoryVersion: string;
  readonly attributionStateVersion: number;
  readonly proposedAt: string;
  readonly expiresAt: string;
  readonly provenance: 'viaMonarch' | 'derivedByTyrion';
}

export type FinanceMutationProposalClaim =
  | { status: 'claimed'; proposal: StoredFinanceMutationProposal }
  | { status: 'notFound' | 'expired' | 'used' };

export interface FinanceMutationProposalStore {
  createInactive(
    proposal: StoredFinanceMutationProposal,
    signal: AbortSignal
  ): Promise<void>;
  activate(tokenDigest: string, signal: AbortSignal): Promise<boolean>;
  // Claim must be atomic and return notFound without consuming on binding mismatch.
  claim(
    tokenDigest: string,
    householdScope: string,
    actorId: string,
    claimedAt: string,
    signal: AbortSignal
  ): Promise<FinanceMutationProposalClaim>;
}

export interface FinanceMutationDataPort {
  readCurrent(
    householdScope: string,
    transactionRef: string,
    signal: AbortSignal
  ): Promise<FinanceMutationCurrentState | null>;
  resolveCategory(
    householdScope: string,
    categoryRef: string,
    signal: AbortSignal
  ): Promise<FinanceMutationValue | null>;
  resolveKid(
    householdScope: string,
    kidRef: string,
    signal: AbortSignal
  ): Promise<FinanceMutationValue | null>;
  changeCategory(
    householdScope: string,
    transactionRef: string,
    categoryRef: string,
    expectedCategoryRef: string | null,
    expectedCategoryVersion: string,
    signal: AbortSignal
  ): Promise<void>;
  assignKid(
    householdScope: string,
    actorId: string,
    transactionRef: string,
    kidRef: string,
    expectedStateVersion: number,
    idempotencyKey: string,
    signal: AbortSignal
  ): Promise<void>;
  reconcileProjection(
    householdScope: string,
    operation: FinanceMutationOperation,
    verifiedState: FinanceMutationCurrentState,
    signal: AbortSignal
  ): Promise<void>;
}

export type FinanceMutationAuditOutcome =
  | 'prepared'
  | 'succeeded'
  | 'invalidInput'
  | 'permissionDenied'
  | 'targetNotFound'
  | 'proposalNotFound'
  | 'proposalExpired'
  | 'proposalUsed'
  | 'staleState'
  | 'connectorUnavailable'
  | 'connectorAuthorizationFailed'
  | 'mutationRejected'
  | 'verificationFailed'
  | 'reconciliationFailed'
  | 'auditFailed'
  | 'cancelled'
  | 'timedOut'
  | 'serviceUnavailable';

export interface FinanceMutationAuditEvent {
  auditId: string;
  requestId: string;
  householdScope: string;
  actorId: string;
  tool: FinanceMutationToolName;
  operation: FinanceMutationOperation | null;
  targetReferenceHash: string | null;
  proposedAt: string | null;
  occurredAt: string;
  outcome: FinanceMutationAuditOutcome;
  provenance: 'viaMonarch' | 'derivedByTyrion' | null;
}

export interface FinanceMutationAuditPort {
  // Implementations atomically deduplicate by auditId and reject conflicting content.
  record(event: FinanceMutationAuditEvent, signal: AbortSignal): Promise<void>;
}

export interface FinanceMutationContext {
  requestId: string;
  householdScope: string;
  actorId: string;
  permissions: ReadonlySet<'finance:mutate'>;
  signal?: AbortSignal;
}
