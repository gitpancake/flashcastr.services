"use client";

import { useCallback, useState } from "react";
import { useMiniApp } from "@/providers/miniapp-provider";
import { useAppUser } from "@/hooks/use-app-user";
import { Header } from "@/components/header";
import { FlashFeed } from "@/components/feed/flash-feed";
import { SetupFlow } from "@/components/setup/setup-flow";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AppUser } from "@/types/auth";

export function AppShell() {
  const { isLoaded, context } = useMiniApp();
  const fid = context?.user?.fid;
  const { appUser, isLoading, refetch } = useAppUser(fid);
  const [showSetup, setShowSetup] = useState(false);

  const handleSetupComplete = useCallback(
    (_user: AppUser) => {
      setShowSetup(false);
      refetch();
    },
    [refetch]
  );

  // SDK still loading
  if (!isLoaded) {
    return (
      <div className="w-full max-w-6xl mx-auto px-4 py-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  // Setup flow active
  if (showSetup) {
    return (
      <div className="w-full max-w-6xl mx-auto px-4 py-6">
        <SetupFlow
          onComplete={handleSetupComplete}
          onSkip={() => setShowSetup(false)}
        />
      </div>
    );
  }

  // Loading app user
  if (fid && isLoading) {
    return (
      <div className="w-full max-w-6xl mx-auto px-4 py-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div>
      <Header />

      {/* Banner for users with Farcaster context but no linked account */}
      {fid && !appUser && (
        <div className="bg-secondary border-b border-border px-4 py-3 text-center">
          <p className="text-sm text-muted-foreground inline">
            Connect your Flash Invaders account to unlock all features
          </p>
          <Button
            variant="link"
            size="sm"
            className="ml-2"
            onClick={() => setShowSetup(true)}
          >
            Link Account
          </Button>
        </div>
      )}

      <FlashFeed />
    </div>
  );
}
