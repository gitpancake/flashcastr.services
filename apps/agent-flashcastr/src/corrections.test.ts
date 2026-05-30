import { describe, it, expect } from 'vitest';
import {
  getActiveCorrections,
  formatCorrectionsBlock,
  insertCorrection,
  retireCorrection,
  type ActiveCorrection,
} from './corrections.js';

// ─── In-memory fake AgentDb ──────────────────────────────────────────────
//
// flashcastr_corrections is only ever queried by (retiredAt IS NULL) ordered
// by createdAt asc, inserted, and retired by id. The fake models exactly
// those three call shapes.

interface Row {
  id: string;
  wrongClaim: string;
  correctFact: string;
  sourceCastHash: string | null;
  authorFid: number;
  scope: string;
  createdAt: Date;
  retiredAt: Date | null;
}

function createFakeDb(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let nextId = seed.length + 1;

  const db: any = {
    // getActiveCorrections: select(cols).from().where(isNull).orderBy(asc).limit(n)
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async (n: number) =>
          rows
            .filter((r) => r.retiredAt === null)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, n)
            .map((r) => ({
              id: r.id,
              wrongClaim: r.wrongClaim,
              correctFact: r.correctFact,
              createdAt: r.createdAt,
            })),
      };
      return chain;
    },
    insert: () => ({
      values: (vals: any) => ({
        returning: async () => {
          const id = `c${nextId++}`;
          rows.push({
            id,
            wrongClaim: vals.wrongClaim,
            correctFact: vals.correctFact,
            sourceCastHash: vals.sourceCastHash ?? null,
            authorFid: vals.authorFid,
            scope: vals.scope ?? 'all',
            createdAt: new Date(),
            retiredAt: null,
          });
          return [{ id }];
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          // retireCorrection is the only update — retire the most recent
          // active row (the test asserts exclusion, not the WHERE clause).
          const active = rows.filter((r) => r.retiredAt === null);
          const target = active[active.length - 1];
          if (target) target.retiredAt = new Date();
        },
      }),
    }),
  };

  return { db, rows };
}

describe('formatCorrectionsBlock', () => {
  it('returns empty string when there are no active corrections', () => {
    expect(formatCorrectionsBlock([])).toBe('');
  });

  it('renders one line per correction with the wrong claim negated', () => {
    const rows: ActiveCorrection[] = [
      { id: 'c1', wrongClaim: 'FTBL is football', correctFact: 'FTBL is Fontainebleau', createdAt: new Date('2026-05-16T00:00:00Z') },
    ];
    const block = formatCorrectionsBlock(rows);
    expect(block).toContain('LEARNED CORRECTIONS');
    expect(block).toContain('NOT "FTBL is football"');
    expect(block).toContain('FTBL is Fontainebleau');
    expect(block).toContain('[2026-05-16]');
  });
});

describe('getActiveCorrections', () => {
  it('excludes retired rows and returns oldest-first', async () => {
    const { db } = createFakeDb([
      { id: 'old', wrongClaim: 'w1', correctFact: 'f1', sourceCastHash: null, authorFid: 1, scope: 'all', createdAt: new Date('2026-01-01'), retiredAt: null },
      { id: 'retired', wrongClaim: 'w2', correctFact: 'f2', sourceCastHash: null, authorFid: 1, scope: 'all', createdAt: new Date('2026-02-01'), retiredAt: new Date('2026-03-01') },
      { id: 'new', wrongClaim: 'w3', correctFact: 'f3', sourceCastHash: null, authorFid: 1, scope: 'all', createdAt: new Date('2026-04-01'), retiredAt: null },
    ]);

    const active = await getActiveCorrections(db);

    expect(active.map((r) => r.id)).toEqual(['old', 'new']); // retired excluded, oldest-first
  });
});

describe('insertCorrection + retireCorrection round-trip', () => {
  it('a persisted correction is active, then excluded once retired', async () => {
    const { db } = createFakeDb();

    const id = await insertCorrection(db, {
      wrongClaim: 'FTBL is football',
      correctFact: 'FTBL is Fontainebleau',
      sourceCastHash: '0xabc',
      authorFid: 42,
    });
    expect(id).toBe('c1');

    let active = await getActiveCorrections(db);
    expect(active).toHaveLength(1);
    expect(active[0]!.correctFact).toBe('FTBL is Fontainebleau');

    await retireCorrection(db, id);

    active = await getActiveCorrections(db);
    expect(active).toHaveLength(0);
  });
});
