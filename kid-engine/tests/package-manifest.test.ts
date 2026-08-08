import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  version: string;
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  publishConfig: {
    registry: string;
    access: string;
  };
  exports: Record<string, unknown>;
  files: string[];
}

describe('published package manifest', () => {
  it('pins the supported GitHub Packages distribution contract', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as PackageManifest;
    expect(manifest).toMatchObject({
      name: '@rsocko/tyrion-kid-engine',
      version: '1.0.0',
      repository: {
        type: 'git',
        url: 'git+https://github.com/rsocko/tyrion.git',
        directory: 'kid-engine',
      },
      publishConfig: {
        registry: 'https://npm.pkg.github.com',
        access: 'restricted',
      },
      files: ['dist'],
    });
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './contracts/v1',
      './policy',
    ]);
  });
});
