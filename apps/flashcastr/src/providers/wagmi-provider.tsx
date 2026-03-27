"use client";

import { WagmiProvider as WagmiProviderBase, createConfig, http } from "wagmi";
import { base, optimism, mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import type { ReactNode } from "react";

const config = createConfig({
  chains: [base, optimism, mainnet],
  transports: {
    [base.id]: http(),
    [optimism.id]: http(),
    [mainnet.id]: http(),
  },
  connectors: [injected()],
});

export function WagmiProvider({ children }: { children: ReactNode }) {
  return <WagmiProviderBase config={config}>{children}</WagmiProviderBase>;
}
