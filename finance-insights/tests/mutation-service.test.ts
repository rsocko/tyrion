import { describe, expect, it, vi } from 'vitest';
import {
  FINANCE_MUTATION_TOOL_DEFINITIONS,
  FinanceMutationAdapterError,
  FinanceMutationError,
  FinanceMutationService,
  financeExecuteMutationInputSchema,
  type FinanceMutationAuditEvent,
  type FinanceMutationContext,
  type FinanceMutationCurrentState,
  type FinanceMutationDataPort,
  type FinanceMutationProposalClaim,
  type FinanceMutationProposalStore,
  type StoredFinanceMutationProposal,
} from '../src/mutations/index.js';

const TOKEN = 'a'.repeat(43);
const START = new Date('2026-08-15T01:00:00.000Z');
const CONTEXT: FinanceMutationContext = {
  requestId: 'request-1',
  householdScope: 'household-1',
  actorId: 'operator-1',
  permissions: new Set(['finance:mutate']),
};

class ProposalStore implements FinanceMutationProposalStore {
  private readonly proposals = new Map<
    string,
    {
      proposal: StoredFinanceMutationProposal;
      active: boolean;
      used: boolean;
    }
  >();

  async createInactive(proposal: StoredFinanceMutationProposal): Promise<void> {
    if (this.proposals.has(proposal.tokenDigest)) throw new Error('duplicate');
    this.proposals.set(proposal.tokenDigest, {
      proposal: structuredClone(proposal),
      active: false,
      used: false,
    });
  }

  async activate(tokenDigest: string): Promise<boolean> {
    const stored = this.proposals.get(tokenDigest);
    if (!stored || stored.active) return false;
    stored.active = true;
    return true;
  }

  async claim(
    tokenDigest: string,
    householdScope: string,
    actorId: string,
    claimedAt: string
  ): Promise<FinanceMutationProposalClaim> {
    const stored = this.proposals.get(tokenDigest);
    if (
      !stored ||
      !stored.active ||
      stored.proposal.householdScope !== householdScope ||
      stored.proposal.actorId !== actorId
    ) {
      return { status: 'notFound' };
    }
    if (stored.used) return { status: 'used' };
    stored.used = true;
    if (claimedAt >= stored.proposal.expiresAt) {
      return { status: 'expired' };
    }
    return {
      status: 'claimed',
      proposal: structuredClone(stored.proposal),
    };
  }
}

function current(
  overrides: Partial<FinanceMutationCurrentState> = {}
): FinanceMutationCurrentState {
  return {
    transactionRef: 'transaction-synthetic',
    category: { ref: 'category-old', displayName: 'Old category' },
    categoryVersion: 'source-version-1',
    kid: null,
    attributionStateVersion: 3,
    connectorState: 'connected',
    sourceAsOf: '2026-08-15T00:59:00.000Z',
    ...overrides,
  };
}

