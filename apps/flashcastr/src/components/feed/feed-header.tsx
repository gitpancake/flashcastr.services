"use client";

import { Globe, Users } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ViewToggle } from "./view-toggle";
import type { FeedMode, ViewMode } from "@/types/flash";

interface FeedHeaderProps {
  flashCount: number;
  feedMode: FeedMode;
  onFeedModeChange: (mode: FeedMode) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

export function FeedHeader({
  flashCount,
  feedMode,
  onFeedModeChange,
  viewMode,
  onViewModeChange,
}: FeedHeaderProps) {
  return (
    <div className="mb-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ToggleGroup
            type="single"
            value={feedMode}
            onValueChange={(value) => {
              if (value) onFeedModeChange(value as FeedMode);
            }}
          >
            <ToggleGroupItem value="global" aria-label="Global feed">
              <Globe className="size-4" />
              <span className="text-xs">Global</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="players" aria-label="Players feed">
              <Users className="size-4" />
              <span className="text-xs">Players</span>
            </ToggleGroupItem>
          </ToggleGroup>

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
    </div>
  );
}
