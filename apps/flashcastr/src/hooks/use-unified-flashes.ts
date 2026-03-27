"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { gqlFetch } from "@/lib/graphql/client";
import { UNIFIED_FLASHES_QUERY } from "@/lib/graphql/queries";
import { FEED_PAGE_SIZE } from "@/lib/constants";
import type { UnifiedFlash } from "@/types/flash";

interface UnifiedFlashesResponse {
  unifiedFlashes: UnifiedFlash[];
}

export interface FlashFilters {
  player?: string;
  city?: string;
}

export function useUnifiedFlashes(filters: FlashFilters = {}) {
  const query = useInfiniteQuery({
    queryKey: ["unified-flashes", filters],
    queryFn: async ({ pageParam = 1 }) => {
      const data = await gqlFetch<UnifiedFlashesResponse>(
        UNIFIED_FLASHES_QUERY,
        {
          page: pageParam,
          limit: FEED_PAGE_SIZE,
          ...(filters.player && { player: filters.player }),
          ...(filters.city && { city: filters.city }),
        }
      );
      return data.unifiedFlashes;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < FEED_PAGE_SIZE) return undefined;
      return allPages.length + 1;
    },
  });

  // Flatten all pages and deduplicate by flash_id, filter out flashes without ipfs_cid
  const flashes =
    query.data?.pages.flatMap((page) => page).filter((flash) => flash.ipfs_cid) ??
    [];

  const seen = new Set<string>();
  const dedupedFlashes = flashes.filter((flash) => {
    if (seen.has(flash.flash_id)) return false;
    seen.add(flash.flash_id);
    return true;
  });

  return {
    flashes: dedupedFlashes,
    isLoading: query.isLoading,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
