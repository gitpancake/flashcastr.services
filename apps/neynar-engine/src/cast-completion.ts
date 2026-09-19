import type { Pool, PoolClient } from "pg";
import type { FlashCastedPayload } from "@flashcastr/shared-types";
import type { FlashJobsDb } from "@flashcastr/database";

type NotifyFlashCasted = (client: Pool | PoolClient, payload: FlashCastedPayload) => Promise<void>;

// expectedAttempts fences this settle against the cast job's lease (see
// FlashJobsDb.complete): if another worker already reclaimed and completed
// the job, complete() deletes no row and the flash_casted NOTIFY must not
// fire — otherwise a reclaimed job emits a spurious duplicate NOTIFY.
export async function completeCastJob(
  client: Pool | PoolClient,
  jobsDb: Pick<FlashJobsDb, "complete">,
  flashId: number,
  expectedAttempts: number,
  castedPayload: FlashCastedPayload | null,
  notify: NotifyFlashCasted
): Promise<void> {
  const completed = await jobsDb.complete(client, flashId, "cast", expectedAttempts);
  if (!completed) return;
  if (castedPayload) await notify(client, castedPayload);
}
