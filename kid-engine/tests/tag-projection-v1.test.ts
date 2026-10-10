import { describe, expect, it } from 'vitest';
import {
  KID_TAG_COLOR,
  TagProjectionError,
  TagProjectionServiceV1,
  type KidTagMappingV1,
  type MonarchTagProjectionBridgeV1,
  type MonarchTagV1,
  type TagProjectionRecordV1,
  type TagProjectionRepositoryV1,
} from '../src/tag-projection-v1.js';

const kids = [
  { id: 'kid-alpha', displayName: 'Alex', active: true },
  { id: 'kid-beta', displayName: 'Blair', active: true },
];

describe('confirmed attribution Monarch tag projection', () => {
  it('creates stable mappings, preserves unrelated tags, and is idempotent', async () => {
    const repository = new MemoryProjectionRepository();
    const bridge = new MemoryBridge(
      [{ id: 'tag-unrelated', name: 'Household', isActive: true }],
      ['tag-unrelated']
    );
    const service = createService(repository, bridge);

    const first = await service.projectConfirmed(input(['kid-alpha']));
    const second = await service.projectConfirmed(input(['kid-alpha']));

    expect(first.status).toBe('projected');
    expect(second).toEqual(first);
    expect(bridge.creates).toEqual([
      { name: 'Kid: Alex', color: KID_TAG_COLOR },
    ]);
    expect(bridge.current).toEqual(['tag-unrelated', 'tag-created-1']);
    expect(bridge.replacements).toHaveLength(1);
    expect(repository.mappings).toEqual([
      {
        kidId: 'kid-alpha',
        tagId: 'tag-created-1',
        label: 'Kid: Alex',
        retiredTagIds: [],
      },
    ]);
  });

  it('reassigns, supports explicit sharing, and removes only managed tags for parents', async () => {
    const repository = new MemoryProjectionRepository();
    const bridge = new MemoryBridge(
      [{ id: 'tag-unrelated', name: 'Household', isActive: true }],
      ['tag-unrelated']
    );
    const service = createService(repository, bridge);

    await service.projectConfirmed(input(['kid-alpha'], 'state:1'));
    await service.projectConfirmed(input(['kid-beta'], 'state:2'));
    expect(bridge.current).toEqual(['tag-unrelated', 'tag-created-2']);

    await service.projectConfirmed(
      input(['kid-alpha', 'kid-beta'], 'state:3')
    );
    expect(bridge.current).toEqual([
      'tag-unrelated',
      'tag-created-1',
      'tag-created-2',
    ]);

    await service.projectConfirmed(input([], 'state:4'));
    expect(bridge.current).toEqual(['tag-unrelated']);
  });

  it('moves a renamed kid to a new mapped tag and removes the retired tag', async () => {
    const repository = new MemoryProjectionRepository();
    const bridge = new MemoryBridge([], []);
    const service = createService(repository, bridge);
    await service.projectConfirmed(input(['kid-alpha'], 'state:1'));

    const renamedKids = [
      { ...kids[0], displayName: 'Alexis' },
      kids[1],
    ];
    await service.projectConfirmed({
      ...input(['kid-alpha'], 'state:2'),
      kids: renamedKids,
    });

    expect(repository.mappings[0]).toEqual({
      kidId: 'kid-alpha',
      tagId: 'tag-created-2',
      label: 'Kid: Alexis',
      retiredTagIds: ['tag-created-1'],
    });
    expect(bridge.current).toEqual(['tag-created-2']);
  });

  it('surfaces collisions and deleted mappings without claiming labels', async () => {
    const collisionRepository = new MemoryProjectionRepository();
    const collisionBridge = new MemoryBridge(
      [{ id: 'external-kid-tag', name: 'Kid: Alex', isActive: true }],
      []
    );
    await expect(
      createService(collisionRepository, collisionBridge).projectConfirmed(
        input(['kid-alpha'])
      )
    ).rejects.toMatchObject({ code: 'kid_tag_collision' });
    expect(collisionBridge.creates).toEqual([]);

    const deletedRepository = new MemoryProjectionRepository();
    deletedRepository.mappings = [
      {
        kidId: 'kid-alpha',
        tagId: 'deleted-tag',
        label: 'Kid: Alex',
        retiredTagIds: [],
      },
    ];
    await expect(
      createService(
        deletedRepository,
        new MemoryBridge([], [])
      ).projectConfirmed(input(['kid-alpha']))
    ).rejects.toMatchObject({ code: 'kid_tag_mapping_deleted' });

    const renamedExternallyRepository = new MemoryProjectionRepository();
    renamedExternallyRepository.mappings = [
      {
        kidId: 'kid-alpha',
        tagId: 'mapped-tag',
        label: 'Kid: Alex',
        retiredTagIds: [],
      },
    ];
    await expect(
      createService(
        renamedExternallyRepository,
        new MemoryBridge(
          [{ id: 'mapped-tag', name: 'Changed externally', isActive: true }],
          []
        )
      ).projectConfirmed(input(['kid-alpha']))
    ).rejects.toMatchObject({ code: 'transaction_tag_drift' });
  });

  it('records recoverable failures, retries safely, and then refuses external drift', async () => {
    const repository = new MemoryProjectionRepository();
    const bridge = new MemoryBridge([], []);
    bridge.failNextReplacement = true;
    const service = createService(repository, bridge);

    await expect(
      service.projectConfirmed(input(['kid-alpha']))
    ).rejects.toMatchObject({ code: 'tag_projection_unavailable' });
    expect(repository.projection?.status).toBe('failed');

    await service.projectConfirmed(input(['kid-alpha']));
    expect(repository.projection?.status).toBe('projected');

    bridge.current = [];
    await expect(
      service.projectConfirmed(input(['kid-alpha'], 'state:2'))
    ).rejects.toMatchObject({ code: 'transaction_tag_drift' });
    expect(repository.projection?.status).toBe('drift');
    expect(bridge.replacements).toHaveLength(1);
  });

  it('recovers a created tag when final mapping persistence failed', async () => {
    const repository = new MemoryProjectionRepository();
    repository.failNextFinalMappingSave = true;
    const bridge = new MemoryBridge([], []);
    const service = createService(repository, bridge);

    await expect(
      service.projectConfirmed(input(['kid-alpha']))
    ).rejects.toThrow('synthetic mapping persistence failure');
    expect(repository.mappings[0].tagId).toBe('pending:kid-alpha');
    expect(bridge.creates).toHaveLength(1);

    await service.projectConfirmed(input(['kid-alpha']));

    expect(repository.mappings[0].tagId).toBe('tag-created-1');
    expect(bridge.creates).toHaveLength(1);
    expect(bridge.current).toEqual(['tag-created-1']);
  });

  it('ignores a delayed projection older than the last verified decision', async () => {
    const repository = new MemoryProjectionRepository();
    const bridge = new MemoryBridge([], []);
    const service = createService(repository, bridge);
    await service.projectConfirmed(
      input(['kid-beta'], '2026-10-09T20:00:02.000Z|state:3')
    );

    const stale = await service.projectConfirmed(
      input(['kid-alpha'], '2026-10-09T20:00:01.000Z|state:2')
    );

    expect(stale.kidIds).toEqual(['kid-beta']);
    expect(bridge.current).toEqual(['tag-created-1']);
    expect(bridge.replacements).toHaveLength(1);
  });

  it('does not infer attribution from unrelated Monarch metadata', async () => {
    const repository = new MemoryProjectionRepository();
    const bridge = new MemoryBridge(
      [{ id: 'external', name: 'Review: Alex', isActive: true }],
      ['external']
    );

    await createService(repository, bridge).projectConfirmed(input([]));

    expect(bridge.current).toEqual(['external']);
    expect(repository.mappings).toEqual([]);
  });
});

