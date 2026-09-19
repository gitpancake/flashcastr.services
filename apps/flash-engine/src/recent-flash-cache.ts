export class RecentFlashCache {
  private readonly ids = new Set<number>();

  constructor(private readonly maxSize: number) {}

  has(flashId: number): boolean {
    return this.ids.has(flashId);
  }

  remember(flashId: number): void {
    this.ids.add(flashId);
    const overflow = this.ids.size - this.maxSize;
    if (overflow <= 0) return;
    const iterator = this.ids.values();
    for (let i = 0; i < overflow; i++) {
      this.ids.delete(iterator.next().value!);
    }
  }

  seed(flashIds: Iterable<number>): void {
    for (const flashId of flashIds) this.ids.add(flashId);
  }

  get size(): number {
    return this.ids.size;
  }
}
