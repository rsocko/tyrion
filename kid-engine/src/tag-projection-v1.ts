export const KID_TAG_PREFIX = 'Kid: ' as const;
export const KID_TAG_COLOR = '#19D2A5' as const;
export const PARENT_TAG_NAME = 'Parent' as const;

export interface MonarchTagV1 {
  id: string;
  name: string;
  isActive: boolean;
}

export interface KidTagMappingV1 {
  kidId: string;
  tagId: string;
  label: string;
  retiredTagIds: string[];
}

export interface ParentTagMappingV1 {
  tagId: string;
  label: typeof PARENT_TAG_NAME;
}

export interface TagProjectionRecordV1 {
  sourceRef: string;
  decisionVersion: string;
  kidIds: string[];
  parentAssigned: boolean;
  managedTagIds: string[];
  status: 'pending' | 'projected' | 'failed' | 'drift';
  errorCode: TagProjectionErrorCode | null;
  updatedAt: string;
}

export type TagProjectionDtoV1 = Omit<TagProjectionRecordV1, 'parentAssigned'>;

export interface TagProjectionRepositoryV1 {
  listMappings(householdId: string): Promise<KidTagMappingV1[]>;
  saveMapping(householdId: string, mapping: KidTagMappingV1): Promise<void>;
  loadParentMapping(householdId: string): Promise<ParentTagMappingV1 | null>;
  saveParentMapping(householdId: string, mapping: ParentTagMappingV1): Promise<void>;
  loadProjection(
    householdId: string,
    sourceRef: string
  ): Promise<TagProjectionRecordV1 | null>;
  saveProjection(
    householdId: string,
    projection: TagProjectionRecordV1
  ): Promise<void>;
  loadVerifiedManagedTagIds?(householdId: string, sourceRef: string): Promise<string[] | null>;
}

export interface MonarchTagProjectionBridgeV1 {
  listTags(): Promise<MonarchTagV1[]>;
  createTag(name: string, color: string): Promise<MonarchTagV1>;
  readTransactionTagIds(sourceRef: string): Promise<string[]>;
  replaceTransactionTags(
    sourceRef: string,
    tagIds: string[],
    expectedTagIds: string[]
  ): Promise<string[]>;
}

export interface ConfirmedTagProjectionV1 {
  householdId: string;
  sourceRef: string;
  decisionVersion: string;
  kidIds: string[];
  parentAssigned: boolean;
  kids: Array<{ id: string; displayName: string; active: boolean }>;
}

export interface AttributionTagProjectorV1 {
  projectConfirmed(input: ConfirmedTagProjectionV1): Promise<TagProjectionDtoV1>;
}

export type TagProjectionErrorCode =
  | 'kid_tag_collision'
  | 'kid_tag_mapping_deleted'
  | 'kid_not_projectable'
  | 'transaction_tag_drift'
  | 'tag_projection_unavailable'
  | 'tag_projection_unverified';

export class TagProjectionError extends Error {
  constructor(
    readonly code: TagProjectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TagProjectionError';
  }
}

export interface TagProjectionServiceOptionsV1 {
  now?: () => Date;
}

export class TagProjectionServiceV1 implements AttributionTagProjectorV1 {
  private readonly now: () => Date;

