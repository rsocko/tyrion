import {
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import type { z } from 'zod';
import {
  FINANCE_MUTATION_PROPOSAL_TTL_MS,
  financeMutationCurrentStateSchema,
  financeMutationToolInputSchemas,
  financeMutationValueSchema,
  type FinanceMutationCurrentState,
  type FinanceMutationExecuteResult,
  type FinanceMutationOperation,
  type FinanceMutationPrepareResult,
  type FinanceMutationToolName,
  type FinanceMutationValue,
} from './contracts.js';
import {
  FinanceMutationAdapterError,
  FinanceMutationError,
  type FinanceMutationErrorCode,
} from './errors.js';
import type {
  FinanceMutationAuditOutcome,
  FinanceMutationAuditPort,
  FinanceMutationContext,
  FinanceMutationDataPort,
  FinanceMutationProposalStore,
  StoredFinanceMutationProposal,
} from './ports.js';

const ERROR_OUTCOMES: Readonly<
  Record<FinanceMutationErrorCode, FinanceMutationAuditOutcome>
> = Object.freeze({
  invalid_input: 'invalidInput',
  permission_denied: 'permissionDenied',
  target_not_found: 'targetNotFound',
  proposal_not_found: 'proposalNotFound',
  proposal_expired: 'proposalExpired',
  proposal_used: 'proposalUsed',
  stale_state: 'staleState',
  connector_unavailable: 'connectorUnavailable',
  connector_authorization_failed: 'connectorAuthorizationFailed',
  mutation_rejected: 'mutationRejected',
  verification_failed: 'verificationFailed',
  reconciliation_failed: 'reconciliationFailed',
  audit_failed: 'auditFailed',
  cancelled: 'cancelled',
  timed_out: 'timedOut',
  service_unavailable: 'serviceUnavailable',
});

export interface FinanceMutationServiceOptions {
  householdScope: string;
  proposals: FinanceMutationProposalStore;
  data: FinanceMutationDataPort;
  audit: FinanceMutationAuditPort;
  referenceHashKey: Uint8Array;
  proposalTtlMs?: number;
  timeoutMs?: number;
  auditTimeoutMs?: number;
  clock?: () => Date;
  tokenFactory?: () => string;
}

interface AuditContext {
  operation: FinanceMutationOperation | null;
  targetReferenceHash: string | null;
  proposedAt: string | null;
  provenance: 'viaMonarch' | 'derivedByTyrion' | null;
}

type ExecutionPhase =
  | 'none'
  | 'writing'
  | 'written'
  | 'verified'
  | 'reconciled';

export class FinanceMutationService {
  private readonly householdScope: string;
  private readonly proposals: FinanceMutationProposalStore;
  private readonly data: FinanceMutationDataPort;
  private readonly audit: FinanceMutationAuditPort;
  private readonly referenceHashKey: Uint8Array;
  private readonly proposalTtlMs: number;
  private readonly timeoutMs: number;
  private readonly auditTimeoutMs: number;
  private readonly clock: () => Date;
  private readonly tokenFactory: () => string;

  constructor(options: FinanceMutationServiceOptions) {
    if (!validIdentifier(options.householdScope)) {
      throw new Error('householdScope is required');
    }
    if (options.referenceHashKey.byteLength < 32) {
      throw new Error('referenceHashKey must contain at least 32 bytes');
    }
    this.householdScope = options.householdScope;
    this.proposals = options.proposals;
    this.data = options.data;
    this.audit = options.audit;
    this.referenceHashKey = options.referenceHashKey;
    this.proposalTtlMs =
      options.proposalTtlMs ?? FINANCE_MUTATION_PROPOSAL_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.auditTimeoutMs =
      options.auditTimeoutMs ?? Math.min(1_000, this.timeoutMs);
    this.clock = options.clock ?? (() => new Date());
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
    if (this.proposalTtlMs < 30_000 || this.proposalTtlMs > 15 * 60 * 1_000) {
      throw new Error('proposalTtlMs must be between 30000 and 900000');
    }
    if (this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error('timeoutMs must be between 1 and 30000');
    }
    if (this.auditTimeoutMs < 1 || this.auditTimeoutMs > 5_000) {
      throw new Error('auditTimeoutMs must be between 1 and 5000');
    }
  }

  async invoke(
    tool: FinanceMutationToolName,
    input: unknown,
    context: FinanceMutationContext
  ): Promise<FinanceMutationPrepareResult | FinanceMutationExecuteResult> {
    const auditContext: AuditContext = {
      operation: null,
      targetReferenceHash: null,
      proposedAt: null,
      provenance: null,
    };
    const execution = { phase: 'none' as ExecutionPhase };
    try {
      this.authorize(context);
      return await withDeadline(
        async (signal) => {
          if (tool === 'finance_prepare_category_change') {
            const request = parseInput(tool, input);
            auditContext.operation = 'changeCategory';
            auditContext.targetReferenceHash = this.referenceHash(
              request.transactionRef
            );
            auditContext.provenance = 'viaMonarch';
            return this.prepare(
              tool,
              request.transactionRef,
              request.categoryRef,
              auditContext,
              context,
              signal
            );
          }
          if (tool === 'finance_prepare_kid_assignment') {
            const request = parseInput(tool, input);
            auditContext.operation = 'assignKid';
            auditContext.targetReferenceHash = this.referenceHash(
              request.transactionRef
            );
            auditContext.provenance = 'derivedByTyrion';
            return this.prepare(
              tool,
              request.transactionRef,
              request.kidRef,
              auditContext,
              context,
              signal
            );
          }
          const request = parseInput(tool, input);
          const result = await this.execute(
            request.proposalToken,
            auditContext,
            context,
            signal,
            execution
          );
          return result;
        },
        context.signal,
        this.timeoutMs
      );
    } catch (error) {
      const safeError = normalizeError(
        error,
        context.signal,
        execution.phase
      );
      try {
        await this.writeAudit(
          context,
          tool,
          auditContext,
          ERROR_OUTCOMES[safeError.code]
        );
      } catch {
        if (execution.phase !== 'none') {
          throw new FinanceMutationError('audit_failed');
        }
        throw new FinanceMutationError('service_unavailable');
      }
      throw safeError;
    }
  }

  private async prepare(
    tool:
      | 'finance_prepare_category_change'
      | 'finance_prepare_kid_assignment',
    transactionRef: string,
    desiredRef: string,
    auditContext: AuditContext,
    context: FinanceMutationContext,
    signal: AbortSignal
  ): Promise<FinanceMutationPrepareResult> {
    const state = await this.current(transactionRef, signal);
    const operation =
      tool === 'finance_prepare_category_change'
        ? 'changeCategory'
        : 'assignKid';
    const oldValue =
      operation === 'changeCategory' ? state.category : state.kid;
    const desiredValue = await this.resolveValue(operation, desiredRef, signal);
    if (oldValue?.ref === desiredValue.ref) {
      throw new FinanceMutationError('invalid_input');
    }

    const proposedAt = this.clock();
    const expiresAt = new Date(
      proposedAt.getTime() + this.proposalTtlMs
    ).toISOString();
    const proposalToken = this.tokenFactory();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(proposalToken)) {
      throw new FinanceMutationError('service_unavailable');
    }
    const proposal: StoredFinanceMutationProposal = {
      tokenDigest: tokenDigest(proposalToken),
      householdScope: this.householdScope,
      actorId: context.actorId,
      operation,
      transactionRef,
      oldValue,
      newValue: desiredValue,
      categoryVersion: state.categoryVersion,
      attributionStateVersion: state.attributionStateVersion,
      proposedAt: proposedAt.toISOString(),
      expiresAt,
      provenance:
        operation === 'changeCategory' ? 'viaMonarch' : 'derivedByTyrion',
    };
    auditContext.proposedAt = proposal.proposedAt;
    await this.proposals.createInactive(proposal, signal);
    await this.writeAudit(context, tool, auditContext, 'prepared');
    if (!(await this.proposals.activate(proposal.tokenDigest, signal))) {
      throw new FinanceMutationError('service_unavailable');
    }
    return {
      tool,
      proposal: {
        proposalToken,
        operation,
        transactionRef,
        oldValue,
        newValue: desiredValue,
        proposedAt: proposal.proposedAt,
        expiresAt,
        provenance: proposal.provenance,
      },
    };
  }

  private async execute(
    proposalToken: string,
    auditContext: AuditContext,
    context: FinanceMutationContext,
    signal: AbortSignal,
    execution: { phase: ExecutionPhase }
  ): Promise<FinanceMutationExecuteResult> {
    const claim = await this.proposals.claim(
      tokenDigest(proposalToken),
      this.householdScope,
      context.actorId,
      this.clock().toISOString(),
      signal
    );
    if (claim.status !== 'claimed') {
      throw new FinanceMutationError(
        claim.status === 'expired'
          ? 'proposal_expired'
          : claim.status === 'used'
            ? 'proposal_used'
            : 'proposal_not_found'
      );
    }
    const proposal = claim.proposal;
    if (
      proposal.householdScope !== this.householdScope ||
      proposal.actorId !== context.actorId
    ) {
      throw new FinanceMutationError('proposal_not_found');
    }
    auditContext.operation = proposal.operation;
    auditContext.targetReferenceHash = this.referenceHash(
      proposal.transactionRef
    );
    auditContext.proposedAt = proposal.proposedAt;
    auditContext.provenance = proposal.provenance;

    const current = await this.current(proposal.transactionRef, signal);
    this.verifyUnchanged(proposal, current);
    execution.phase = 'writing';
    if (proposal.operation === 'changeCategory') {
      await this.data.changeCategory(
        this.householdScope,
        proposal.transactionRef,
        proposal.newValue.ref,
        proposal.oldValue?.ref ?? null,
        proposal.categoryVersion,
        signal
      );
    } else {
      await this.data.assignKid(
        this.householdScope,
        context.actorId,
        proposal.transactionRef,
        proposal.newValue.ref,
        proposal.attributionStateVersion,
        proposal.tokenDigest,
        signal
      );
    }
    execution.phase = 'written';

    const verified = await this.current(proposal.transactionRef, signal);
    const actual =
      proposal.operation === 'changeCategory'
        ? verified.category
        : verified.kid;
    if (
      actual?.ref !== proposal.newValue.ref ||
      (proposal.operation === 'assignKid' &&
        verified.attributionStateVersion <= proposal.attributionStateVersion)
    ) {
      throw new FinanceMutationError('verification_failed');
    }
    execution.phase = 'verified';
    try {
      await this.data.reconcileProjection(
        this.householdScope,
        proposal.operation,
        verified,
        signal
      );
    } catch {
      throw new FinanceMutationError('reconciliation_failed');
    }
    execution.phase = 'reconciled';
    const executedAt = this.clock().toISOString();
    await this.writeAudit(context, 'finance_execute_mutation', auditContext, 'succeeded');
    return {
      tool: 'finance_execute_mutation',
      operation: proposal.operation,
      transactionRef: proposal.transactionRef,
      value: actual,
      executedAt,
      provenance: proposal.provenance,
    };
  }

  private async current(
    transactionRef: string,
    signal: AbortSignal
  ): Promise<FinanceMutationCurrentState> {
    const raw = await this.data.readCurrent(
      this.householdScope,
      transactionRef,
      signal
    );
    if (raw === null) throw new FinanceMutationError('target_not_found');
    const parsed = financeMutationCurrentStateSchema.safeParse(raw);
    if (!parsed.success || parsed.data.transactionRef !== transactionRef) {
      throw new FinanceMutationError('service_unavailable');
    }
    if (parsed.data.connectorState !== 'connected') {
      throw new FinanceMutationError(
        parsed.data.connectorState === 'unauthenticated' ||
          parsed.data.connectorState === 'expired'
          ? 'connector_authorization_failed'
          : 'connector_unavailable'
      );
    }
    return parsed.data;
  }

  private async resolveValue(
    operation: FinanceMutationOperation,
    desiredRef: string,
    signal: AbortSignal
  ): Promise<FinanceMutationValue> {
    const raw =
      operation === 'changeCategory'
        ? await this.data.resolveCategory(
            this.householdScope,
            desiredRef,
            signal
          )
        : await this.data.resolveKid(this.householdScope, desiredRef, signal);
    const parsed = financeMutationValueSchema.safeParse(raw);
    if (!parsed.success || parsed.data.ref !== desiredRef) {
      throw new FinanceMutationError('target_not_found');
    }
    return parsed.data;
  }

  private verifyUnchanged(
    proposal: StoredFinanceMutationProposal,
    current: FinanceMutationCurrentState
  ): void {
    const expectedRef = proposal.oldValue?.ref ?? null;
    if (proposal.operation === 'changeCategory') {
      if (
        (current.category?.ref ?? null) !== expectedRef ||
        current.categoryVersion !== proposal.categoryVersion
      ) {
        throw new FinanceMutationError('stale_state');
      }
      return;
    }
    if (
      (current.kid?.ref ?? null) !== expectedRef ||
      current.attributionStateVersion !== proposal.attributionStateVersion
    ) {
      throw new FinanceMutationError('stale_state');
    }
  }

  private authorize(context: FinanceMutationContext): void {
    if (
      context.householdScope !== this.householdScope ||
      !context.permissions.has('finance:mutate')
    ) {
      throw new FinanceMutationError('permission_denied');
    }
    if (
      !validIdentifier(context.requestId) ||
      !validIdentifier(context.actorId)
    ) {
      throw new FinanceMutationError('invalid_input');
    }
  }

  private referenceHash(reference: string): string {
    return `hmac-sha256:${createHmac('sha256', this.referenceHashKey)
      .update(reference)
      .digest('hex')}`;
  }

  private async writeAudit(
    context: FinanceMutationContext,
    tool: FinanceMutationToolName,
    details: AuditContext,
    outcome: FinanceMutationAuditOutcome
  ): Promise<void> {
    await withDeadline(
      (signal) =>
        this.audit.record(
          {
            auditId: this.auditId(context.requestId, tool),
            requestId: validIdentifier(context.requestId)
              ? context.requestId
              : 'invalid-request',
            householdScope: this.householdScope,
            actorId: validIdentifier(context.actorId)
              ? context.actorId
              : 'invalid-actor',
            tool,
            operation: details.operation,
            targetReferenceHash: details.targetReferenceHash,
            proposedAt: details.proposedAt,
            occurredAt: this.clock().toISOString(),
            outcome,
            provenance: details.provenance,
          },
          signal
        ),
      undefined,
      this.auditTimeoutMs
    );
  }

  private auditId(requestId: string, tool: FinanceMutationToolName): string {
    return `mutation-audit-v1:${createHmac(
      'sha256',
      this.referenceHashKey
    )
      .update(
        JSON.stringify([
          this.householdScope,
          validIdentifier(requestId) ? requestId : 'invalid-request',
          tool,
        ])
      )
      .digest('hex')}`;
  }
}

