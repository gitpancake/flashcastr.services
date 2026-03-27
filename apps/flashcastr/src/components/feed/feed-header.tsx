"use client";

import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ViewToggle } from "./view-toggle";
import type { ViewMode } from "@/types/flash";

interface FeedHeaderProps {
  flashCount: number;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  playerFilter: string;
  onPlayerFilterChange: (player: string) => void;
}

export function FeedHeader({
  flashCount,
  viewMode,
  onViewModeChange,
  playerFilter,
  onPlayerFilterChange,
}: FeedHeaderProps) {
  return (
    <div className="mb-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">
            {playerFilter ? `@${playerFilter}` : "Global Feed"}
          </h1>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-green-500" />
            </span>
            LIVE
          </div>
          {flashCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {flashCount.toLocaleString()} flashes
            </span>
          )}
        </div>
        <ViewToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Filter by player..."
          value={playerFilter}
          onChange={(e) => onPlayerFilterChange(e.target.value)}
          className="pl-9 pr-9 h-8 text-sm"
        />
        {playerFilter && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
            onClick={() => onPlayerFilterChange("")}
          >
            <X className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
