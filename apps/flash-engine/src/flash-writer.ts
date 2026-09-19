import type { PoolClient } from "pg";
import type { Flash } from "@flashcastr/shared-types";
import type { PostgresFlashesDb, FlashJobsDb } from "@flashcastr/database";

export async function writeFlashBatch(
  client: PoolClient,
  flashesDb: Pick<PostgresFlashesDb, "insertNew">,
  flashJobsDb: Pick<FlashJobsDb, "enqueue">,
  flashes: Flash[]
): Promise<number[]> {
  const insertedFlashIds = await flashesDb.insertNew(client, flashes);
  for (const flashId of insertedFlashIds) {
    await flashJobsDb.enqueue(client, flashId, "pin");
  }
  return insertedFlashIds;
}
