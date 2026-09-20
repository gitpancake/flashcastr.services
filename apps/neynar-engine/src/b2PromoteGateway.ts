import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { copyCandidateToKeepTier, type CopyDestination, type CopySource } from "../../../scripts/lib/promote-copy.js";
import type { PromoteGateway } from "./promoteGateway.js";

export interface B2PromoteGatewayOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly keyId: string;
  readonly applicationKey: string;
}

interface S3ResponseBody {
  transformToByteArray(): Promise<Uint8Array>;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  return Buffer.from(await (body as S3ResponseBody).transformToByteArray());
}

export class B2PromoteGateway implements PromoteGateway {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: B2PromoteGatewayOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.keyId, secretAccessKey: options.applicationKey },
    });
    this.bucket = options.bucket;
  }

  async promoteFeedToKeep(flashId: number, ipfsCid: string): Promise<void> {
    const source: CopySource = {
      fetchFeedBytes: async (hash) => {
        const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: `feed/${hash}` }));
        return { data: await bodyToBuffer(res.Body), contentType: res.ContentType ?? "image/jpeg" };
      },
      fetchPinataBytes: () => {
        throw new Error("B2PromoteGateway.promoteFeedToKeep only copies from feed/, never Pinata");
      },
    };
    const destination: CopyDestination = {
      putObject: async (key, data, contentType) => {
        await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
      },
      getObject: async (key) => {
        const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
        return bodyToBuffer(res.Body);
      },
    };

    const outcome = await copyCandidateToKeepTier(
      { flash_id: flashId, ipfs_cid: ipfsCid, image_tier: "feed" },
      source,
      destination
    );
    if (!outcome.verified) {
      throw new Error(`promoteFeedToKeep: sha256 mismatch after copying ${ipfsCid} to keep/ (flash ${flashId})`);
    }
  }
}
