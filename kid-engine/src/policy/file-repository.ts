import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  TYRION_DOMAIN_CONTRACT_VERSION,
  parsePolicyAuditEventV1,
  parsePolicySnapshotV1,
  type PolicyAuditEventV1,
  type PolicySnapshotV1,
} from '../contracts/v1.js';
import {
  PolicyVersionConflictError,
  type PolicyRepository,
} from './service.js';

const STORAGE_VERSION = 1;
const MAX_STORE_BYTES = 5 * 1024 * 1024;

interface StoredPolicies {
  storageVersion: typeof STORAGE_VERSION;
  policies: Record<string, PolicySnapshotV1>;
  audit: PolicyAuditEventV1[];
}

export class FilePolicyRepository implements PolicyRepository {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(filePath: string) {
    if (!isAbsolute(filePath)) {
      throw new PolicyStoreConfigurationError(
        'Policy store path must be absolute and external to the application checkout'
      );
    }
    const resolved = resolve(filePath);
    if (isWithin(resolve(process.cwd()), resolved)) {
      throw new PolicyStoreConfigurationError(
        'Policy store path must be external to the application checkout'
      );
    }
    this.filePath = resolved;
    this.lockPath = `${resolved}.lock`;
  }

  async load(householdId: string): Promise<PolicySnapshotV1 | null> {
    const store = await this.readStore();
    const snapshot = Object.hasOwn(store.policies, householdId)
      ? store.policies[householdId]
      : undefined;
    return snapshot ? structuredClone(snapshot) : null;
  }

  async save(
    snapshot: PolicySnapshotV1,
    expectedPolicyVersion: number | null,
    auditEvent: PolicyAuditEventV1
  ): Promise<void> {
    const parsed = parsePolicySnapshotV1(snapshot);
    const parsedAuditEvent = parsePolicyAuditEventV1(auditEvent);
    await this.withLock(async () => {
      const store = await this.readStore();
      const currentVersion =
        store.policies[parsed.householdId]?.policyVersion ?? null;
      if (currentVersion !== expectedPolicyVersion) {
        throw new PolicyVersionConflictError();
      }
      validateAuditEvent(parsedAuditEvent, parsed, expectedPolicyVersion);
      store.policies[parsed.householdId] = parsed;
      store.audit.push(parsedAuditEvent);
      await this.writeStore(store);
    });
  }

  async listAudit(householdId: string): Promise<PolicyAuditEventV1[]> {
    const store = await this.readStore();
    return store.audit
      .filter((event) => event.householdId === householdId)
      .map((event) => structuredClone(event));
  }

  async withPolicyVersionFence<T>(
    householdId: string,
    expectedPolicyVersion: number,
    operation: () => Promise<T>
  ): Promise<T | null> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.filePath, {
        realpath: false,
        lockfilePath: this.lockPath,
        stale: 10_000,
        update: 2_000,
        retries: 0,
      });
    } catch (error) {
      if (nodeErrorCode(error) === 'ELOCKED') throw new PolicyStoreBusyError();
      throw new PolicyStoreUnavailableError();
    }
    try {
      const current = await this.readStore();
      if (
        current.policies[householdId]?.policyVersion !== expectedPolicyVersion
      ) {
        return null;
      }
      return await operation();
    } finally {
      try {
        await release();
      } catch {
        throw new PolicyStoreUnavailableError();
      }
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.filePath, {
        realpath: false,
        lockfilePath: this.lockPath,
        stale: 10_000,
        update: 2_000,
        retries: 0,
      });
      return await operation();
    } catch (error) {
      if (nodeErrorCode(error) === 'ELOCKED') {
        throw new PolicyStoreBusyError();
      }
      if (
        error instanceof PolicyVersionConflictError ||
        error instanceof PolicyStoreCorruptError ||
        error instanceof PolicyStoreCapacityError
      ) {
        throw error;
      }
      throw new PolicyStoreUnavailableError();
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          throw new PolicyStoreUnavailableError();
        }
      }
    }
  }

  private async readStore(): Promise<StoredPolicies> {
    try {
      const metadata = await stat(this.filePath);
      if (metadata.size > MAX_STORE_BYTES) throw new PolicyStoreCorruptError();
      const raw = await readFile(this.filePath, 'utf8');
      return parseStoredPolicies(raw);
    } catch (error) {
      if (error instanceof PolicyStoreCorruptError) throw error;
      if (nodeErrorCode(error) === 'ENOENT') {
        return { storageVersion: STORAGE_VERSION, policies: {}, audit: [] };
      }
      throw new PolicyStoreUnavailableError();
    }
  }

  private async writeStore(store: StoredPolicies): Promise<void> {
    const directory = dirname(this.filePath);
    const temporaryPath = resolve(
      directory,
      `.${basename(this.filePath)}.${randomUUID()}.tmp`
    );
    const payload = JSON.stringify(store);
    if (Buffer.byteLength(payload, 'utf8') > MAX_STORE_BYTES) {
      throw new PolicyStoreCapacityError();
    }
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporaryPath, payload, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (nodeErrorCode(cleanupError) !== 'ENOENT') {
          throw new PolicyStoreUnavailableError();
        }
      }
      throw new PolicyStoreUnavailableError();
    }
  }
}

