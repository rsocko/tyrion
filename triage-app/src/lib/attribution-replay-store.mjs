import { createHash } from "node:crypto";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_REPLAY_FILES = 1_000;

export class AttributionReplayStoreError extends Error {
  constructor() {
    super("Attribution replay store is unavailable");
    this.name = "AttributionReplayStoreError";
  }
}

export class FileAttributionReplayStore {
  #tail = Promise.resolve();

  constructor(directory) {
    this.directory = directory;
  }

  consume(clientId, timestamp, nonce, expiresAt, now) {
    const operation = this.#tail.then(() =>
      this.#consume(clientId, timestamp, nonce, expiresAt, now)
    );
    this.#tail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  async #consume(clientId, timestamp, nonce, expiresAt, now) {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const entries = await readdir(this.directory);
      const expiredEntries = entries.filter(
        (entry) => replayExpiry(entry) < now
      );
      await Promise.all(
        expiredEntries.map((entry) =>
          rm(resolve(this.directory, entry), {
            force: true,
            maxRetries: 3,
            retryDelay: 10,
          })
        )
      );
      if (entries.length - expiredEntries.length >= MAX_REPLAY_FILES) {
        throw new AttributionReplayStoreError();
      }
      const digest = createHash("sha256")
        .update(`${clientId}\n${timestamp}\n${nonce}`)
        .digest("hex");
      const handle = await open(
        resolve(this.directory, `${expiresAt}-${digest}.nonce`),
        "wx",
        0o600
      );
      await handle.close();
      return true;
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST") return false;
      if (error instanceof AttributionReplayStoreError) throw error;
      throw new AttributionReplayStoreError();
    }
  }
}

function replayExpiry(filename) {
  const match = /^(\d+)-[a-f0-9]{64}\.nonce$/.exec(filename);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function nodeErrorCode(error) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
