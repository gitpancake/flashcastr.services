import { NeynarAPIClient } from "@neynar/nodejs-sdk";
import { requireEnv } from "@flashcastr/config";

const NEYNAR_API_KEY = requireEnv("NEYNAR_API_KEY");

const neynarClient = new NeynarAPIClient({ apiKey: NEYNAR_API_KEY });

export default neynarClient;
