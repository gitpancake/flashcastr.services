/** Opaque keyset-pagination cursor over (flashes.timestamp, flashes.flash_id). */
export function encodeFlashCursor(timestampEpochSeconds: string | null, flashId: string): string {
  return Buffer.from(JSON.stringify([timestampEpochSeconds, flashId])).toString("base64url");
}

export function decodeFlashCursor(cursor: string): { timestampEpochSeconds: string | null; flashId: string } {
  const decoded = tryParseCursor(cursor);

  if (!Array.isArray(decoded) || decoded.length !== 2) {
    throw new Error(`Invalid cursor: expected a 2-element array, got ${JSON.stringify(decoded)}`);
  }

  const [timestampEpochSeconds, flashId] = decoded;
  if (timestampEpochSeconds !== null && typeof timestampEpochSeconds !== "string") {
    throw new Error(`Invalid cursor: timestampEpochSeconds must be null or a string, got ${JSON.stringify(timestampEpochSeconds)}`);
  }
  if (typeof flashId !== "string") {
    throw new Error(`Invalid cursor: flashId must be a string, got ${JSON.stringify(flashId)}`);
  }

  return { timestampEpochSeconds, flashId };
}

function tryParseCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (err) {
    throw new Error(`Invalid cursor: could not decode "${cursor}"`, { cause: err });
  }
}
