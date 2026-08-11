import { z, type ZodType } from 'zod';

export const FINANCE_INSIGHTS_CONTRACT_VERSION = '1.0' as const;
export const MAX_AMOUNT_MINOR_V1 = 9_000_000_000_000;
export const MAX_REQUEST_BYTES_V1 = 256 * 1024;

const RESERVED_IDENTIFIERS = new Set(['__proto__', 'constructor', 'prototype']);
const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const SUPPORTED_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));
const UTC_TIMESTAMP_PATTERN =
  /^(?:\d{4})-(?:\d{2})-(?:\d{2})T(?:\d{2}):(?:\d{2}):(?:\d{2})(?:\.\d{1,3})?Z$/;

export class FinanceInsightContractValidationError extends Error {
  readonly code = 'invalid_finance_insight_contract';

  constructor(message: string) {
    super(message);
    this.name = 'FinanceInsightContractValidationError';
  }
}

export function parseContractV1<T>(
  schema: ZodType<T>,
  value: unknown,
  label: string
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new FinanceInsightContractValidationError(
    `Invalid ${label}: ${path}${issue?.message ?? 'validation failed'}`
  );
}

function validCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function validUtcTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(
      value
    );
  if (!match) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const normalizedInput = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, '0')}Z`;
  return parsed.toISOString() === normalizedInput;
}

function notReserved(value: string): boolean {
  return !RESERVED_IDENTIFIERS.has(value);
}

export const contractVersionSchema = z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION);
export const positiveSequenceSchema = z.number().int().safe().positive();
export const nonNegativeIntegerSchema = z.number().int().safe().nonnegative();
export const deliveryRevisionSchema = positiveSequenceSchema;
export const sourceSequenceSchema = positiveSequenceSchema;
export const evaluationSequenceSchema = positiveSequenceSchema;

export const calendarDateSchema = z
  .string()
  .length(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO 8601 calendar date')
  .refine(validCalendarDate, 'must be a valid ISO 8601 calendar date');

export const utcTimestampSchema = z
  .string()
  .min(20)
  .max(30)
  .regex(
    UTC_TIMESTAMP_PATTERN,
    'must be a UTC ISO 8601 timestamp ending in Z with millisecond precision'
  )
  .refine(
    validUtcTimestamp,
    'must be a valid UTC ISO 8601 timestamp'
  );

export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'must be an uppercase ISO 4217 currency code')
  .refine(
    (value) => SUPPORTED_CURRENCIES.has(value),
    'must be a supported ISO 4217 currency code'
  );

export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) => value === 'UTC' || SUPPORTED_TIMEZONES.has(value),
    'must be a valid IANA timezone'
  );

export const sourceReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'contains unsupported characters'
  )
  .refine(notReserved, 'contains a reserved value');

export const versionIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'contains unsupported characters');

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'contains unsupported characters'
  )
  .refine(notReserved, 'contains a reserved value');

export const canonicalDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest');

export const keyedDigestSchema = z
  .string()
  .regex(
    /^(?:insight|occurrence|revision|merchant)-v1_[A-Za-z0-9_-]{43}$/,
    'must be a versioned keyed digest'
  );

export const insightIdSchema = z
  .string()
  .regex(/^insight-v1_[A-Za-z0-9_-]{43}$/);
export const occurrenceIdSchema = z
  .string()
  .regex(/^occurrence-v1_[A-Za-z0-9_-]{43}$/);
export const sourceRevisionRefSchema = z
  .string()
  .regex(/^revision-v1_[A-Za-z0-9_-]{43}$/);
export const merchantKeySchema = z
  .string()
  .regex(/^merchant-v1_[A-Za-z0-9_-]{43}$/);

export const amountMinorSchema = z
  .number()
  .int()
  .safe()
  .min(-MAX_AMOUNT_MINOR_V1)
  .max(MAX_AMOUNT_MINOR_V1);

export const nonNegativeAmountMinorSchema = amountMinorSchema.min(0);
export const basisPointsSchema = z.number().int().safe().min(-1_000_000).max(1_000_000);
export const nonNegativeBasisPointsSchema = basisPointsSchema.min(0);

export const normalizedDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/, 'contains control characters');

export const normalizedMerchantNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/, 'contains control characters');

export const normalizedTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/, 'contains control characters');

export const periodSchema = z
  .strictObject({
    start: calendarDateSchema,
    end: calendarDateSchema,
  })
  .superRefine((value, context) => {
    if (value.end < value.start) {
      context.addIssue({
        code: 'custom',
        path: ['end'],
        message: 'must be on or after period start',
      });
    }
  });

export const moneyValueSchema = z.strictObject({
  currency: currencySchema,
  amountMinor: amountMinorSchema,
});

export const expectedMoneyRangeSchema = z
  .strictObject({
    currency: currencySchema,
    lowerMinor: amountMinorSchema,
    upperMinor: amountMinorSchema,
  })
  .superRefine((value, context) => {
    if (value.upperMinor < value.lowerMinor) {
      context.addIssue({
        code: 'custom',
        path: ['upperMinor'],
        message: 'must be greater than or equal to lowerMinor',
      });
    }
  });

export type ContractVersionV1 = typeof FINANCE_INSIGHTS_CONTRACT_VERSION;
export type MoneyValueV1 = z.infer<typeof moneyValueSchema>;
export type ExpectedMoneyRangeV1 = z.infer<typeof expectedMoneyRangeSchema>;
export type PeriodV1 = z.infer<typeof periodSchema>;
