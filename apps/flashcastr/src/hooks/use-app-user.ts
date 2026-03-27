"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gqlFetch } from "@/lib/graphql/client";
import { USERS_QUERY } from "@/lib/graphql/queries";
import type { AppUser } from "@/types/auth";

interface UsersResponse {
  users: AppUser[];
}

export function useAppUser(fid: number | undefined) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["app-user", fid],
    queryFn: async () => {
      if (!fid) return null;
      const data = await gqlFetch<UsersResponse>(USERS_QUERY, { fid });
      return data.users[0] ?? null;
    },
    enabled: !!fid,
  });

  const refetch = () => queryClient.invalidateQueries({ queryKey: ["app-user", fid] });

  return {
    appUser: query.data ?? null,
    isLoading: query.isLoading,
    refetch,
  };
}
