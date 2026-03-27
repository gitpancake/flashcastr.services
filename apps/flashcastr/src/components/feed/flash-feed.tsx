"use client";

import { useCallback, useEffect, useState } from "react";
import { FeedHeader } from "./feed-header";
import { FlashGrid } from "./flash-grid";
import { useUnifiedFlashes } from "@/hooks/use-unified-flashes";
import { useFlashSubscription } from "@/hooks/use-flash-subscription";
import type { ViewMode } from "@/types/flash";

const STORAGE_KEY = "flashcastr-view-mode";

function getInitialViewMode(): ViewMode {
  if (typeof window === "undefined") return "medium";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "small" || stored === "medium" || stored === "large")
    return stored;
  return "medium";
}

export function FlashFeed() {
  const [viewMode, setViewMode] = useState<ViewMode>("medium");
  const { flashes, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useUnifiedFlashes();

  useFlashSubscription();

  // Hydrate view mode from localStorage after mount
  useEffect(() => {
    setViewMode(getInitialViewMode());
  }, []);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem(STORAGE_KEY, mode);
  }, []);

  const handleLoadMore = useCallback(() => {
    fetchNextPage();
  }, [fetchNextPage]);

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-6">
      <FeedHeader
        flashCount={flashes.length}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
      />
      <FlashGrid
        flashes={flashes}
        viewMode={viewMode}
        isLoading={isLoading}
        isFetchingNextPage={isFetchingNextPage}
        hasNextPage={!!hasNextPage}
        onLoadMore={handleLoadMore}
      />
    </div>
  );
}
