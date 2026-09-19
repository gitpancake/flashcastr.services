export interface DownloadedImage {
  readonly data: ArrayBuffer;
  readonly contentType: string;
}

export interface ImageSource {
  download(imageUrl: string): Promise<DownloadedImage>;
}
