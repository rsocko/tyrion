import { describe, expect, it } from 'vitest';
import {
  createAttributionInputFromBridgeTransactionV1,
  createAttributionInputsFromBridgePageV1,
  parseNormalizedBridgeTransactionV1,
  type NormalizedBridgeTransactionV1,
} from '../src/bridge-adapter-v1.js';

const bridgeTransaction: NormalizedBridgeTransactionV1 = {
  id: 'bridge-record-demo',
  date: '2026-08-08',
  amount: -12.34,
  merchant: { name: 'Synthetic Shop', logoUrl: null },
  category: { id: 'category-demo', name: 'Synthetic Category' },
  account: {
    id: 'account-demo',
    displayName: 'Synthetic Account',
    mask: '0000',
  },
  isPending: false,
  isRecurring: false,
  notes: 'Source-only note that must not enter attribution input.',
  tags: ['synthetic'],
};

const mappingContext = {
  sourceRef: 'consumer-safe-ref',
  instrumentFingerprint: 'household-fingerprint',
  historicalAttributions: [],
  existingManualDecision: null,
};

describe('normalized bridge v1 attribution adapter', () => {
  it('maps only attribution facts and consumer-safe references', () => {
    const input = createAttributionInputFromBridgeTransactionV1(
      bridgeTransaction,
      {
        householdId: 'household-demo',
        observedAt: '2026-08-08T12:00:00Z',
        ...mappingContext,
      }
    );
    expect(input).toEqual({
      contractVersion: '1.0',
      householdId: 'household-demo',
      source: {
        system: 'monarch-bridge',
        recordRef: 'consumer-safe-ref',
        observedAt: '2026-08-08T12:00:00Z',
      },
      transaction: {
        merchantName: 'Synthetic Shop',
        instrumentFingerprint: 'household-fingerprint',
        occurredOn: '2026-08-08',
      },
      historicalAttributions: [],
      existingManualDecision: null,
    });
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain(bridgeTransaction.id);
    expect(serialized).not.toContain(bridgeTransaction.account.id);
    expect(serialized).not.toContain(bridgeTransaction.notes);
    expect(serialized).not.toContain(String(bridgeTransaction.amount));
  });

  it('maps a page in order and takes observedAt from bridge provenance', () => {
    const inputs = createAttributionInputsFromBridgePageV1(
      {
        contractVersion: '1.0',
        provenance: {
          provider: 'demo',
          fetchedAt: '2026-08-08T12:00:00Z',
        },
        transactions: [bridgeTransaction],
        total: 1,
        page: { limit: 500, nextCursor: null },
      },
      'household-demo',
      [mappingContext]
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0].source.observedAt).toBe('2026-08-08T12:00:00Z');
  });

  it('rejects bridge contract drift and non-finite amounts', () => {
    expect(() =>
      parseNormalizedBridgeTransactionV1({
        ...bridgeTransaction,
        kidId: 'kid-alpha',
      })
    ).toThrow('unexpected field: kidId');
    expect(() =>
      parseNormalizedBridgeTransactionV1({
        ...bridgeTransaction,
        amount: Number.NaN,
      })
    ).toThrow('amount must be a finite number');
  });

  it('rejects page/context cardinality mismatches', () => {
    expect(() =>
      createAttributionInputsFromBridgePageV1(
        {
          contractVersion: '1.0',
          provenance: {
            provider: 'live',
            fetchedAt: '2026-08-08T12:00:00Z',
          },
          transactions: [bridgeTransaction],
          total: 1,
          page: { limit: 500, nextCursor: null },
        },
        'household-demo',
        []
      )
    ).toThrow('one item per bridge transaction');
  });

  it('rejects record context attempts to override page scope or provenance', () => {
    const contextWithOverrides = {
      ...mappingContext,
      householdId: 'household-override',
      observedAt: '2026-08-07T12:00:00Z',
    };
    expect(() =>
      createAttributionInputsFromBridgePageV1(
        {
          contractVersion: '1.0',
          provenance: {
            provider: 'live',
            fetchedAt: '2026-08-08T12:00:00Z',
          },
          transactions: [bridgeTransaction],
          total: 1,
          page: { limit: 500, nextCursor: null },
        },
        'household-demo',
        [contextWithOverrides]
      )
    ).toThrow('unexpected field: householdId');
  });
});