  constructor(
    private readonly repository: TagProjectionRepositoryV1,
    private readonly bridge: MonarchTagProjectionBridgeV1,
    options: TagProjectionServiceOptionsV1 = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async projectConfirmed(
    input: ConfirmedTagProjectionV1
  ): Promise<TagProjectionDtoV1> {
    validateInput(input);
    const now = this.now().toISOString();
    const prior = await this.repository.loadProjection(
      input.householdId,
      input.sourceRef
    );
    if (prior && input.decisionVersion < prior.decisionVersion) {
      return toTagProjectionDtoV1(prior);
    }
    if (
      prior &&
      input.decisionVersion === prior.decisionVersion &&
      (!sameSet(input.kidIds, prior.kidIds) ||
        input.parentAssigned !== prior.parentAssigned)
    ) {
      throw await this.fail(
        input,
        prior.managedTagIds,
        now,
        'transaction_tag_drift',
        'Attribution decision identity conflicts with projected state'
      );
    }
    if (prior?.status === 'drift') {
      throw await this.fail(
        input, prior.managedTagIds, now, 'transaction_tag_drift',
        'Managed Monarch tags changed; reconcile before retrying'
      );
    }
    let mappings = await this.repository.listMappings(input.householdId);
    let parentMapping = await this.repository.loadParentMapping(input.householdId);
    const catalog = await this.bridge.listTags();
    if (parentMapping && parentMapping.tagId !== PENDING_PARENT_TAG_ID) {
      const mappedParentTag = catalog.find((tag) => tag.id === parentMapping!.tagId);
      if (!mappedParentTag?.isActive) {
        throw await this.fail(
          input, [], now, 'kid_tag_mapping_deleted',
          'The managed Monarch Parent tag was deleted or disabled'
        );
      }
      if (mappedParentTag.name !== PARENT_TAG_NAME) {
        throw await this.fail(
          input, [], now, 'transaction_tag_drift',
          'The managed Monarch Parent tag changed; reconcile before retrying'
        );
      }
    }
    const desiredMappings: KidTagMappingV1[] = [];

    for (const kidId of input.kidIds) {
      const kid = input.kids.find((candidate) => candidate.id === kidId);
      if (!kid?.active) {
        throw await this.fail(
          input,
          [],
          now,
          'kid_not_projectable',
          'The selected kid is not available for tag projection'
        );
      }
      const label = `${KID_TAG_PREFIX}${kid.displayName}`;
      let mapping = mappings.find((candidate) => candidate.kidId === kidId);
      if (mapping?.tagId === pendingTagId(kidId)) {
        const candidates = catalog.filter(
          (tag) =>
            tag.isActive &&
            tag.name.localeCompare(label, undefined, { sensitivity: 'accent' }) ===
              0
        );
        if (candidates.length > 1) {
          throw await this.fail(
            input,
            [],
            now,
            'kid_tag_collision',
            'Multiple Monarch Kid tags require explicit reconciliation'
          );
        }
        let recovered = candidates[0];
        if (!recovered) {
          try {
            recovered = await this.createManagedTag(label);
          } catch (error) {
            const projectionError =
              error instanceof TagProjectionError
                ? error
                : new TagProjectionError(
                    'tag_projection_unavailable',
                    'Monarch tag projection is unavailable'
                  );
            throw await this.fail(
              input,
              [],
              now,
              projectionError.code,
              projectionError.message
            );
          }
          catalog.push(recovered);
        }
        mapping = { ...mapping, tagId: recovered.id, label };
        await this.repository.saveMapping(input.householdId, mapping);
        mappings = mappings.map((candidate) =>
          candidate.kidId === kidId ? mapping! : candidate
        );
      }
      if (mapping) {
        const mappedTag = catalog.find((tag) => tag.id === mapping!.tagId);
        if (!mappedTag?.isActive) {
          throw await this.fail(
            input,
            [],
            now,
            'kid_tag_mapping_deleted',
            'A managed Monarch tag was deleted or disabled'
          );
        }
        if (mappedTag.name !== mapping.label) {
          throw await this.fail(
            input,
            [],
            now,
            'transaction_tag_drift',
            'A managed Monarch tag changed; reconcile before retrying'
          );
        }
        if (mapping.label !== label) {
          if (
            catalog.some(
              (tag) =>
                tag.id !== mapping!.tagId &&
                tag.name.localeCompare(label, undefined, { sensitivity: 'accent' }) === 0
            )
          ) {
            throw await this.fail(
              input,
              [],
              now,
              'kid_tag_collision',
              'A conflicting Monarch Kid tag requires reconciliation'
            );
          }
          const pendingMapping = {
            kidId,
            tagId: pendingTagId(kidId),
            label,
            retiredTagIds: unique([
              ...mapping.retiredTagIds,
              mapping.tagId,
            ]),
          };
          await this.repository.saveMapping(input.householdId, pendingMapping);
          mappings = mappings.map((candidate) =>
            candidate.kidId === kidId ? pendingMapping : candidate
          );
          let replacement: MonarchTagV1;
          try {
            replacement = await this.createManagedTag(label);
          } catch (error) {
            const projectionError =
              error instanceof TagProjectionError
                ? error
                : new TagProjectionError(
                    'tag_projection_unavailable',
                    'Monarch tag projection is unavailable'
                  );
            throw await this.fail(
              input,
              [],
              now,
              projectionError.code,
              projectionError.message
            );
          }
          catalog.push(replacement);
          mapping = {
            ...pendingMapping,
            tagId: replacement.id,
          };
          await this.repository.saveMapping(input.householdId, mapping);
          mappings = mappings.map((candidate) =>
            candidate.kidId === kidId ? mapping! : candidate
          );
        }
      } else {
        if (
          catalog.some(
            (tag) =>
              tag.name.localeCompare(label, undefined, { sensitivity: 'accent' }) === 0
          )
        ) {
          throw await this.fail(
            input,
            [],
            now,
            'kid_tag_collision',
            'A pre-existing Monarch Kid tag requires explicit reconciliation'
          );
        }
        const pendingMapping = {
          kidId,
          tagId: pendingTagId(kidId),
          label,
          retiredTagIds: [],
        };
        await this.repository.saveMapping(input.householdId, pendingMapping);
        mappings = [...mappings, pendingMapping];
        let created: MonarchTagV1;
        try {
          created = await this.createManagedTag(label);
        } catch (error) {
          const projectionError =
            error instanceof TagProjectionError
              ? error
              : new TagProjectionError(
                  'tag_projection_unavailable',
                  'Monarch tag projection is unavailable'
                );
          throw await this.fail(
            input,
            [],
            now,
            projectionError.code,
            projectionError.message
          );
        }
        catalog.push(created);
        mapping = {
          ...pendingMapping,
          tagId: created.id,
        };
        await this.repository.saveMapping(input.householdId, mapping);
        mappings = mappings.map((candidate) =>
          candidate.kidId === kidId ? mapping! : candidate
        );
      }
      desiredMappings.push(mapping);
    }

    let desiredParentTagId: string | null = null;
    if (input.parentAssigned) {
      if (parentMapping?.tagId === PENDING_PARENT_TAG_ID) {
        const candidates = matchingLabels(catalog, PARENT_TAG_NAME);
        if (
          candidates.length > 1 ||
          candidates.some(
            (tag) => tag.name !== PARENT_TAG_NAME || !tag.isActive
          )
        ) {
          throw await this.fail(
            input, [], now, 'kid_tag_collision',
            'Conflicting Monarch Parent tags require explicit reconciliation'
          );
        }
        let recovered = candidates[0];
        if (!recovered) {
          try {
            recovered = await this.createManagedTag(PARENT_TAG_NAME);
          } catch (error) {
            const projectionError = asProjectionError(error);
            throw await this.fail(
              input, [], now, projectionError.code, projectionError.message
            );
          }
          catalog.push(recovered);
        }
        parentMapping = { tagId: recovered.id, label: PARENT_TAG_NAME };
        await this.repository.saveParentMapping(input.householdId, parentMapping);
      } else if (parentMapping) {
        desiredParentTagId = parentMapping.tagId;
      } else {
        if (matchingLabels(catalog, PARENT_TAG_NAME).length > 0) {
          throw await this.fail(
            input, [], now, 'kid_tag_collision',
            'A pre-existing Monarch Parent tag requires explicit reconciliation'
          );
        }
        parentMapping = {
          tagId: PENDING_PARENT_TAG_ID,
          label: PARENT_TAG_NAME,
        };
        await this.repository.saveParentMapping(input.householdId, parentMapping);
        let created: MonarchTagV1;
        try {
          created = await this.createManagedTag(PARENT_TAG_NAME);
        } catch (error) {
          const projectionError = asProjectionError(error);
          throw await this.fail(
            input, [], now, projectionError.code, projectionError.message
          );
        }
        catalog.push(created);
        parentMapping = { tagId: created.id, label: PARENT_TAG_NAME };
        await this.repository.saveParentMapping(input.householdId, parentMapping);
      }
      desiredParentTagId ??= parentMapping.tagId;
    }

    const currentTagIds = unique(
      await this.bridge.readTransactionTagIds(input.sourceRef)
    );
    const allManagedIds = new Set(
      [
        ...mappings.flatMap((mapping) => [
          mapping.tagId,
          ...mapping.retiredTagIds,
        ]),
        ...(parentMapping ? [parentMapping.tagId] : []),
      ]
    );
    const currentManagedIds = currentTagIds.filter((tagId) =>
      allManagedIds.has(tagId)
    );
    const verifiedManagedIds = await this.repository.loadVerifiedManagedTagIds?.(
      input.householdId, input.sourceRef
    );
    if (
      (prior?.status === 'projected' &&
        !sameSet(currentManagedIds, prior.managedTagIds)) ||
      (verifiedManagedIds != null &&
        prior?.status !== 'projected' &&
        !sameSet(currentManagedIds, verifiedManagedIds) &&
        !sameSet(currentManagedIds, prior?.managedTagIds ?? []))
    ) {
      throw await this.fail(
        input,
        prior?.managedTagIds ?? [],
        now,
        'transaction_tag_drift',
        'Managed Monarch tags changed; reconcile before retrying'
      );
    }

    const desiredManagedIds = unique(
      [
        ...desiredMappings.map((mapping) => mapping.tagId),
        ...(desiredParentTagId ? [desiredParentTagId] : []),
      ]
    );
    const desiredTagIds = unique([
      ...currentTagIds.filter((tagId) => !allManagedIds.has(tagId)),
      ...desiredManagedIds,
    ]);
    if (sameSet(currentTagIds, desiredTagIds)) {
      return this.save(input, desiredManagedIds, 'projected', null, now);
    }

    await this.save(input, desiredManagedIds, 'pending', null, now);
    let verifiedIds: string[];
    try {
      verifiedIds = await this.bridge.replaceTransactionTags(
        input.sourceRef,
        desiredTagIds,
        currentTagIds
      );
    } catch (error) {
      const code =
        error instanceof TagProjectionError &&
        error.code === 'transaction_tag_drift'
          ? 'transaction_tag_drift'
          : 'tag_projection_unavailable';
      throw await this.fail(
        input,
        desiredManagedIds,
        now,
        code,
        code === 'transaction_tag_drift'
          ? 'Managed Monarch tags changed; reconcile before retrying'
          : 'Monarch tag projection is unavailable'
      );
    }
    if (!sameSet(verifiedIds, desiredTagIds)) {
      throw await this.fail(
        input,
        desiredManagedIds,
        now,
        'tag_projection_unverified',
        'Monarch did not verify the projected tags'
      );
    }
    return this.save(input, desiredManagedIds, 'projected', null, now);
  }

  private async createManagedTag(label: string): Promise<MonarchTagV1> {
    try {
      const tag = await this.bridge.createTag(label, KID_TAG_COLOR);
      if (!tag.isActive || tag.name !== label) {
        throw new TagProjectionError(
          'tag_projection_unverified',
          'Monarch did not verify the managed tag'
        );
      }
      return tag;
    } catch (error) {
      if (error instanceof TagProjectionError) throw error;
      throw new TagProjectionError(
        'tag_projection_unavailable',
        'Monarch tag projection is unavailable'
      );
    }
  }

  private async fail(
    input: ConfirmedTagProjectionV1,
    managedTagIds: string[],
    now: string,
    code: TagProjectionErrorCode,
    message: string
  ): Promise<TagProjectionError> {
    await this.save(
      input,
      managedTagIds,
      code === 'transaction_tag_drift' ? 'drift' : 'failed',
      code,
      now
    );
    return new TagProjectionError(code, message);
  }

  private async save(
    input: ConfirmedTagProjectionV1,
    managedTagIds: string[],
    status: TagProjectionRecordV1['status'],
    errorCode: TagProjectionErrorCode | null,
    updatedAt: string
  ): Promise<TagProjectionDtoV1> {
    const record: TagProjectionRecordV1 = {
      sourceRef: input.sourceRef,
      decisionVersion: input.decisionVersion,
      kidIds: [...input.kidIds],
      parentAssigned: input.parentAssigned,
      managedTagIds: unique(managedTagIds),
      status,
      errorCode,
      updatedAt,
    };
    await this.repository.saveProjection(input.householdId, record);
    return toTagProjectionDtoV1(record);
  }
}

export function toTagProjectionDtoV1(
  projection: TagProjectionRecordV1
): TagProjectionDtoV1 {
  const { parentAssigned: _parentAssigned, ...dto } = projection;
  return dto;
}

function validateInput(input: ConfirmedTagProjectionV1): void {
  if (
    !input.householdId ||
    !input.sourceRef ||
    !input.decisionVersion ||
    typeof input.parentAssigned !== 'boolean' ||
    (input.parentAssigned && input.kidIds.length > 0) ||
    new Set(input.kidIds).size !== input.kidIds.length ||
    input.kidIds.length > 20 ||
    input.kids.length > 100
  ) {
    throw new TagProjectionError(
      'kid_not_projectable',
      'Confirmed attribution cannot be projected'
    );
  }
  for (const kid of input.kids) {
    const label = `${KID_TAG_PREFIX}${kid.displayName}`;
    if (
      !kid.id ||
      !kid.displayName ||
      label.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(label)
    ) {
      throw new TagProjectionError(
        'kid_not_projectable',
        'Confirmed attribution cannot be projected'
      );
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pendingTagId(kidId: string): string {
  return `pending:${kidId}`;
}

const PENDING_PARENT_TAG_ID = 'pending:parent';

function matchingLabels(tags: MonarchTagV1[], label: string): MonarchTagV1[] {
  return tags.filter(
    (tag) =>
      tag.name.localeCompare(label, undefined, { sensitivity: 'accent' }) === 0
  );
}

function asProjectionError(error: unknown): TagProjectionError {
  return error instanceof TagProjectionError
    ? error
    : new TagProjectionError(
        'tag_projection_unavailable',
        'Monarch tag projection is unavailable'
      );
}

function sameSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}
