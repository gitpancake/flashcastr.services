export const DEFAULT_PAGE = 1;
export const MAX_LIMIT = 500;

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Clamp a client-supplied limit into [1, max]; undefined uses the fallback. */
export function clampLimit(limit: number | undefined, fallback: number, max = MAX_LIMIT): number {
  const requested = limit === undefined || Number.isNaN(limit) ? fallback : limit;
  return Math.min(Math.max(1, Math.trunc(requested)), max);
}

export function pageOffset(page: number | undefined, limit: number): number {
  const validPage = Math.max(DEFAULT_PAGE, Math.trunc(page ?? DEFAULT_PAGE));
  return (validPage - 1) * limit;
}

/**
 * Accumulates parameterised WHERE conditions and their values so resolvers
 * never hand-number `$n` placeholders. Blank values are skipped.
 */
export class WhereBuilder {
  private readonly conditions: string[] = [];
  readonly params: unknown[] = [];

  constructor(initialConditions: string[] = []) {
    this.conditions.push(...initialConditions);
  }

  private placeholder(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  eq(column: string, value: unknown): this {
    if (isBlank(value)) return this;
    this.conditions.push(`${column} = ${this.placeholder(value)}`);
    return this;
  }

  eqIgnoreCase(column: string, value: string | undefined): this {
    if (isBlank(value)) return this;
    this.conditions.push(`LOWER(${column}) = LOWER(${this.placeholder(value)})`);
    return this;
  }

  raw(condition: string): this {
    this.conditions.push(condition);
    return this;
  }

  /**
   * Row-wise tuple comparison for keyset pagination: strictly before the
   * given (timestamp, id) cursor, ordered the same way as `ORDER BY
   * COALESCE(timestamp, 'infinity') DESC, id DESC`. Matches
   * idx_flashes_timestamp_id_keyset's expression text so the planner can use
   * it instead of an OFFSET-style scan.
   */
  keysetBefore(timestampColumn: string, idColumn: string, timestampEpochSeconds: string | null, id: string): this {
    const tsParam = this.placeholder(timestampEpochSeconds);
    const idParam = this.placeholder(id);
    this.conditions.push(
      `(COALESCE(${timestampColumn}, 'infinity'::timestamp), ${idColumn}) < (COALESCE(to_timestamp(${tsParam}::bigint), 'infinity'::timestamp), ${idParam}::bigint)`
    );
    return this;
  }

  /** `WHERE a AND b`, or an empty string when there are no conditions. */
  clause(): string {
    return this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
  }

  /** Appends LIMIT/OFFSET params and returns the SQL fragment. */
  paginate(limit: number, offset: number): string {
    return `LIMIT ${this.placeholder(limit)} OFFSET ${this.placeholder(offset)}`;
  }

  limit(limit: number): string {
    return `LIMIT ${this.placeholder(limit)}`;
  }
}
