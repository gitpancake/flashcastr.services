interface OnChainSignerEvent {
  readonly signerEventBody?: { readonly key?: string };
}

export async function isSignerRegisteredOnChain(hubHttpUrl: string, hubApiKey: string, fid: number, publicKeyHex: string): Promise<boolean> {
  const response = await fetch(`${hubHttpUrl}/v1/onChainSignersByFid?fid=${fid}`, { headers: { "x-api-key": hubApiKey } });
  if (!response.ok) throw new Error(`onChainSignersByFid → ${response.status}`);
  const payload = (await response.json()) as { events?: OnChainSignerEvent[] };
  const registeredKeys = (payload.events ?? []).map((event) => event.signerEventBody?.key?.toLowerCase());
  return registeredKeys.includes(publicKeyHex.toLowerCase());
}
