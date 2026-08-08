import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const consumerRoot = await mkdtemp(resolve(tmpdir(), 'tyrion-package-consumer-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) fail('npm CLI path is unavailable');

try {
  const consumerManifest = {
    name: 'tyrion-package-consumer-verification',
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@rsocko/tyrion-kid-engine': '1.0.0',
    },
  };
  await writeFile(
    resolve(consumerRoot, 'package.json'),
    JSON.stringify(consumerManifest),
    'utf8'
  );
  runNpm(['pack', '--pack-destination', consumerRoot], packageRoot);
  const archives = (await readdir(consumerRoot)).filter((name) =>
    name.endsWith('.tgz')
  );
  if (archives.length !== 1) fail('package archive was not created');
  runNpm(
    [
      'install',
      '--no-save',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      resolve(consumerRoot, archives[0]),
    ],
    consumerRoot
  );
  const persistedManifest = JSON.parse(
    await readFile(resolve(consumerRoot, 'package.json'), 'utf8')
  );
  if (
    persistedManifest.dependencies?.['@rsocko/tyrion-kid-engine'] !== '1.0.0'
  ) {
    fail('consumer dependency declaration changed');
  }
  const installedManifest = JSON.parse(
    await readFile(
      resolve(
        consumerRoot,
        'node_modules',
        '@rsocko',
        'tyrion-kid-engine',
        'package.json'
      ),
      'utf8'
    )
  );
  if (installedManifest.version !== '1.0.0') {
    fail('installed package version did not match the exact declaration');
  }
  await writeFile(
    resolve(consumerRoot, 'verify.mjs'),
    [
      "import { createAttributionInputsFromBridgePageV1 } from '@rsocko/tyrion-kid-engine';",
      "import { parsePolicySnapshotV1 } from '@rsocko/tyrion-kid-engine/contracts/v1';",
      "import { PolicyService } from '@rsocko/tyrion-kid-engine/policy';",
      'if ([createAttributionInputsFromBridgePageV1, parsePolicySnapshotV1, PolicyService].some((value) => value === undefined)) {',
      "  throw new Error('public package exports are incomplete');",
      '}',
    ].join('\n'),
    'utf8'
  );
  run(process.execPath, ['verify.mjs'], consumerRoot);
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
}

function run(command, arguments_, cwd) {
  try {
    execFileSync(command, arguments_, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, NPM_CONFIG_LOGLEVEL: 'error' },
    });
  } catch {
    fail('clean consumer command failed');
  }
}

function runNpm(arguments_, cwd) {
  run(process.execPath, [npmCli, ...arguments_], cwd);
}

function fail(message) {
  throw new Error(message);
}
