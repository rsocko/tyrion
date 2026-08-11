export const ROBUST_STATISTICS_METHOD_VERSION_V1 =
  'integer-median-mad-rank-ratio-v1' as const;

export const SCALED_MAD_FACTOR_V1 = Object.freeze({
  numerator: 14_826n,
  denominator: 10_000n,
});

export interface RationalV1 {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface RobustComparisonV1 {
  readonly sampleCount: number;
  readonly median: RationalV1;
  readonly medianMinor: number;
  readonly scaledMad: RationalV1;
  readonly scaledMadMinor: number;
  readonly expectedLowerMinor: number;
  readonly expectedUpperMinor: number;
  readonly empiricalPercentileBasisPoints: number;
  readonly ratioBasisPoints: number;
  readonly robustGateMet: boolean;
  readonly percentileGateMet: boolean;
  readonly ratioGateMet: boolean;
  readonly triggered: boolean;
  readonly reinforced: boolean;
}

export interface RobustComparisonPolicyV1 {
  readonly robustDeviationMultiplierMilli: number;
  readonly minimumSpreadMinor: number;
  readonly empiricalPercentileGateBasisPoints: number;
  readonly ratioGateBasisPoints: number;
}

export function compareRobustlyV1(
  observedMinor: number,
  samplesMinor: readonly number[],
  policy: RobustComparisonPolicyV1
): RobustComparisonV1 {
  requireNonNegativeSafeInteger(observedMinor, 'observedMinor');
  for (const sample of samplesMinor) {
    requireNonNegativeSafeInteger(sample, 'sample');
  }
  if (samplesMinor.length === 0) {
    throw new RangeError('Robust comparison requires at least one sample');
  }

  const samples = samplesMinor.map(integerRational);
  const median = medianRationalV1(samples);
  const deviations = samples.map((sample) => absolute(subtract(sample, median)));
  const mad = medianRationalV1(deviations);
  const scaledMad = multiply(
    mad,
    rational(
      SCALED_MAD_FACTOR_V1.numerator,
      SCALED_MAD_FACTOR_V1.denominator
    )
  );
  const configuredSpread = multiply(
    scaledMad,
    rational(BigInt(policy.robustDeviationMultiplierMilli), 1_000n)
  );
  const spread = maximum(
    configuredSpread,
    integerRational(policy.minimumSpreadMinor)
  );
  const expectedUpper = add(median, spread);
  const expectedLower = maximum(subtract(median, spread), integerRational(0));
  const observed = integerRational(observedMinor);
  const percentileNumerator = samples.reduce(
    (count, sample) => count + (compare(sample, observed) <= 0 ? 1 : 0),
    0
  );
  const empiricalPercentileBasisPoints = Number(
    (BigInt(percentileNumerator) * 10_000n) / BigInt(samples.length)
  );
  const ratioExact =
    median.numerator === 0n
      ? null
      : rational(
          BigInt(observedMinor) * median.denominator * 10_000n,
          median.numerator
        );
  const ratioBasisPoints =
    ratioExact === null
      ? 1_000_000
      : clampBasisPoints(floorRationalBigInt(ratioExact));
  const robustGateMet = compare(observed, expectedUpper) >= 0;
  const percentileGateMet =
    empiricalPercentileBasisPoints >= policy.empiricalPercentileGateBasisPoints;
  const ratioGateMet =
    median.numerator === 0n ||
    BigInt(observedMinor) * median.denominator * 10_000n >=
      median.numerator * BigInt(policy.ratioGateBasisPoints);
  const gatesMet = [robustGateMet, percentileGateMet, ratioGateMet].filter(
    Boolean
  ).length;

  return {
    sampleCount: samples.length,
    median,
    medianMinor: roundRationalV1(median),
    scaledMad,
    scaledMadMinor: roundRationalV1(scaledMad),
    expectedLowerMinor: floorRationalV1(expectedLower),
    expectedUpperMinor: ceilRationalV1(expectedUpper),
    empiricalPercentileBasisPoints,
    ratioBasisPoints,
    robustGateMet,
    percentileGateMet,
    ratioGateMet,
    triggered: gatesMet === 3,
    reinforced: gatesMet === 2,
  };
}

export function medianRationalV1(values: readonly RationalV1[]): RationalV1 {
  if (values.length === 0) {
    throw new RangeError('Median requires at least one value');
  }
  const ordered = [...values].sort(compare);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle]!;
  return divide(add(ordered[middle - 1]!, ordered[middle]!), 2n);
}

export function roundRationalV1(value: RationalV1): number {
  if (value.numerator < 0n) {
    return -roundRationalV1({
      numerator: -value.numerator,
      denominator: value.denominator,
    });
  }
  return safeBigIntToNumber(
    (value.numerator * 2n + value.denominator) /
      (value.denominator * 2n)
  );
}

export function floorRationalV1(value: RationalV1): number {
  const quotient = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  return safeBigIntToNumber(
    value.numerator < 0n && remainder !== 0n ? quotient - 1n : quotient
  );
}

export function ceilRationalV1(value: RationalV1): number {
  const quotient = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  return safeBigIntToNumber(
    value.numerator > 0n && remainder !== 0n ? quotient + 1n : quotient
  );
}

function integerRational(value: number): RationalV1 {
  return { numerator: BigInt(value), denominator: 1n };
}

function rational(numerator: bigint, denominator: bigint): RationalV1 {
  if (denominator === 0n) throw new RangeError('Rational denominator cannot be zero');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const divisor = greatestCommonDivisor(absoluteBigInt(numerator), denominator);
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
}

function add(left: RationalV1, right: RationalV1): RationalV1 {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function subtract(left: RationalV1, right: RationalV1): RationalV1 {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function multiply(left: RationalV1, right: RationalV1): RationalV1 {
  return rational(
    left.numerator * right.numerator,
    left.denominator * right.denominator
  );
}

function divide(value: RationalV1, divisor: bigint): RationalV1 {
  return rational(value.numerator, value.denominator * divisor);
}

function absolute(value: RationalV1): RationalV1 {
  return {
    numerator: absoluteBigInt(value.numerator),
    denominator: value.denominator,
  };
}

function maximum(left: RationalV1, right: RationalV1): RationalV1 {
  return compare(left, right) >= 0 ? left : right;
}

function compare(left: RationalV1, right: RationalV1): number {
  const difference =
    left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left === 0n ? 1n : left;
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function safeBigIntToNumber(value: bigint): number {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < -maximum || value > maximum) {
    throw new RangeError('Robust statistic exceeds the safe integer range');
  }
  return Number(value);
}

function clampBasisPoints(value: bigint): number {
  return Number(
    value < -1_000_000n
      ? -1_000_000n
      : value > 1_000_000n
        ? 1_000_000n
        : value
  );
}

function floorRationalBigInt(value: RationalV1): bigint {
  const quotient = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  return value.numerator < 0n && remainder !== 0n ? quotient - 1n : quotient;
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
