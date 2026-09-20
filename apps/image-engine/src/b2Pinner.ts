import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { withRetry } from "@flashcastr/resilience";
import type { DownloadedImage } from "./imageSource.js";
import type { Pinner } from "./pinner.js";

export interface B2PinnerOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly keyId: string;
  readonly applicationKey: string;
}

export class B2Pinner implements Pinner {
  private readonly client: S3Client;

  constructor(private readonly options: B2PinnerOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.keyId, secretAccessKey: options.applicationKey },
    });
  }

  pin(image: DownloadedImage, _filename: string): Promise<string> {
    return withRetry(() => this.pinOnce(image), {
      maxAttempts: 6,
      baseDelayMs: 10000,
      maxDelayMs: 200000,
      jitterMs: 1000,
    });
  }

  private async pinOnce(image: DownloadedImage): Promise<string> {
    const hash = createHash("sha256").update(Buffer.from(image.data)).digest("hex");
    // Content-addressed key: an overwrite of an identical hash is a no-op, so
    // no HEAD-before-PUT is needed.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: `feed/${hash}`,
        Body: Buffer.from(image.data),
        ContentType: image.contentType,
      })
    );
    return hash;
  }
}