function harness(options: {
  clock?: () => Date;
  data?: Partial<FinanceMutationDataPort>;
  timeoutMs?: number;
  failAuditOutcomes?: ReadonlySet<FinanceMutationAuditEvent['outcome']>;
} = {}) {
  let state = current();
  const data: FinanceMutationDataPort = {
    readCurrent: vi.fn(async () => structuredClone(state)),
    resolveCategory: vi.fn(async (_scope, categoryRef) =>
      categoryRef === 'category-new'
        ? { ref: categoryRef, displayName: 'New category' }
        : null
    ),
    resolveKid: vi.fn(async (_scope, kidRef) =>
      kidRef === 'kid-example'
        ? { ref: kidRef, displayName: 'Example kid' }
        : null
    ),
    changeCategory: vi.fn(async (
      _scope,
      _transactionRef,
      categoryRef,
      expectedCategoryRef,
      expectedCategoryVersion
    ) => {
      if (
        state.category?.ref !== expectedCategoryRef ||
        state.categoryVersion !== expectedCategoryVersion
      ) {
        throw new FinanceMutationAdapterError('conflict');
      }
      state = current({
        ...state,
        category: { ref: categoryRef, displayName: 'New category' },
        categoryVersion: 'source-version-2',
      });
    }),
    assignKid: vi.fn(async (_scope, _actor, _transaction, kidRef) => {
      state = current({
        ...state,
        kid: { ref: kidRef, displayName: 'Example kid' },
        attributionStateVersion: state.attributionStateVersion + 1,
      });
    }),
    reconcileProjection: vi.fn(async () => undefined),
    ...options.data,
  };
  const proposals = new ProposalStore();
  const events: FinanceMutationAuditEvent[] = [];
  const audit = {
    record: vi.fn(async (event: FinanceMutationAuditEvent) => {
      if (options.failAuditOutcomes?.has(event.outcome)) {
        throw new Error('synthetic audit failure');
      }
      events.push(event);
    }),
  };
  const service = new FinanceMutationService({
    householdScope: 'household-1',
    proposals,
    data,
    audit,
    referenceHashKey: new TextEncoder().encode('k'.repeat(32)),
    tokenFactory: () => TOKEN,
    clock: options.clock ?? (() => START),
    timeoutMs: options.timeoutMs,
  });
  return {
    service,
    proposals,
    data,
    events,
    setState(next: FinanceMutationCurrentState) {
      state = next;
    },
  };
}

async function prepareCategory(
  service: FinanceMutationService,
  context: FinanceMutationContext = CONTEXT
) {
  return service.invoke(
    'finance_prepare_category_change',
    {
      transactionRef: 'transaction-synthetic',
      categoryRef: 'category-new',
    },
    context
  );
}

describe('Houston finance mutation contracts', () => {
  it('publishes only the reviewed prepare and execute tools', () => {
    expect(FINANCE_MUTATION_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'finance_prepare_category_change',
      'finance_prepare_kid_assignment',
      'finance_execute_mutation',
    ]);
    expect(
      FINANCE_MUTATION_TOOL_DEFINITIONS.every(({ readOnly }) => !readOnly)
    ).toBe(true);
    expect(
      financeExecuteMutationInputSchema.safeParse({
        proposalToken: TOKEN,
        confirm: false,
      }).success
    ).toBe(false);
    expect(
      financeExecuteMutationInputSchema.safeParse({
        proposalToken: TOKEN,
        confirm: true,
        categoryRef: 'unsupported-generic-write',
      }).success
    ).toBe(false);
  });
});