function input(kidIds: string[], decisionVersion = 'state:1') {
  return {
    householdId: 'household-demo',
    sourceRef: 'transaction-demo',
    decisionVersion,
    kidIds,
    kids,
  };
}

function createService(
  repository: MemoryProjectionRepository,
  bridge: MemoryBridge
) {
  return new TagProjectionServiceV1(repository, bridge, {
    now: () => new Date('2026-10-09T20:00:00.000Z'),
  });
}

class MemoryProjectionRepository implements TagProjectionRepositoryV1 {
  mappings: KidTagMappingV1[] = [];
  projection: TagProjectionRecordV1 | null = null;
  failNextFinalMappingSave = false;

  async listMappings(): Promise<KidTagMappingV1[]> {
    return structuredClone(this.mappings);
  }

  async saveMapping(
    _householdId: string,
    mapping: KidTagMappingV1
  ): Promise<void> {
    if (
      this.failNextFinalMappingSave &&
      !mapping.tagId.startsWith('pending:')
    ) {
      this.failNextFinalMappingSave = false;
      throw new Error('synthetic mapping persistence failure');
    }
    this.mappings = [
      ...this.mappings.filter((candidate) => candidate.kidId !== mapping.kidId),
      structuredClone(mapping),
    ];
  }

  async loadProjection(): Promise<TagProjectionRecordV1 | null> {
    return this.projection ? structuredClone(this.projection) : null;
  }

  async saveProjection(
    _householdId: string,
    projection: TagProjectionRecordV1
  ): Promise<void> {
    this.projection = structuredClone(projection);
  }
}

class MemoryBridge implements MonarchTagProjectionBridgeV1 {
  creates: Array<{ name: string; color: string }> = [];
  replacements: Array<{ tagIds: string[]; expectedTagIds: string[] }> = [];
  failNextReplacement = false;

  constructor(
    private catalog: MonarchTagV1[],
    public current: string[]
  ) {}

  async listTags(): Promise<MonarchTagV1[]> {
    return structuredClone(this.catalog);
  }

  async createTag(name: string, color: string): Promise<MonarchTagV1> {
    this.creates.push({ name, color });
    const tag = {
      id: `tag-created-${this.creates.length}`,
      name,
      isActive: true,
    };
    this.catalog.push(tag);
    return structuredClone(tag);
  }

  async readTransactionTagIds(): Promise<string[]> {
    return [...this.current];
  }

  async replaceTransactionTags(
    _sourceRef: string,
    tagIds: string[],
    expectedTagIds: string[]
  ): Promise<string[]> {
    if (this.failNextReplacement) {
      this.failNextReplacement = false;
      throw new Error('synthetic unavailable');
    }
    if (
      JSON.stringify([...this.current].sort()) !==
      JSON.stringify([...expectedTagIds].sort())
    ) {
      throw new TagProjectionError(
        'transaction_tag_drift',
        'Synthetic drift'
      );
    }
    this.replacements.push({
      tagIds: [...tagIds],
      expectedTagIds: [...expectedTagIds],
    });
    this.current = [...tagIds];
    return [...this.current];
  }
}
