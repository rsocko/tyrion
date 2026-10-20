import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import {
  parseAttributionActionRecordV1,
  type AttributionActionApplyResultV1,
  type AttributionActionMutationV1,
  type AttributionActionRecordV1,
  type AttributionActionRepository,
} from './attribution-actions-v1.js';
import {
  parseReattributionPreviewV1,
  type ReattributionPreviewV1,
} from './contracts/v1.js';
import {
  ReattributionError,
  type ReattributionAppliedStateV1,
  type ReattributionApplyCountsV1,
  type ReattributionRepository,
} from './reattribution-v1.js';
import type {
  KidTagMappingV1,
  TagProjectionRecordV1,
  TagProjectionRepositoryV1,
} from './tag-projection-v1.js';

const MAX_BYTES = 64 * 1024 * 1024;
interface StoredRecord {
  householdId: string;
  transactionId: string;
  record: AttributionActionRecordV1;
  projectionPending: boolean;
}
interface Store {
  storageVersion: 1;
  records: StoredRecord[];
  replays: Array<{ householdId: string; key: string; result: AttributionActionApplyResultV1 }>;
  audit: Array<{
    householdId: string; record: AttributionActionRecordV1;
    kind: 'registered' | 'refreshed' | 'action' | 'reattribution';
    actorId: string | null; reference: string | null;
  }>;
  mappings: Array<{ householdId: string; mapping: KidTagMappingV1 }>;
  projections: Array<{
    householdId: string; projection: TagProjectionRecordV1;
    verifiedManagedTagIds?: string[];
  }>;
  previews: ReattributionPreviewV1[];
  previewVersions: Array<{
    householdId: string; previewId: string;
    records: Array<{ sourceRef: string; stateVersion: number }>;
  }>;
  applied: Array<{ householdId: string; previewId: string; state: ReattributionAppliedStateV1 }>;
}

export class AttributionStoreError extends Error {
  readonly code = 'attribution_state_unavailable';
  constructor() {
    super('Durable attribution state is unavailable');
    this.name = 'AttributionStoreError';
  }
}