describe('FinanceMutationService', () => {
  it('prepares and executes a verified category change exactly once', async () => {
    const { service, data, events } = harness();
    const prepared = await prepareCategory(service);
    expect(prepared).toEqual({
      tool: 'finance_prepare_category_change',
      proposal: {
        proposalToken: TOKEN,
        operation: 'changeCategory',
        transactionRef: 'transaction-synthetic',
        oldValue: { ref: 'category-old', displayName: 'Old category' },
        newValue: { ref: 'category-new', displayName: 'New category' },
        proposedAt: START.toISOString(),
        expiresAt: '2026-08-15T01:05:00.000Z',
        provenance: 'viaMonarch',
      },
    });

    const executed = await service.invoke(
      'finance_execute_mutation',
      { proposalToken: TOKEN, confirm: true },
      CONTEXT
    );
    expect(executed).toMatchObject({
      tool: 'finance_execute_mutation',
      operation: 'changeCategory',
      value: { ref: 'category-new' },
      provenance: 'viaMonarch',
    });
    expect(data.changeCategory).toHaveBeenCalledTimes(1);
    expect(data.changeCategory).toHaveBeenCalledWith(
      'household-1',
      'transaction-synthetic',
      'category-new',
      'category-old',
      'source-version-1',
      expect.any(AbortSignal)
    );
    expect(data.reconcileProjection).toHaveBeenCalledTimes(1);
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'proposal_used' });
    expect(data.changeCategory).toHaveBeenCalledTimes(1);
    expect(events.map(({ outcome }) => outcome)).toEqual([
      'prepared',
      'succeeded',
      'proposalUsed',
    ]);
    expect(JSON.stringify(events)).not.toContain('transaction-synthetic');
    expect(events[0]?.targetReferenceHash).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(events[0]?.auditId).toMatch(/^mutation-audit-v1:[a-f0-9]{64}$/);
  });

  it('prepares and executes a Tyrion-owned kid assignment', async () => {
    const { service, data } = harness();
    const prepared = await service.invoke(
      'finance_prepare_kid_assignment',
      {
        transactionRef: 'transaction-synthetic',
        kidRef: 'kid-example',
      },
      CONTEXT
    );
    expect(prepared).toMatchObject({
      proposal: {
        operation: 'assignKid',
        oldValue: null,
        newValue: { ref: 'kid-example', displayName: 'Example kid' },
        provenance: 'derivedByTyrion',
      },
    });
    const executed = await service.invoke(
      'finance_execute_mutation',
      { proposalToken: TOKEN, confirm: true },
      CONTEXT
    );
    expect(executed).toMatchObject({
      operation: 'assignKid',
      value: { ref: 'kid-example' },
      provenance: 'derivedByTyrion',
    });
    expect(data.assignKid).toHaveBeenCalledWith(
      'household-1',
      'operator-1',
      'transaction-synthetic',
      'kid-example',
      3,
      expect.stringMatching(/^sha256:/),
      expect.any(AbortSignal)
    );
  });

  it('requires authorization before reading state or claiming a proposal', async () => {
    const { service, data, events } = harness();
    await expect(
      prepareCategory(service, {
        ...CONTEXT,
        permissions: new Set(),
      })
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(data.readCurrent).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      outcome: 'permissionDenied',
      operation: null,
      targetReferenceHash: null,
    });
  });

  it('rejects expiry and consumes the expired proposal', async () => {
    let now = START;
    const { service, data } = harness({ clock: () => now });
    await prepareCategory(service);
    now = new Date('2026-08-15T01:05:00.000Z');
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'proposal_expired' });
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'proposal_used' });
    expect(data.changeCategory).not.toHaveBeenCalled();
  });

  it('rejects concurrent source state changes before writing', async () => {
    const { service, data, setState } = harness();
    await prepareCategory(service);
    setState(
      current({
        category: { ref: 'category-other', displayName: 'Other category' },
        categoryVersion: 'source-version-2',
      })
    );
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'stale_state' });
    expect(data.changeCategory).not.toHaveBeenCalled();
  });

  it('fails closed when the connector is degraded or requires authentication', async () => {
    for (const [connectorState, code] of [
      ['degraded', 'connector_unavailable'],
      ['expired', 'connector_authorization_failed'],
    ] as const) {
      const { service, setState } = harness();
      setState(current({ connectorState }));
      await expect(prepareCategory(service)).rejects.toMatchObject({ code });
    }
  });

  it('reports an adapter rejection without advancing the projection', async () => {
    const changeCategory = vi.fn(async () => {
      throw new FinanceMutationAdapterError('rejected');
    });
    const { service, data } = harness({ data: { changeCategory } });
    await prepareCategory(service);
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'mutation_rejected' });
    expect(data.reconcileProjection).not.toHaveBeenCalled();
  });

  it('reports a read-back mismatch without advancing the projection', async () => {
    const changeCategory = vi.fn(async () => undefined);
    const { service, data } = harness({ data: { changeCategory } });
    await prepareCategory(service);
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'verification_failed' });
    expect(data.reconcileProjection).not.toHaveBeenCalled();
  });

  it('reports post-write source failures as verification failures', async () => {
    let reads = 0;
    const readCurrent = vi.fn(async () => {
      reads += 1;
      if (reads >= 3) {
        throw new FinanceMutationAdapterError('authorization_failed');
      }
      return current();
    });
    const changeCategory = vi.fn(async () => undefined);
    const { service, events } = harness({
      data: { readCurrent, changeCategory },
    });
    await prepareCategory(service);
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'verification_failed' });
    expect(events.at(-1)?.outcome).toBe('verificationFailed');
  });

  it('reports post-write cancellation as unverifiable instead of cancelled', async () => {
    const controller = new AbortController();
    const changeCategory = vi.fn(async () => {
      controller.abort();
    });
    const { service, events } = harness({ data: { changeCategory } });
    await prepareCategory(service);
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        { ...CONTEXT, signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: 'verification_failed' });
    expect(events.at(-1)?.outcome).toBe('verificationFailed');
    expect(events.at(-1)?.outcome).not.toBe('cancelled');
  });

  it('reports partial success when local projection reconciliation fails', async () => {
    const reconcileProjection = vi.fn(async () => {
      throw new Error('synthetic persistence failure');
    });
    const { service, events } = harness({ data: { reconcileProjection } });
    await prepareCategory(service);
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        CONTEXT
      )
    ).rejects.toMatchObject({
      code: 'reconciliation_failed',
      message: 'The finance mutation succeeded but local reconciliation failed.',
    });
    expect(events.at(-1)?.outcome).toBe('reconciliationFailed');
    expect(JSON.stringify(events)).not.toContain('synthetic persistence failure');
  });

  it('reports a post-reconciliation audit failure truthfully', async () => {
    const { service, events } = harness({
      failAuditOutcomes: new Set(['succeeded']),
    });
    await prepareCategory(service);
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        CONTEXT
      )
    ).rejects.toMatchObject({ code: 'audit_failed' });
    expect(events.at(-1)?.outcome).toBe('auditFailed');
  });

  it('cancels an in-flight prepare operation and audits a safe outcome', async () => {
    let internalSignal: AbortSignal | undefined;
    const readCurrent = vi.fn(
      async (_scope: string, _target: string, signal: AbortSignal) =>
        new Promise<FinanceMutationCurrentState | null>((resolve) => {
          internalSignal = signal;
          signal.addEventListener('abort', () => resolve(null), { once: true });
        })
    );
    const { service, events } = harness({ data: { readCurrent } });
    const controller = new AbortController();
    const pending = prepareCategory(service, {
      ...CONTEXT,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(internalSignal?.aborted).toBe(true);
    expect(events[0]?.outcome).toBe('cancelled');
  });

  it('times out an unresponsive adapter and returns no success shape', async () => {
    const readCurrent = vi.fn(
      async () => new Promise<FinanceMutationCurrentState | null>(() => undefined)
    );
    const { service, events } = harness({
      data: { readCurrent },
      timeoutMs: 5,
    });
    await expect(prepareCategory(service)).rejects.toMatchObject({
      code: 'timed_out',
    });
    expect(events[0]?.outcome).toBe('timedOut');
  });

  it('binds proposal claims to the preparing household and actor', async () => {
    const { service, data } = harness();
    await prepareCategory(service);
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        { ...CONTEXT, actorId: 'operator-2' }
      )
    ).rejects.toMatchObject({ code: 'proposal_not_found' });
    expect(data.changeCategory).not.toHaveBeenCalled();
    await expect(
      service.invoke(
        'finance_execute_mutation',
        { proposalToken: TOKEN, confirm: true },
        CONTEXT
      )
    ).resolves.toMatchObject({ operation: 'changeCategory' });
  });

  it('sanitizes arbitrary adapter failures and never audits exception text', async () => {
    const readCurrent = vi.fn(async () => {
      throw new Error('raw private upstream response');
    });
    const { service, events } = harness({ data: { readCurrent } });
    await expect(prepareCategory(service)).rejects.toBeInstanceOf(
      FinanceMutationError
    );
    await expect(prepareCategory(service)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(JSON.stringify(events)).not.toContain('raw private upstream response');
  });
});
