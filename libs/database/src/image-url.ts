export interface ImageUrlRow {
  flash_id: number | string;
  image_tier: string | null;
  img: string | null;
}

export interface ImageUrlConfig {
  apiPublicBase: string;
  origin: string;
}

export function buildImageUrl(row: ImageUrlRow, config: ImageUrlConfig): string | null {
  if (row.image_tier) {
    return `${config.apiPublicBase}/i/${row.flash_id}`;
  }
  if (row.img) {
    return `${config.origin}${row.img}`;
  }
  return null;
}
