import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  publishConfig?: unknown;
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
}

describe('internal package manifest', () => {
  it('cannot be published while preserving Tyrion-internal entry points', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as PackageManifest;
    expect(manifest).toMatchObject({
      name: '@rsocko/tyrion-kid-engine',
      version: '1.0.0',
      private: true,
    });
    expect(manifest.publishConfig).toBeUndefined();
    expect(manifest.scripts.prepack).toBeUndefined();
    expect(manifest.scripts['test:consumer']).toBeUndefined();
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './contracts/v1',
      './policy',
    ]);
  });
});
