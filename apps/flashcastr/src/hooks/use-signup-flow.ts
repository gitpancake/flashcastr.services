"use client";

import { useCallback, useState } from "react";
import { sdk } from "@farcaster/miniapp-sdk";
import { getCsrfToken, signIn } from "next-auth/react";
import { gqlFetch } from "@/lib/graphql/client";
import {
  ALL_FLASH_PLAYERS_QUERY,
  INITIATE_SIGNUP_MUTATION,
} from "@/lib/graphql/queries";
import { usePollSigner } from "./use-poll-signer";
import type {
  SignupState,
  InitiateSignupResponse,
  AppUser,
} from "@/types/auth";

export function useSignupFlow(onComplete: (user: AppUser) => void) {
  const [state, setState] = useState<SignupState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [signerUuid, setSignerUuid] = useState("");
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [isSignedIn, setIsSignedIn] = useState(false);

  const handleSignIn = useCallback(async () => {
    try {
      const nonce = await getCsrfToken();
      if (!nonce) throw new Error("Failed to get CSRF token");

      const result = await sdk.actions.signIn({ nonce });
      const signInResult = await signIn("credentials", {
        message: result.message,
        signature: result.signature,
        redirect: false,
      });

      if (signInResult?.error) throw new Error(signInResult.error);
      setIsSignedIn(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    }
  }, []);

  const searchUsername = useCallback(async (name: string) => {
    setUsername(name);
    setState("searching");
    setError(null);

    try {
      const data = await gqlFetch<{ allFlashesPlayers: string[] }>(
        ALL_FLASH_PLAYERS_QUERY,
        { username: name }
      );
      setState(data.allFlashesPlayers.length > 0 ? "found" : "not_found");
    } catch {
      setState("not_found");
    }
  }, []);

  const initiateSignup = useCallback(async () => {
    setState("initiating");
    setError(null);

    try {
      const data = await gqlFetch<{
        initiateSignup: InitiateSignupResponse;
      }>(INITIATE_SIGNUP_MUTATION, { username });

      const result = data.initiateSignup;
      setSignerUuid(result.signer_uuid);
      setApprovalUrl(result.signer_approval_url);
      setState("awaiting_approval");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Signup initiation failed");
    }
  }, [username]);

  const handlePollSuccess = useCallback(
    (user: AppUser) => {
      setState("complete");
      onComplete(user);
    },
    [onComplete]
  );

  const handlePollError = useCallback((message: string) => {
    setState("error");
    setError(message);
  }, []);

  const { status: pollStatus } = usePollSigner({
    signerUuid,
    username,
    enabled: state === "awaiting_approval",
    onSuccess: handlePollSuccess,
    onError: handlePollError,
  });

  const reset = useCallback(() => {
    setState("idle");
    setError(null);
    setUsername("");
    setSignerUuid("");
    setApprovalUrl(null);
  }, []);

  return {
    state,
    error,
    username,
    approvalUrl,
    pollStatus,
    isSignedIn,
    handleSignIn,
    searchUsername,
    initiateSignup,
    reset,
  };
}
