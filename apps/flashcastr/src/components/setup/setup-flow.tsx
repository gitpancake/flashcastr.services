"use client";

import { useState } from "react";
import { LogIn, Search, AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApprovalStep } from "./approval-step";
import { useSignupFlow } from "@/hooks/use-signup-flow";
import type { AppUser } from "@/types/auth";

interface SetupFlowProps {
  onComplete: (user: AppUser) => void;
  onSkip: () => void;
}

export function SetupFlow({ onComplete, onSkip }: SetupFlowProps) {
  const [searchInput, setSearchInput] = useState("");

  const {
    state,
    error,
    approvalUrl,
    pollStatus,
    isSignedIn,
    handleSignIn,
    searchUsername,
    initiateSignup,
    reset,
  } = useSignupFlow(onComplete);

  // Step 1: Sign In with Farcaster
  if (!isSignedIn) {
    return (
      <Card className="max-w-md mx-auto">
        <CardHeader>
          <CardTitle>Link Your Account</CardTitle>
          <CardDescription>
            Sign in with Farcaster to connect your Flash Invaders account
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={handleSignIn} className="w-full">
            <LogIn className="size-4" />
            Sign In with Farcaster
          </Button>
          <Button variant="ghost" onClick={onSkip} className="w-full text-xs">
            Skip for now
          </Button>
          {error && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="size-3" /> {error}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  // Step 3: Awaiting approval
  if (state === "awaiting_approval" && approvalUrl) {
    return (
      <div className="max-w-md mx-auto">
        <ApprovalStep approvalUrl={approvalUrl} pollStatus={pollStatus} />
      </div>
    );
  }

  // Error state
  if (state === "error") {
    return (
      <Card className="max-w-md mx-auto">
        <CardContent className="py-6 space-y-3">
          <p className="text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="size-4" /> {error}
          </p>
          <Button variant="outline" onClick={reset} className="w-full">
            <RefreshCw className="size-4" /> Try Again
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Step 2: Search username + initiate signup
  return (
    <Card className="max-w-md mx-auto">
      <CardHeader>
        <CardTitle>Link Flash Invaders Account</CardTitle>
        <CardDescription>
          Enter your Flash Invaders player name to connect
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            placeholder="Player name..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchInput.trim())
                searchUsername(searchInput.trim());
            }}
          />
          <Button
            variant="outline"
            onClick={() => searchUsername(searchInput.trim())}
            disabled={!searchInput.trim() || state === "searching"}
          >
            <Search className="size-4" />
          </Button>
        </div>

        {state === "searching" && (
          <p className="text-xs text-muted-foreground">Searching...</p>
        )}

        {state === "found" && (
          <div className="space-y-2">
            <p className="text-xs text-green-500">Player found</p>
            <Button
              onClick={initiateSignup}
              className="w-full"
            >
              Proceed
            </Button>
          </div>
        )}

        {state === "not_found" && (
          <div className="space-y-2">
            <p className="text-xs text-yellow-500">Player not found</p>
            <Button
              variant="outline"
              onClick={initiateSignup}
              className="w-full"
            >
              Proceed Anyway
            </Button>
          </div>
        )}

        {state === "initiating" && (
          <p className="text-xs text-muted-foreground">
            Creating signer...
          </p>
        )}

        <Button variant="ghost" onClick={onSkip} className="w-full text-xs">
          Skip for now
        </Button>
      </CardContent>
    </Card>
  );
}
