// Synthetic fixture: all people, relationships, records, identifiers, amounts, limits, dates, and entity associations are invented.
import {
  KID_ATTRIBUTION_ENGINE_VERSION,
  TYRION_DOMAIN_CONTRACT_VERSION,
  type AttributionInputV1,
  type PolicyDraftV1,
  type PolicySnapshotV1,
} from '../src/contracts/v1.js';

export const policyDraftFixture: PolicyDraftV1 = {
  timezone: 'America/New_York',
  currency: 'USD',
  kids: [
    { id: 'kid-alpha', displayName: 'Alpha', color: 'blue', active: true },
    { id: 'kid-beta', displayName: 'Beta', color: null, active: true },
  ],
  cardRules: [
    {
      id: 'rule-card-alpha',
      kidId: 'kid-alpha',
      instrumentFingerprint:
        'instrument-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      confidence: 'definite',
      enabled: true,
    },
  ],
  merchantRules: [
    {
      id: 'rule-merchant-beta',
      kidId: 'kid-beta',
      pattern: 'SYNTHETIC SHOP',
      confidence: 'likely',
      enabled: true,
    },
  ],
  limits: [
    { kidId: 'kid-alpha', period: 'daily', amount: 25, currency: 'USD' },
  ],
  exceptionPolicy: {
    limitWarningPercent: 80,
    requireReviewForLikelyAttribution: true,
    notificationSignals: [
      'limit-warning',
      'limit-exceeded',
      'attribution-review',
      'connector-degraded',
    ],
  },
};

export const policyFixture: PolicySnapshotV1 = {
  contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
  engineVersion: KID_ATTRIBUTION_ENGINE_VERSION,
  householdId: 'household-demo',
  policyVersion: 1,
  updatedAt: '2026-08-08T12:00:00Z',
  ...policyDraftFixture,
};

export const inputFixture: AttributionInputV1 = {
  contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
  householdId: 'household-demo',
  source: {
    system: 'monarch-bridge',
    recordRef: 'source-record-demo',
    observedAt: '2026-08-08T12:01:00Z',
  },
  transaction: {
    merchantName: 'Synthetic Shop',
    instrumentFingerprint: null,
    occurredOn: '2026-08-08',
  },
  historicalAttributions: [],
  existingManualDecision: null,
};
