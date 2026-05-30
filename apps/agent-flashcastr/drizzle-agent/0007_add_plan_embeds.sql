-- HEN-584: daily-prep emits highlight plans that need cast embeds.
-- The cast_plans table previously had no embeds column — embeds were only
-- carried on cast_queue. We need them on the plan so publishReadyPlans
-- can pass them through to dispatchCast.
ALTER TABLE "farcaster_cast_plans" ADD COLUMN IF NOT EXISTS "embeds" jsonb DEFAULT '[]'::jsonb;
