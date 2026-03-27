"use client";

import { Grid3X3, LayoutGrid, Square } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ViewMode } from "@/types/flash";

interface ViewToggleProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

export function ViewToggle({ viewMode, onViewModeChange }: ViewToggleProps) {
  return (
    <ToggleGroup
      type="single"
      value={viewMode}
      onValueChange={(value) => {
        if (value) onViewModeChange(value as ViewMode);
      }}
    >
      <ToggleGroupItem value="small" aria-label="Small grid">
        <Grid3X3 className="size-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="medium" aria-label="Medium grid">
        <LayoutGrid className="size-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="large" aria-label="Large grid">
        <Square className="size-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