/** One household-domain journal: decisions, audit, replay receipts and projection outbox. */
export class FileAttributionRepositoryV1
  implements AttributionActionRepository, TagProjectionRepositoryV1, ReattributionRepository {
  private readonly path: string;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new AttributionStoreError();
    try {
      let ancestor = dirname(resolve(path));
      while (!existsSync(/* turbopackIgnore: true */ ancestor)) ancestor = dirname(ancestor);
      const resolved = resolve(
        realpathSync(/* turbopackIgnore: true */ ancestor), relative(ancestor, resolve(path))
      );
      const fromCheckout = relative(resolve(/* turbopackIgnore: true */ process.cwd()), resolved);
      if (!fromCheckout.startsWith('..') && !isAbsolute(fromCheckout)) {
        throw new AttributionStoreError();
      }
      for (let parent = dirname(resolved); parent !== parse(parent).root; parent = dirname(parent)) {
        if (existsSync(join(/* turbopackIgnore: true */ parent, '.git'))) {
          throw new AttributionStoreError();
        }
      }
      this.path = resolved;
    } catch {
      throw new AttributionStoreError();
    }
  }

  async load(householdId: string, sourceRef: string): Promise<AttributionActionRecordV1 | null> {
    return structuredClone(this.find(await this.read(), householdId, sourceRef)?.record ?? null);
  }

  async transactionId(householdId: string, sourceRef: string): Promise<string> {
    const record = this.find(await this.read(), householdId, sourceRef);
    if (!record) throw new AttributionStoreError();
    return record.transactionId;
  }

  async register(
    householdId: string,
    transactionId: string,
    record: AttributionActionRecordV1,
    expectedStateVersion: number | null,
    actorId: string | null = null
  ): Promise<AttributionActionRecordV1 | null> {
    return this.update((store) => {
      const current = this.find(store, householdId, record.attribution.sourceRef);
      if (
        (current && current.transactionId !== transactionId) ||
        store.records.some((entry) =>
          entry.householdId === householdId &&
          entry.transactionId === transactionId &&
          entry.record.attribution.sourceRef !== record.attribution.sourceRef
        )
      ) return null;
      // Create-only bootstrap must never overwrite an existing operator decision.
      if (current && expectedStateVersion === null) return current.record;
      if ((current?.record.stateVersion ?? null) !== expectedStateVersion) return null;
      if (
        current &&
        JSON.stringify(current.record.input.transaction) === JSON.stringify(record.input.transaction) &&
        JSON.stringify(current.record.input.existingManualDecision) === JSON.stringify(record.input.existingManualDecision) &&
        current.record.attribution.provenance.policyVersion === record.attribution.provenance.policyVersion
      ) return current.record;
      const parsed = parseAttributionActionRecordV1({
        ...record,
        stateVersion: (current?.record.stateVersion ?? 0) + 1,
      });
      if (parsed.input.householdId !== householdId) throw new AttributionStoreError();
      const stored: StoredRecord = {
        householdId, transactionId, record: parsed,
        projectionPending: this.queueProjection(store, householdId, parsed, current?.projectionPending ?? false),
      };
      if (current) Object.assign(current, stored);
      else store.records.push(stored);
      store.audit.push({
        householdId, record: parsed, actorId, reference: null,
        kind: current ? 'refreshed' : 'registered',
      });
      return parsed;
    });
  }

  async loadReplay(householdId: string, _sourceRef: string, idempotencyKey: string) {
    const replay = (await this.read()).replays.find((entry) =>
      entry.householdId === householdId && entry.key === idempotencyKey);
    return replay ? { ...structuredClone(replay.result), replayed: true } : null;
  }

  async applyIfCurrent(householdId: string, mutation: AttributionActionMutationV1) {
    return this.update((store) => {
      const replay = store.replays.find((entry) =>
        entry.householdId === householdId && entry.key === mutation.request.idempotencyKey);
      if (replay) return { ...replay.result, replayed: true };
      const current = this.find(store, householdId, mutation.request.sourceRef);
      if (!current || current.record.stateVersion !== mutation.request.expectedStateVersion) return null;
      const record = parseAttributionActionRecordV1({
        input: mutation.input, attribution: mutation.attribution, exception: mutation.exception,
        stateVersion: current.record.stateVersion + 1,
        lastAction: {
          ...mutation.audit, outcome: 'applied',
          stateVersion: current.record.stateVersion + 1,
        },
      });
      current.record = record;
      if (mutation.request.action !== 'defer-exception') current.projectionPending = true;
      store.audit.push({
        householdId, record, kind: 'action',
        actorId: mutation.audit.actorId, reference: mutation.audit.actionRef,
      });
      const result = { record, replayed: false, requestFingerprint: mutation.requestFingerprint };
      store.replays.push({ householdId, key: mutation.request.idempotencyKey, result });
      return result;
    });
  }

  async listAudit(householdId: string, sourceRef: string) {
    return structuredClone((await this.read()).audit.filter((entry) =>
      entry.householdId === householdId && entry.record.attribution.sourceRef === sourceRef
    ).map((entry) => entry.record));
  }

  async listMappings(householdId: string) {
    return structuredClone((await this.read()).mappings.filter((entry) =>
      entry.householdId === householdId).map((entry) => entry.mapping));
  }

  async saveMapping(householdId: string, mapping: KidTagMappingV1) {
    await this.update((store) => {
      const current = store.mappings.find((entry) =>
        entry.householdId === householdId && entry.mapping.kidId === mapping.kidId);
      if (current) current.mapping = mapping;
      else store.mappings.push({ householdId, mapping });
    });
  }

  async loadProjection(householdId: string, sourceRef: string) {
    return structuredClone((await this.read()).projections.find((entry) =>
      entry.householdId === householdId && entry.projection.sourceRef === sourceRef
    )?.projection ?? null);
  }

  async saveProjection(householdId: string, projection: TagProjectionRecordV1) {
    await this.update((store) => {
      const current = store.projections.find((entry) =>
        entry.householdId === householdId && entry.projection.sourceRef === projection.sourceRef);
      if (current) {
        current.projection = projection;
        if (projection.status === 'projected') current.verifiedManagedTagIds = projection.managedTagIds;
      } else store.projections.push({
        householdId, projection,
        ...(projection.status === 'projected' ? { verifiedManagedTagIds: projection.managedTagIds } : {}),
      });
      const record = this.find(store, householdId, projection.sourceRef);
      if (record && projection.decisionVersion === decisionVersion(record.record)) {
        record.projectionPending = projection.status !== 'projected';
      }

    });
  }

  async loadVerifiedManagedTagIds(householdId: string, sourceRef: string) {
    return (await this.read()).projections.find((entry) =>
      entry.householdId === householdId && entry.projection.sourceRef === sourceRef
    )?.verifiedManagedTagIds ?? null;
  }

  async projectionPending(householdId: string, sourceRef: string): Promise<boolean> {
    return this.find(await this.read(), householdId, sourceRef)?.projectionPending ?? false;
  }

  // Serializes catalog creation and read/replace across processes and source records.
  async withProjectionLease<T>(operation: () => Promise<T>): Promise<T> {
    return this.lock(`${this.path}.projection`, operation);
  }

  async loadRecords(householdId: string, sourceRefs: string[]) {
    return (await this.read()).records.filter((entry) =>
      entry.householdId === householdId && sourceRefs.includes(entry.record.attribution.sourceRef)
    ).map((entry) => ({
      input: entry.record.input, current: entry.record.attribution,
      stateVersion: entry.record.stateVersion,
    }));
  }

  async savePreview(
    preview: ReattributionPreviewV1,
    observedVersions: Array<{ sourceRef: string; stateVersion: number }> = []
  ) {
    await this.update((store) => {
      if (
        observedVersions.length !== preview.items.length ||
        preview.items.some((item) => {
          const current = this.find(store, preview.householdId, item.sourceRef);
          const observed = observedVersions.find((entry) => entry.sourceRef === item.sourceRef);
          return !current || current.record.stateVersion !== observed?.stateVersion;
        })
      ) throw new ReattributionError(
        'reattribution_state_conflict', 'Attribution facts changed; create a new preview'
      );
      store.previews.push(parseReattributionPreviewV1(preview));
      store.previewVersions.push({
        householdId: preview.householdId, previewId: preview.previewId,
        records: structuredClone(observedVersions),
      });
    });
  }

  async loadPreview(householdId: string, previewId: string) {
    return (await this.read()).previews.find((entry) =>
      entry.householdId === householdId && entry.previewId === previewId) ?? null;
  }

  async loadAppliedState(householdId: string, previewId: string) {
    return (await this.read()).applied.find((entry) =>
      entry.householdId === householdId && entry.previewId === previewId)?.state ?? null;
  }

  async applyPreviewIfPolicyVersion(
    preview: ReattributionPreviewV1, appliedAt: string, expectedPolicyVersion: number,
    actorId?: string
  ): Promise<ReattributionApplyCountsV1 | null> {
    return this.update((store) => {
      const replay = store.applied.find((entry) =>
        entry.householdId === preview.householdId && entry.previewId === preview.previewId);
      if (replay) return replay.state.counts;
      if (preview.policyVersion !== expectedPolicyVersion) return null;
      const versions = store.previewVersions.find((entry) =>
        entry.householdId === preview.householdId && entry.previewId === preview.previewId);
      if (!versions) return null;
      if (preview.items.some((item) => {
        const current = this.find(store, preview.householdId, item.sourceRef);
        const version = versions.records.find((entry) => entry.sourceRef === item.sourceRef);
        return !current || version?.stateVersion !== current.record.stateVersion ||
          JSON.stringify(current.record.attribution) !== JSON.stringify(item.previous);
      })) return null;
      const counts = { applied: 0, unchanged: 0, manualPreserved: 0, pendingReview: 0 };
      for (const item of preview.items) {
        if (item.disposition === 'manual-preserved') { counts.manualPreserved++; continue; }
        if (item.disposition === 'unchanged') { counts.unchanged++; continue; }
        const current = this.find(store, preview.householdId, item.sourceRef)!;
        const record = parseAttributionActionRecordV1({
          ...current.record, attribution: item.proposed,
          stateVersion: current.record.stateVersion + 1,
          lastAction: null,
          exception: {
            status: item.proposed.review.reasons.length ? 'open' : 'resolved',
            reasons: item.proposed.review.reasons, deferredUntil: null, updatedAt: appliedAt,
          },
        });
        current.record = record;
        current.projectionPending = this.queueProjection(
          store, preview.householdId, record, current.projectionPending
        );
        store.audit.push({
          householdId: preview.householdId, record, kind: 'reattribution',
          actorId: actorId ?? null, reference: preview.previewId,
        });
        if (item.disposition === 'pending-review') counts.pendingReview++;
        else counts.applied++;
      }
      store.applied.push({
        householdId: preview.householdId, previewId: preview.previewId,
        state: { counts, appliedAt },
      });
      return counts;
    });
  }

  private find(store: Store, householdId: string, sourceRef: string) {
    return store.records.find((entry) =>
      entry.householdId === householdId && entry.record.attribution.sourceRef === sourceRef);
  }

  private queueProjection(
    store: Store, householdId: string, record: AttributionActionRecordV1, wasPending: boolean
  ): boolean {
    const prior = store.projections.find((entry) =>
      entry.householdId === householdId && entry.projection.sourceRef === record.attribution.sourceRef);
    if (projectable(record)) return true;
    if (!prior && !wasPending) return false;
    const projection: TagProjectionRecordV1 = {
      sourceRef: record.attribution.sourceRef, decisionVersion: decisionVersion(record),
      kidIds: [], managedTagIds: prior?.projection.managedTagIds ?? [],
      status: prior?.projection.status === 'drift' ? 'drift' : 'pending',
      errorCode: prior?.projection.status === 'drift' ? 'transaction_tag_drift' : null,
      updatedAt: record.attribution.provenance.evaluatedAt,
    };
    if (prior) prior.projection = projection;
    else store.projections.push({ householdId, projection });
    return true;
  }

  private async read(): Promise<Store> {
    try {
      if ((await stat(this.path)).size > MAX_BYTES) throw new AttributionStoreError();
      const value: Store = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.storageVersion !== 1 || ![
        value.records, value.replays, value.audit, value.mappings,
        value.projections, value.previews, value.previewVersions, value.applied,
      ].every(Array.isArray)) throw new AttributionStoreError();
      for (const entry of value.records) {
        const parsed = parseAttributionActionRecordV1(entry.record);
        if (
          parsed.input.householdId !== entry.householdId ||
          typeof entry.transactionId !== 'string' || !entry.transactionId ||
          typeof entry.projectionPending !== 'boolean'
        ) throw new AttributionStoreError();
      }
      for (const entry of value.audit) {
        if (
          parseAttributionActionRecordV1(entry.record).input.householdId !== entry.householdId ||
          !['registered', 'refreshed', 'action', 'reattribution'].includes(entry.kind) ||
          !(entry.actorId === null || typeof entry.actorId === 'string') ||
          !(entry.reference === null || typeof entry.reference === 'string')
        ) {
          throw new AttributionStoreError();
        }
      }
      for (const entry of value.replays) {
        const parsed = parseAttributionActionRecordV1(entry.result.record);
        if (
          parsed.input.householdId !== entry.householdId ||
          parsed.lastAction?.idempotencyKey !== entry.key ||
          typeof entry.result.replayed !== 'boolean' ||
          !/^action-request-v1:[a-f0-9]{64}$/.test(entry.result.requestFingerprint)
        ) throw new AttributionStoreError();
      }
      for (const entry of value.mappings) {
        const mapping = entry.mapping;
        if (
          typeof entry.householdId !== 'string' ||
          !exactKeys(mapping, ['kidId', 'tagId', 'label', 'retiredTagIds']) ||
          !strings([mapping.kidId, mapping.tagId, mapping.label]) ||
          !strings(mapping.retiredTagIds)
        ) throw new AttributionStoreError();
      }
      for (const entry of value.projections) {
        const projection = entry.projection;
        if (
          typeof entry.householdId !== 'string' ||
          !exactKeys(projection, [
            'sourceRef', 'decisionVersion', 'kidIds', 'managedTagIds',
            'status', 'errorCode', 'updatedAt',
          ]) ||
          !strings([projection.sourceRef, projection.decisionVersion, projection.updatedAt]) ||
          !strings(projection.kidIds) || !strings(projection.managedTagIds) ||
          !['pending', 'projected', 'failed', 'drift'].includes(projection.status) ||
          !Number.isFinite(Date.parse(projection.updatedAt)) ||
          (entry.verifiedManagedTagIds !== undefined && !strings(entry.verifiedManagedTagIds)) ||
          ![
            null, 'kid_tag_collision', 'kid_tag_mapping_deleted', 'kid_not_projectable',
            'transaction_tag_drift', 'tag_projection_unavailable', 'tag_projection_unverified',
          ].includes(projection.errorCode) ||
          (['pending', 'projected'].includes(projection.status) !== (projection.errorCode === null))
        ) throw new AttributionStoreError();
      }
      for (const preview of value.previews) parseReattributionPreviewV1(preview);
      for (const entry of value.previewVersions) {
        if (
          !strings([entry.householdId, entry.previewId]) ||
          !Array.isArray(entry.records) ||
          entry.records.some((record) =>
            typeof record.sourceRef !== 'string' ||
            !Number.isSafeInteger(record.stateVersion) || record.stateVersion < 1)
        ) throw new AttributionStoreError();
      }
      for (const entry of value.applied) {
        if (
          !strings([entry.householdId, entry.previewId, entry.state.appliedAt]) ||
          !Number.isFinite(Date.parse(entry.state.appliedAt)) ||
          !exactKeys(entry.state.counts, ['applied', 'unchanged', 'manualPreserved', 'pendingReview']) ||
          Object.values(entry.state.counts).some((count) => !Number.isSafeInteger(count) || count < 0)
        ) throw new AttributionStoreError();
      }
      return value;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return {
        storageVersion: 1, records: [], replays: [], audit: [], mappings: [],
        projections: [], previews: [], previewVersions: [], applied: [],
      };
      throw new AttributionStoreError();
    }
  }

  private async update<T>(operation: (store: Store) => T): Promise<T> {
    return this.lock(this.path, async () => {
      const store = await this.read();
      const result = operation(store);
      const payload = JSON.stringify(store);
      if (Buffer.byteLength(payload) > MAX_BYTES) throw new AttributionStoreError();
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path);
        await chmod(this.path, 0o600);
      } catch {
        throw new AttributionStoreError();
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (errorCode(error) !== 'ENOENT') throw new AttributionStoreError();
        });
      }
      return structuredClone(result);
    });
  }

  private async lock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.path), 0o700);
      release = await lockfile.lock(path, {
        realpath: false, stale: 120_000, update: 10_000,
        retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
      });
    } catch {
      throw new AttributionStoreError();
    }
    try {
      return await operation();
    } finally {
      if (release) {
        try { await release(); } catch { throw new AttributionStoreError(); }
      }
    }
  }
}

export function decisionVersion(record: AttributionActionRecordV1): string {
  return `state:${String(record.stateVersion).padStart(16, '0')}`;
}

export function projectable(record: AttributionActionRecordV1): boolean {
  return record.attribution.method === 'manual' ||
    (record.attribution.confidence === 'definite' && record.attribution.status !== 'pending');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code) : undefined;
}

function exactKeys(value: unknown, keys: string[]): boolean {
  return typeof value === 'object' && value !== null &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}
