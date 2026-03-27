"use client";

import { useEffect, useRef, useState } from "react";
import { gqlFetch } from "@/lib/graphql/client";
import { POLL_SIGNUP_STATUS_QUERY } from "@/lib/graphql/queries";
import type { PollSignupResponse, AppUser } from "@/types/auth";

interface PollSignerOptions {
  signerUuid: string;
  username: string;
  enabled: boolean;
  onSuccess: (user: AppUser) => void;
  onError: (message: string) => void;
}

const POLL_INTERVAL = 2000;
const POLL_TIMEOUT = 300_000; // 5 minutes

export function usePollSigner({
  signerUuid,
  username,
  enabled,
  onSuccess,
  onError,
}: PollSignerOptions) {
  const [status, setStatus] = useState<string>("idle");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled || !signerUuid || !username) return;

    startRef.current = Date.now();

    intervalRef.current = setInterval(async () => {
      if (Date.now() - startRef.current > POLL_TIMEOUT) {
        clearInterval(intervalRef.current!);
        setStatus("timeout");
        onError("Signup process timed out. Please try again.");
        return;
      }

      try {
        const data = await gqlFetch<{
          pollSignupStatus: PollSignupResponse;
        }>(POLL_SIGNUP_STATUS_QUERY, {
          signer_uuid: signerUuid,
          username,
        });

        const result = data.pollSignupStatus;
        setStatus(result.status);

        if (result.status === "APPROVED_FINALIZED" && result.user) {
          clearInterval(intervalRef.current!);
          onSuccess(result.user);
        } else if (
          result.status === "REVOKED" ||
          result.status.startsWith("ERROR")
        ) {
          clearInterval(intervalRef.current!);
          onError(result.message ?? "Signup failed.");
        }
      } catch (err) {
        clearInterval(intervalRef.current!);
        onError(err instanceof Error ? err.message : "Polling failed.");
      }
    }, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled, signerUuid, username, onSuccess, onError]);

  return { status };
}
