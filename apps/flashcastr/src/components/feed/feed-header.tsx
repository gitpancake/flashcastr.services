import { ViewToggle } from "./view-toggle";
import type { ViewMode } from "@/types/flash";

interface FeedHeaderProps {
  flashCount: number;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

export function FeedHeader({
  flashCount,
  viewMode,
  onViewModeChange,
}: FeedHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold">Global Feed</h1>
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
  );
}
