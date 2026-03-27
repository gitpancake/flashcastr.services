import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { AuthProvider } from "@/providers/auth-provider";
import { QueryProvider } from "@/providers/query-provider";
import { WagmiProvider } from "@/providers/wagmi-provider";
import { MiniAppProvider } from "@/providers/miniapp-provider";
import "./global.css";

const inter = Inter({ subsets: ["latin"] });

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const appName = process.env.NEXT_PUBLIC_FRAME_NAME ?? "Flashcastr";

export const metadata: Metadata = {
  title: appName,
  description: "Flash Invaders on Farcaster",
  openGraph: {
    title: appName,
    description: "Broadcast your Space Invader flashes.",
    url: appUrl,
    images: [{ url: `${appUrl}/frame-embed.png`, width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    creator: "@flashcastr",
    site: "@flashcastr",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <AuthProvider>
          <QueryProvider>
            <WagmiProvider>
              <MiniAppProvider>{children}</MiniAppProvider>
            </WagmiProvider>
          </QueryProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
