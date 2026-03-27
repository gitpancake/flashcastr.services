"use client";

import Image from "next/image";
import { getImageUrl, formatTimeAgo, parseTimestamp } from "@/lib/flash-utils";
import type { NormalizedFlash, ViewMode } from "@/types/flash";

interface FlashCardProps {
  flash: NormalizedFlash;
  viewMode: ViewMode;
}

export function FlashCard({ flash, viewMode }: FlashCardProps) {
  const imageUrl = getImageUrl(flash.ipfs_cid);
  const ts = parseTimestamp(flash.timestamp);
  const timeAgo = ts ? formatTimeAgo(ts) : null;
  const displayName =
    flash.identification?.confidence && flash.identification.confidence >= 0.8
      ? flash.identification.matched_flash_name
      : null;

  if (viewMode === "small") {
    return (
      <div className="group relative aspect-square overflow-hidden rounded-sm bg-muted">
        <Image
          src={imageUrl}
          alt={`Flash #${flash.flash_id}`}
          fill
          className="object-cover transition-transform duration-200 group-hover:scale-105"
          sizes="(max-width: 640px) 33vw, (max-width: 768px) 25vw, 16vw"
        />
        <div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="p-1.5 text-[10px] font-mono text-white">
            #{flash.flash_id}
          </span>
        </div>
      </div>
    );
  }

  if (viewMode === "medium") {
    return (
      <div className="group overflow-hidden rounded-md bg-card">
        <div className="relative aspect-square overflow-hidden">
          <Image
            src={imageUrl}
            alt={`Flash #${flash.flash_id}`}
            fill
            className="object-cover transition-transform duration-200 group-hover:scale-105"
            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, 25vw"
          />
        </div>
        <div className="p-2 space-y-0.5">
          <div className="flex items-center justify-between text-xs">
            <span className="truncate font-medium">
              {flash.city ?? "Unknown"}
            </span>
            {timeAgo && (
              <span className="shrink-0 text-muted-foreground">{timeAgo}</span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {flash.username ? `@${flash.username}` : flash.player ?? "—"}
          </p>
        </div>
      </div>
    );
  }

  // large
  return (
    <div className="group overflow-hidden rounded-lg bg-card border border-border">
      <div className="relative aspect-square overflow-hidden">
        <Image
          src={imageUrl}
          alt={`Flash #${flash.flash_id}`}
          fill
          className="object-cover transition-transform duration-200 group-hover:scale-105"
          sizes="(max-width: 768px) 100vw, 50vw"
        />
      </div>
      <div className="p-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {flash.pfp_url && (
              <Image
                src={flash.pfp_url}
                alt={flash.username ?? ""}
                width={24}
                height={24}
                className="rounded-full"
              />
            )}
            <span className="font-mono text-sm font-bold text-primary">
              #{flash.flash_id}
            </span>
          </div>
          {timeAgo && (
            <span className="text-xs text-muted-foreground">{timeAgo}</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          {flash.username ? (
            <span>@{flash.username}</span>
          ) : (
            flash.player && <span>{flash.player}</span>
          )}
          {flash.city && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{flash.city}</span>
            </>
          )}
        </div>
        {displayName && (
          <p className="text-xs text-green-500 font-mono">[ID] {displayName}</p>
        )}
        {flash.text && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {flash.text}
          </p>
        )}
      </div>
    </div>
  );
}
