"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { gqlFetch } from "@/lib/graphql/client";
import { FLASHCASTR_FLASHES_QUERY } from "@/lib/graphql/queries";
import { FEED_PAGE_SIZE } from "@/lib/constants";
import type { FlashcastrFlash } from "@/types/flash";

interface FlashcastrFlashesResponse {
  flashes: FlashcastrFlash[];
}

export function useFlashcastrFlashes() {
  const query = useInfiniteQuery({
    queryKey: ["flashcastr-flashes"],
    queryFn: async ({ pageParam = 1 }) => {
      const data = await gqlFetch<FlashcastrFlashesResponse>(
        FLASHCASTR_FLASHES_QUERY,
        { page: pageParam, limit: FEED_PAGE_SIZE }
      );
      return data.flashes;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < FEED_PAGE_SIZE) return undefined;
      return allPages.length + 1;
    },
  });

  const flashes =
    query.data?.pages
      .flatMap((page) => page)
      .filter((f) => f.flash.ipfs_cid) ?? [];

  const seen = new Set<string>();
  const dedupedFlashes = flashes.filter((f) => {
    if (seen.has(f.flash_id)) return false;
    seen.add(f.flash_id);
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
