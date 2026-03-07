const IPFS_GATEWAY = process.env.IPFS_GATEWAY || "https://fuchsia-rich-lungfish-648.mypinata.cloud";

export function getIpfsUrl(cid: string | null): string | null {
  if (!cid) return null;
  return `${IPFS_GATEWAY}/ipfs/${cid}`;
}
