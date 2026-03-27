import type { AuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { createAppClient, viemConnector } from "@farcaster/auth-client";

function getDomain(): string {
  const url = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  try {
    return new URL(url).host;
  } catch {
    return "localhost:3000";
  }
}

export const authOptions: AuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Sign in with Farcaster",
      credentials: {
        message: { label: "Message", type: "text" },
        signature: { label: "Signature", type: "text" },
      },
      async authorize(credentials) {
        if (!credentials?.message || !credentials?.signature) return null;

        const appClient = createAppClient({ ethereum: viemConnector() });

        const verifyResponse = await appClient.verifySignInMessage({
          message: credentials.message,
          signature: credentials.signature as `0x${string}`,
          domain: getDomain(),
          nonce: (credentials as Record<string, string>).csrfToken,
        });

        if (!verifyResponse.success) return null;

        return {
          id: verifyResponse.fid.toString(),
        };
      },
    }),
  ],
  callbacks: {
    session({ session, token }) {
      if (token.sub) {
        (session.user as { fid: number }).fid = parseInt(token.sub, 10);
      }
      return session;
    },
  },
  cookies: {
    sessionToken: {
      name: "next-auth.session-token",
      options: { httpOnly: true, sameSite: "none", secure: true, path: "/" },
    },
    callbackUrl: {
      name: "next-auth.callback-url",
      options: { sameSite: "none", secure: true, path: "/" },
    },
    csrfToken: {
      name: "next-auth.csrf-token",
      options: { httpOnly: true, sameSite: "none", secure: true, path: "/" },
    },
  },
};
