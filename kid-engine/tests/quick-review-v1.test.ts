import { describe, expect, it } from 'vitest';
import {
  QuickReviewValidationError,
  prepareDescriptorInferenceV1,
  prepareVendorResearchV1,
  rankQuickReviewV1,
  suggestMerchantRuleV1,
} from '../src/quick-review-v1.js';

const attribution = {
  status: 'assigned',
  confidence: 'definite',
  reviewStatus: 'none',
} as const;

describe('Quick Review ranking v1', () => {
  it('ranks actionable ambiguity deterministically without returning financial facts', () => {
    const response = rankQuickReviewV1({
      contractVersion: '1.0',
      items: [
        {
          sourceRef: 'source-lower',
          occurredOn: '2026-10-01',
          merchantName: 'Invented Market',
          isPending: false,
          monarchReviewStatus: 'reviewed',
          attribution,
          signals: ['new-merchant'],
        },
        {
          sourceRef: 'source-higher',
          occurredOn: '2026-09-30',
          merchantName: 'Example Cafe',
          isPending: false,
          monarchReviewStatus: 'needs_review',
          attribution: {
            status: 'unassigned',
            confidence: 'unknown',
            reviewStatus: 'needs-review',
          },
          signals: ['payee-ambiguous'],
        },
      ],
    });

    expect(response).toEqual({
      contractVersion: '1.0',
      rankedItems: [
        {
          sourceRef: 'source-higher',
          rank: 1,
          score: 100,
          reasons: [
            'kid-attribution-ambiguous',
            'monarch-needs-review',
            'payee-ambiguous',
          ],
        },
        {
          sourceRef: 'source-lower',
          rank: 2,
          score: 10,
          reasons: ['new-merchant'],
        },
      ],
    });
  });

  it('rejects duplicate references, unknown fields, and oversized batches', () => {
    const item = {
      sourceRef: 'same',
      occurredOn: '2026-10-01',
      merchantName: 'Invented Market',
      isPending: false,
      monarchReviewStatus: 'reviewed',
      attribution,
      signals: [],
    };
    expect(() =>
      rankQuickReviewV1({
        contractVersion: '1.0',
        items: [item, item],
      })
    ).toThrow(QuickReviewValidationError);
    expect(() =>
      rankQuickReviewV1({
        contractVersion: '1.0',
        items: [{ ...item, privateAccount: 'not-accepted' }],
      })
    ).toThrow(QuickReviewValidationError);
    expect(() =>
      rankQuickReviewV1({
        contractVersion: '1.0',
        items: Array.from({ length: 101 }, (_, index) => ({
          ...item,
          sourceRef: `source-${index}`,
        })),
      })
    ).toThrowError(expect.objectContaining({ code: 'batch_too_large' }));
  });
});

