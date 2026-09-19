import axios from "axios";
import { withRetry } from "@flashcastr/resilience";
import type { DownloadedImage } from "./imageSource.js";
import type { Pinner } from "./pinner.js";

const PINATA_PIN_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

export interface PinataPinnerOptions {
  readonly jwt: string;
}

export class PinataPinner implements Pinner {
  constructor(private readonly options: PinataPinnerOptions) {}

  pin(image: DownloadedImage, filename: string): Promise<string> {
    return withRetry(() => this.pinOnce(image, filename), {
      maxAttempts: 6,
      baseDelayMs: 10000,
      maxDelayMs: 200000,
      jitterMs: 1000,
    });
  }

  private async pinOnce(image: DownloadedImage, filename: string): Promise<string> {
    const file = new File([new Uint8Array(image.data)], filename, { type: image.contentType });
    const formData = new FormData();
    formData.append("file", file);
    formData.append("pinataMetadata", JSON.stringify({ name: filename }));

    const response = await axios.post(PINATA_PIN_URL, formData, {
      headers: { Authorization: `Bearer ${this.options.jwt}`, "Content-Type": "multipart/form-data" },
      timeout: 60000,
      validateStatus: (status) => status < 500,
    });

    if (response.status === 429) throw new Error("Rate limited by Pinata API");
    if (response.status >= 400) throw new Error(`Pinata API error: ${response.status}`);
    return response.data.IpfsHash as string;
  }
}
