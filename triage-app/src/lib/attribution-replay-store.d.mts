export class AttributionReplayStoreError extends Error {}

export class FileAttributionReplayStore {
  constructor(directory: string);
  consume(
    clientId: string,
    timestamp: string,
    nonce: string,
    expiresAt: number,
    now: number
  ): Promise<boolean>;
}
