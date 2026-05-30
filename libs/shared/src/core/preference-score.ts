import { and, eq } from 'drizzle-orm';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';

type ScoreTable = PgTableWithColumns<any> & {
  category: any;
  value: any;
  score: any;
  signalCount: any;
  updatedAt: any;
};

/** Generic preference score updater for tables with (category, value, score, signalCount) columns. */
export async function updatePreferenceScore(
  db: any,
  table: ScoreTable,
  category: string,
  value: string,
  delta: number,
): Promise<void> {
  const [existing] = await db
    .select()
    .from(table)
    .where(and(eq(table.category, category), eq(table.value, value)))
    .limit(1);

  const newScore = Math.max(0, Math.min(1, (existing?.score ?? 0.5) + delta));

  await db
    .insert(table)
    .values({ category, value, score: newScore, signalCount: 1 })
    .onConflictDoUpdate({
      target: [table.category, table.value],
      set: {
        score: newScore,
        signalCount: (existing?.signalCount ?? 0) + 1,
        updatedAt: new Date(),
      },
    });
}