function parseInput<N extends FinanceMutationToolName>(
  tool: N,
  input: unknown
): z.output<(typeof financeMutationToolInputSchemas)[N]> {
  const parsed = financeMutationToolInputSchemas[tool].safeParse(input);
  if (!parsed.success) throw new FinanceMutationError('invalid_input');
  return parsed.data as z.output<(typeof financeMutationToolInputSchemas)[N]>;
}

function tokenDigest(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
}

function normalizeError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  executionPhase: ExecutionPhase
): FinanceMutationError {
  if (executionPhase === 'reconciled') {
    return new FinanceMutationError('audit_failed');
  }
  if (executionPhase === 'verified') {
    return new FinanceMutationError('reconciliation_failed');
  }
  if (executionPhase === 'written') {
    return new FinanceMutationError('verification_failed');
  }
  if (
    error instanceof FinanceMutationError &&
    (error.code !== 'cancelled' || executionPhase === 'none')
  ) {
    return error;
  }
  if (error instanceof FinanceMutationAdapterError) {
    const code: Record<
      FinanceMutationAdapterError['code'],
      FinanceMutationErrorCode
    > = {
      not_found: 'target_not_found',
      conflict: 'stale_state',
      authorization_failed: 'connector_authorization_failed',
      rejected: 'mutation_rejected',
      unavailable: 'connector_unavailable',
    };
    return new FinanceMutationError(code[error.code]);
  }
  if (executionPhase === 'writing') {
    return new FinanceMutationError('verification_failed');
  }
  if (callerSignal?.aborted) return new FinanceMutationError('cancelled');
  if (error instanceof DeadlineError) {
    return new FinanceMutationError('timed_out');
  }
  return new FinanceMutationError('service_unavailable');
}

class DeadlineError extends Error {}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    if (callerSignal?.aborted) controller.abort();
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () =>
            reject(
              timedOut || !callerSignal?.aborted
                ? new DeadlineError()
                : new FinanceMutationError('cancelled')
            ),
          { once: true }
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}
