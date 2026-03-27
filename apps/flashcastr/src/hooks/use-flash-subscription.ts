"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSubscriptionClient } from "@/lib/graphql/subscriptions";
import { FLASH_STORED_SUBSCRIPTION } from "@/lib/graphql/queries";
import type { FlashStoredEvent, UnifiedFlash } from "@/types/flash";

interface FlashStoredPayload {
  flashStored: FlashStoredEvent;
}

export function useFlashSubscription() {
  const queryClient = useQueryClient();
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const client = getSubscriptionClient();

    unsubscribeRef.current = client.subscribe<FlashStoredPayload>(
      { query: FLASH_STORED_SUBSCRIPTION },
      {
        next: ({ data }) => {
          if (!data?.flashStored?.ipfs_cid) return;

          const newFlash: UnifiedFlash = {
            ...data.flashStored,
            text: null,
            flash_count: null,
            farcaster_user: null,
            identification: null,
          };

          queryClient.setQueryData<{ pages: UnifiedFlash[][]; pageParams: number[] }>(
            ["unified-flashes"],
            (old) => {
              if (!old) return old;
              const firstPage = old.pages[0] ?? [];
              // Don't add if already exists
              if (firstPage.some((f) => f.flash_id === newFlash.flash_id)) return old;
              return {
                ...old,
                pages: [[newFlash, ...firstPage], ...old.pages.slice(1)],
              };
            }
          );
        },
        error: (err) => {
          console.error("Subscription error:", err);
        },
        complete: () => {},
      }
    );

    return () => {
      unsubscribeRef.current?.();
    };
  }, [queryClient]);
}