describe('vendor research preparation v1', () => {
  it('defaults to normalized vendor and coarse location only', () => {
    expect(
      prepareVendorResearchV1({
        contractVersion: '1.0',
        vendorName: ' Invented   Market ',
        coarseLocation: {
          locality: ' Example City ',
          region: ' Region ',
          countryCode: 'us',
        },
        sensitiveContext: null,
        disclosure: { shown: false, confirmedAt: null },
      })
    ).toEqual({
      contractVersion: '1.0',
      query: {
        vendorName: 'Invented Market',
        coarseLocation: {
          locality: 'Example City',
          region: 'Region',
          countryCode: 'US',
        },
        amount: null,
        occurredOn: null,
      },
      outputPolicy: {
        factsRequireSources: true,
        inferencesMustBeLabeled: true,
        fraudAssertionAllowed: false,
      },
    });
  });

  it('requires visible confirmation before including amount and date', () => {
    const request = {
      contractVersion: '1.0',
      vendorName: 'Invented Market',
      coarseLocation: null,
      sensitiveContext: { amount: -12.34, occurredOn: '2026-10-01' },
      disclosure: { shown: false, confirmedAt: null },
    };
    expect(() => prepareVendorResearchV1(request)).toThrowError(
      expect.objectContaining({ code: 'research_disclosure_required' })
    );
    expect(
      prepareVendorResearchV1({
        ...request,
        disclosure: {
          shown: true,
          confirmedAt: '2026-10-08T12:00:00Z',
        },
      }).query
    ).toMatchObject({ amount: -12.34, occurredOn: '2026-10-01' });
  });

  it('rejects identity and account fields', () => {
    expect(() =>
      prepareVendorResearchV1({
        contractVersion: '1.0',
        vendorName: 'Invented Market',
        coarseLocation: null,
        sensitiveContext: null,
        disclosure: { shown: false, confirmedAt: null },
        accountRef: 'not-accepted',
      })
    ).toThrow(QuickReviewValidationError);
  });

  it('never copies raw descriptors into the public vendor lookup envelope', () => {
    const rawDescriptor = '  INVENTED MARKET #42 / TRENTON, NJ  ';
    const result = prepareVendorResearchV1({
      contractVersion: '1.0',
      vendorName: 'Invented Market',
      coarseLocation: {
        locality: 'Trenton',
        region: 'NJ',
        countryCode: 'US',
      },
      sensitiveContext: null,
      disclosure: { shown: false, confirmedAt: null },
      statementDescriptors: [
        { kind: 'statement', text: rawDescriptor, source: 'monarch' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(rawDescriptor);
  });
});

describe('private descriptor inference preparation v1', () => {
  it('preserves descriptor text exactly in a private-only bounded envelope', () => {
    const text = '  INVENTED MARKET #42 / TRENTON, NJ\t';
    expect(
      prepareDescriptorInferenceV1({
        contractVersion: '1.0',
        descriptors: [{ kind: 'statement', text, source: 'monarch' }],
        requestedAt: '2026-10-08T12:00:00Z',
      })
    ).toMatchObject({
      purpose: 'transaction-location-inference',
      descriptors: [{ text }],
      privacy: { execution: 'private', publicWebLookupAllowed: false },
      expectedOutput: {
        provenanceRequired: true,
        stalenessRequired: true,
      },
    });
  });

  it('rejects oversized descriptors rather than truncating them', () => {
    expect(() =>
      prepareDescriptorInferenceV1({
        contractVersion: '1.0',
        descriptors: [
          { kind: 'statement', text: 'x'.repeat(2_049), source: 'monarch' },
        ],
        requestedAt: '2026-10-08T12:00:00Z',
      })
    ).toThrow(QuickReviewValidationError);
  });
});

describe('merchant rule suggestion v1', () => {
  it('returns an advisory suggestion only when explicitly requested', () => {
    expect(
      suggestMerchantRuleV1({
        contractVersion: '1.0',
        merchantName: ' Invented   Market ',
        kidId: 'kid-invented',
        suggestReusableRule: true,
      })
    ).toEqual({
      contractVersion: '1.0',
      suggestion: {
        kind: 'merchant',
        outcome: 'kid',
        merchantPattern: 'INVENTED MARKET',
        businessEntityPattern: null,
        statementDescriptorPattern: null,
        locationPredicate: null,
        scope: 'global',
        accountRefs: [],
        kidId: 'kid-invented',
        confidence: 'likely',
        requiresConfirmation: true,
        requiresLocationOnlyConfirmation: false,
      },
    });
  });

  it('prefills account and business-entity context when explicitly supplied', () => {
    expect(
      suggestMerchantRuleV1({
        contractVersion: '1.0',
        merchantName: 'Invented Market',
        businessEntityName: 'Invented Holdings',
        accountRef: 'account-invented',
        scope: 'accounts',
        kidId: 'kid-invented',
        suggestReusableRule: true,
      }).suggestion
    ).toMatchObject({
      businessEntityPattern: 'INVENTED HOLDINGS',
      scope: 'accounts',
      accountRefs: ['account-invented'],
    });
  });

  it('accepts optional business-entity context for a global suggestion', () => {
    expect(
      suggestMerchantRuleV1({
        contractVersion: '1.0',
        merchantName: 'Invented Market',
        businessEntityName: 'Invented Holdings',
        kidId: 'kid-invented',
        suggestReusableRule: true,
      }).suggestion
    ).toMatchObject({
      businessEntityPattern: 'INVENTED HOLDINGS',
      scope: 'global',
      accountRefs: [],
    });
  });

    it('suggests a separately confirmed standalone location rule', () => {
      expect(
        suggestMerchantRuleV1({
          contractVersion: '1.0',
          merchantName: 'Invented Market',
          kidId: 'kid-invented',
          suggestReusableRule: true,
          suggestionMode: 'location-only',
          locationEvidence: {
            countryCode: 'us',
            region: 'mi',
            locality: 'Ann Arbor',
            confidence: 0.92,
            sourceKind: 'private-ai-inference',
            model: 'private-location-model',
            modelVersion: '2026-10',
            evaluatedAt: '2026-10-08T12:00:00Z',
            staleAfter: '2026-10-09T12:00:00Z',
          },
          locationMinimumConfidence: 0.85,
        }).suggestion
      ).toMatchObject({
        kind: 'location-only',
        merchantPattern: null,
        locationPredicate: {
          countryCode: 'US',
          region: 'MI',
          locality: 'ANN ARBOR',
          minimumConfidence: 0.85,
        },
        requiresConfirmation: true,
        requiresLocationOnlyConfirmation: true,
      });
  });
});
