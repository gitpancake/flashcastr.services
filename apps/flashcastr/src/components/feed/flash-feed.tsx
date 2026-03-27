"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FeedHeader } from "./feed-header";
import { FlashGrid } from "./flash-grid";
import { useUnifiedFlashes } from "@/hooks/use-unified-flashes";
import { useFlashcastrFlashes } from "@/hooks/use-flashcastr-flashes";
import { useFlashSubscription } from "@/hooks/use-flash-subscription";
import {
  normalizeUnifiedFlash,
  normalizeFlashcastrFlash,
} from "@/lib/flash-utils";
import type { FeedMode, ViewMode } from "@/types/flash";

const VIEW_STORAGE_KEY = "flashcastr-view-mode";
const FEED_STORAGE_KEY = "flashcastr-feed-mode";

function getStored<T extends string>(key: string, valid: T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const stored = localStorage.getItem(key);
  return valid.includes(stored as T) ? (stored as T) : fallback;
}

export function FlashFeed() {
  const [viewMode, setViewMode] = useState<ViewMode>("medium");
  const [feedMode, setFeedMode] = useState<FeedMode>("global");

  const global = useUnifiedFlashes();
  const players = useFlashcastrFlashes();

  useFlashSubscription();

  // Hydrate from localStorage after mount
  useEffect(() => {
    setViewMode(getStored<ViewMode>(VIEW_STORAGE_KEY, ["small", "medium", "large"], "medium"));
    setFeedMode(getStored<FeedMode>(FEED_STORAGE_KEY, ["global", "players"], "global"));
  }, []);

  const isGlobal = feedMode === "global";
  const active = isGlobal ? global : players;

  const flashes = useMemo(
    () =>
      isGlobal
        ? global.flashes.map(normalizeUnifiedFlash)
        : players.flashes.map(normalizeFlashcastrFlash),
    [isGlobal, global.flashes, players.flashes]
  );

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem(VIEW_STORAGE_KEY, mode);
  }, []);

  const handleFeedModeChange = useCallback((mode: FeedMode) => {
    setFeedMode(mode);
    localStorage.setItem(FEED_STORAGE_KEY, mode);
  }, []);

  const handleLoadMore = useCallback(() => {
    active.fetchNextPage();
  }, [active]);

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-6">
      <FeedHeader
        flashCount={flashes.length}
        feedMode={feedMode}
        onFeedModeChange={handleFeedModeChange}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
      />
      <FlashGrid
        flashes={flashes}
        viewMode={viewMode}
        isLoading={active.isLoading}
        isFetchingNextPage={active.isFetchingNextPage}
        hasNextPage={!!active.hasNextPage}
        onLoadMore={handleLoadMore}
      />
    </div>
  );
}