export class PolicyStoreConfigurationError extends Error {
  readonly code = 'policy_store_invalid_configuration';

  constructor(message: string) {
    super(message);
    this.name = 'PolicyStoreConfigurationError';
  }
}

export class PolicyStoreBusyError extends Error {
  readonly code = 'policy_store_busy';

  constructor() {
    super('Policy store is processing another mutation');
    this.name = 'PolicyStoreBusyError';
  }
}

export class PolicyStoreUnavailableError extends Error {
  readonly code = 'policy_store_unavailable';

  constructor() {
    super('Policy store is unavailable');
    this.name = 'PolicyStoreUnavailableError';
  }
}

export class PolicyStoreCorruptError extends Error {
  readonly code = 'policy_store_corrupt';

  constructor() {
    super('Policy store contents are invalid');
    this.name = 'PolicyStoreCorruptError';
  }
}

export class PolicyStoreCapacityError extends Error {
  readonly code = 'policy_store_capacity_exceeded';

  constructor() {
    super('Policy store reached its supported capacity');
    this.name = 'PolicyStoreCapacityError';
  }
}

function parseStoredPolicies(raw: string): StoredPolicies {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !['storageVersion', 'policies', 'audit'].includes(key)
      )
    ) {
      throw new PolicyStoreCorruptError();
    }
    const record = value as Record<string, unknown>;
    if (
      record.storageVersion !== STORAGE_VERSION ||
      typeof record.policies !== 'object' ||
      record.policies === null ||
      Array.isArray(record.policies) ||
      !Array.isArray(record.audit)
    ) {
      throw new PolicyStoreCorruptError();
    }
    const policies: Record<string, PolicySnapshotV1> = {};
    for (const [householdId, snapshot] of Object.entries(record.policies)) {
      const parsed = parsePolicySnapshotV1(snapshot);
      if (householdId !== parsed.householdId) {
        throw new PolicyStoreCorruptError();
      }
      policies[householdId] = parsed;
    }
    const audit = record.audit.map(parseAuditEvent);
    return { storageVersion: STORAGE_VERSION, policies, audit };
  } catch (error) {
    if (error instanceof PolicyStoreCorruptError) throw error;
    throw new PolicyStoreCorruptError();
  }
}

function parseAuditEvent(value: unknown): PolicyAuditEventV1 {
  try {
    return parsePolicyAuditEventV1(value);
  } catch {
    throw new PolicyStoreCorruptError();
  }
}

function validateAuditEvent(
  event: PolicyAuditEventV1,
  snapshot: PolicySnapshotV1,
  expectedPolicyVersion: number | null
): void {
  if (
    event.contractVersion !== TYRION_DOMAIN_CONTRACT_VERSION ||
    event.householdId !== snapshot.householdId ||
    event.policyVersion !== snapshot.policyVersion ||
    event.previousPolicyVersion !== expectedPolicyVersion ||
    event.occurredAt !== snapshot.updatedAt ||
    event.action !==
      (expectedPolicyVersion === null ? 'policy-created' : 'policy-replaced')
  ) {
    throw new PolicyStoreCorruptError();
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
