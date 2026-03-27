import { createClient, type Client } from "graphql-ws";
import { WS_URL } from "../constants";

let client: Client | null = null;

export function getSubscriptionClient(): Client {
  if (!client) {
    client = createClient({
      url: WS_URL,
      shouldRetry: () => true,
      retryAttempts: Infinity,
    });
  }
  return client;
}
