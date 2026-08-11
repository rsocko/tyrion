import { readFile } from 'node:fs/promises';

// Every fixture under fixtures/v1 is invented and must never be replaced with live data.
export async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../fixtures/v1/${name}.json`, import.meta.url), 'utf8')
  );
}

export function cloneFixture<T>(value: T): T {
  return structuredClone(value);
}
