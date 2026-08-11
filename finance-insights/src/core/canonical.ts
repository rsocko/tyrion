import { createHash } from 'node:crypto';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export function canonicalizeV1(value: CanonicalJsonValue): string {
  return serialize(value);
}

export function canonicalDigestV1(value: CanonicalJsonValue): string {
  return `sha256:${createHash('sha256').update(canonicalizeV1(value)).digest('hex')}`;
}

export function normalizeIdentityTextV1(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function serialize(value: CanonicalJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError('Canonical numbers must be finite safe integers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`;
  }
  const object = value as { readonly [key: string]: CanonicalJsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(object[key]!)}`)
    .join(',')}}`;
}
