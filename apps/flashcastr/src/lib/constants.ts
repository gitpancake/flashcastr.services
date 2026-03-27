export const API_URL =
  process.env.NEXT_PUBLIC_FLASHCASTR_API_URL ?? "http://localhost:4000/graphql";

export const WS_URL = API_URL.replace(/^http/, "ws");

export const IPFS_GATEWAY =
  process.env.NEXT_PUBLIC_IPFS_GATEWAY ??
  "https://fuchsia-rich-lungfish-648.mypinata.cloud/ipfs";

export const FEED_PAGE_SIZE = 20;
