import type { DownloadedImage } from "./imageSource.js";

export interface Pinner {
  pin(image: DownloadedImage, filename: string): Promise<string>;
}
