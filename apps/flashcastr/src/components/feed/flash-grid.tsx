"use client";

import { useEffect, useRef } from "react";
import { FlashCard } from "./flash-card";
import { Skeleton } from "@/components/ui/skeleton";
import type { NormalizedFlash, ViewMode } from "@/types/flash";

interface FlashGridProps {
  flashes: NormalizedFlash[];
  viewMode: ViewMode;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  onLoadMore: () => void;
}

const GRID_CLASSES: Record<ViewMode, string> = {
  small: "grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1",
  medium: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2",
  large: "grid-cols-1 md:grid-cols-2 gap-4",
};

const SKELETON_COUNTS: Record<ViewMode, number> = {
  small: 18,
  medium: 8,
  large: 4,
};

export function FlashGrid({
  flashes,
  viewMode,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  onLoadMore,
}: FlashGridProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          onLoadMore();
        }
      },
      { rootMargin: "400px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  if (isLoading) {
    return (
      <div className={`grid ${GRID_CLASSES[viewMode]}`}>
        {Array.from({ length: SKELETON_COUNTS[viewMode] }).map((_, i) => (
          <Skeleton key={i} className="aspect-square rounded-md" />
        ))}
      </div>
    );
  }

  if (flashes.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        No flashes found
      </div>
    );
  }

  return (
    <>
      <div className={`grid ${GRID_CLASSES[viewMode]}`}>
        {flashes.map((flash) => (
          <FlashCard key={flash.flash_id} flash={flash} viewMode={viewMode} />
        ))}
      </div>

      <div ref={sentinelRef} className="h-px" />

      {isFetchingNextPage && (
        <div className={`grid ${GRID_CLASSES[viewMode]} mt-2`}>
          {Array.from({ length: SKELETON_COUNTS[viewMode] / 2 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-md" />
          ))}
        </div>
      )}
    </>
  );
}
