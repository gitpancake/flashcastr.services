export interface NewsItem {
  readonly sourceLabel: string;
  readonly url: string;
  readonly title: string;
  readonly summary: string;
  readonly publishedAt: string | null;
}

export interface NewsSource {
  readonly label: string;
  fetchRecent(): Promise<NewsItem[]>;
}
