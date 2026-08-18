const databaseName = 'pink-icon-submit.svg-preview-cache.v1';
const storeName = 'previews';

interface SvgPreviewRecord {
  key: [string, string, string];
  svg: Blob;
}

function openPreviewDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    let settled = false;
    const finish = (database: IDBDatabase | undefined) => {
      if (settled) {
        try {
          database?.close();
        } catch {
          // The cache was already reported unavailable to the caller.
        }
        return;
      }
      settled = true;
      resolve(database);
    };
    try {
      request = indexedDB.open(databaseName, 1);
    } catch {
      finish(undefined);
      return;
    }

    request.onupgradeneeded = () => {
      try {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName, { keyPath: 'key' });
        }
      } catch {
        // The request error handler below makes this cache unavailable without affecting the caller.
      }
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish(undefined);
    request.onblocked = () => finish(undefined);
  });
}

function previewKey(ownerId: string, batchId: string, itemId: string): [string, string, string] {
  return [ownerId, batchId, itemId];
}

/**
 * Stores only the local SVG blob used for a historical preview. This is deliberately
 * best-effort: callers must never wait on it to decide whether a batch write succeeded.
 */
export async function putSvgPreview(ownerId: string, batchId: string, itemId: string, svg: Blob): Promise<void> {
  const database = await openPreviewDatabase();
  if (!database) return;

  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
      transaction.objectStore(storeName).put({ key: previewKey(ownerId, batchId, itemId), svg } satisfies SvgPreviewRecord);
    } catch {
      resolve();
    }
  });
  try {
    database.close();
  } catch {
    // Closing an optional cache database must not affect the calling flow.
  }
}

/** Returns an unavailable preview rather than surfacing browser storage errors to the UI. */
export async function getSvgPreview(ownerId: string, batchId: string, itemId: string): Promise<Blob | undefined> {
  const database = await openPreviewDatabase();
  if (!database) return undefined;

  const preview = await new Promise<Blob | undefined>((resolve) => {
    try {
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(previewKey(ownerId, batchId, itemId));
      request.onsuccess = () => {
        const record = request.result as SvgPreviewRecord | undefined;
        resolve(record?.svg instanceof Blob ? record.svg : undefined);
      };
      request.onerror = () => resolve(undefined);
      transaction.onabort = () => resolve(undefined);
      transaction.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  try {
    database.close();
  } catch {
    // Closing an optional cache database must not affect the calling flow.
  }
  return preview;
}
