import {
  pgTable,
  text,
  boolean,
  timestamp,
  uuid,
  jsonb,
  uniqueIndex,
  index,
  integer,
  bigint,
  real,
  date,
  serial,
  numeric,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { CalendarAttendee } from '../events/types.js';

export const processSyncState = pgTable('process_sync_state', {
  processName: text('process_name').primaryKey(),
  syncToken: text('sync_token').notNull(),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: text('event_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  channel: text('channel').notNull(),
  read: boolean('read').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
  actionUrl: text('action_url'),
}, (table) => [
  uniqueIndex('event_channel_idx').on(table.eventId, table.channel),
]);

export const emails = pgTable('emails', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: text('message_id').notNull().unique(),
  threadId: text('thread_id').notNull(),
  from: text('from_address').notNull(),
  subject: text('subject').notNull(),
  snippet: text('snippet').notNull(),
  labels: jsonb('labels').$type<string[]>().notNull().default([]),
  relevance: real('relevance'),
  classification: jsonb('classification'),
  /** Raw score contributions captured by `score-email.ts`. Null for historical rows (pre-LOS-355). */
  scoreBreakdown: jsonb('score_breakdown').$type<{
    senderImportance: number;
    domainRelevance: number;
    calendarContext: number;
    baseClassifier: number;
  }>(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  knowledgeProcessed: boolean('knowledge_processed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Learned per-sender importance score. Bumped by ±0.06 on each
 * EMAIL_RELEVANCE_RATED event; clamped to [0, 1]. agent-email reads this into
 * scoreEmail() as the `senderImportance` contribution.
 */
export const emailSenderImportance = pgTable('email_sender_importance', {
  senderEmail: text('sender_email').primaryKey(),
  score: real('score').notNull().default(0.5),
  sampleCount: integer('sample_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Learned per-domain relevance score. Same ±0.06 bump on user ratings; clamped.
 */
export const emailDomainRelevance = pgTable('email_domain_relevance', {
  domain: text('domain').primaryKey(),
  score: real('score').notNull().default(0.5),
  sampleCount: integer('sample_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only log of per-message user ratings. LOS-356 consumes this to
 * compute "7-day learning accuracy" — get the schema right now so that ticket
 * is a pure read-layer addition.
 */
export const emailRatingLog = pgTable('email_rating_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: text('message_id').notNull(),
  ratedAt: timestamp('rated_at', { withTimezone: true }).notNull().defaultNow(),
  relevant: boolean('relevant').notNull(),
  /** Snapshot of `emails.relevance` at the moment of rating — lets LOS-356
   *  compare agent-predicted vs user-labeled without a join to a mutable row. */
  relevanceAtRating: real('relevance_at_rating'),
}, (table) => [
  index('email_rating_log_message_idx').on(table.messageId),
  index('email_rating_log_rated_at_idx').on(table.ratedAt),
]);

export const calendarEvents = pgTable('calendar_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleEventId: text('google_event_id').notNull().unique(),
  title: text('title').notNull(),
  description: text('description'),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  endTime: timestamp('end_time', { withTimezone: true }).notNull(),
  location: text('location'),
  calendarName: text('calendar_name').notNull().default('primary'),
  category: text('category').notNull(), // 'meetup' | 'meeting' | 'personal' | 'social' | 'work' | 'other'
  attendees: jsonb('attendees').$type<CalendarAttendee[]>(),
  source: text('source'), // 'luma' | 'meetup' | 'manual' | null
  contentHash: text('content_hash'), // sha256 of display fields; skip publish when unchanged
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  prepTriggeredAt: timestamp('prep_triggered_at', { withTimezone: true }),
}, (table) => [
  index('calendar_start_time_idx').on(table.startTime),
]);

export const weatherForecasts = pgTable('weather_forecasts', {
  id: uuid('id').primaryKey().defaultRandom(),
  location: text('location').notNull(), // e.g., 'vancouver', 'north-van'
  forecastDate: date('forecast_date').notNull(),
  tempMax: real('temp_max').notNull(),
  tempMin: real('temp_min').notNull(),
  precipitation: real('precipitation').notNull(), // mm
  weatherCode: integer('weather_code').notNull(), // WMO weather code
  windSpeed: real('wind_speed').notNull(), // km/h
  uvIndex: real('uv_index').notNull(),
  sunrise: text('sunrise').notNull(), // ISO time
  sunset: text('sunset').notNull(), // ISO time
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('weather_location_date_idx').on(table.location, table.forecastDate),
  index('weather_forecast_date_idx').on(table.forecastDate),
]);

export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  ingredients: jsonb('ingredients').notNull(), // string[]
  instructions: jsonb('instructions').notNull(), // string[]
  prepTime: integer('prep_time').notNull(), // minutes
  cookTime: integer('cook_time').notNull(), // minutes
  servings: integer('servings').notNull().default(2),
  calories: integer('calories'),
  mealType: text('meal_type').notNull().default('dinner'), // 'breakfast' | 'lunch' | 'dinner'
  forDate: date('for_date').notNull(),
  rating: text('rating'), // 'liked' | 'disliked' | null
  bookmarked: boolean('bookmarked').notNull().default(false),
  source: text('source').notNull().default('generated'), // 'generated' | 'imported'
  sourceUrl: text('source_url'),
  knowledgeProcessed: boolean('knowledge_processed').notNull().default(false),
  imageUrl: text('image_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('recipe_for_date_idx').on(table.forDate),
  index('recipe_source_idx').on(table.source),
]);

export const mealSuggestions = pgTable('meal_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  forDate: date('for_date').notNull(),
  mealType: text('meal_type').notNull(),
  originalTitle: text('original_title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_meal_suggestions_date_type').on(table.forDate, table.mealType),
]);

export const availableIngredients = pgTable('available_ingredients', {
  id: uuid('id').primaryKey().defaultRandom(),
  item: text('item').notNull(),
  quantity: text('quantity'),           // "300g", "1 bag", "2 breasts"
  category: text('category'),           // "vegetable", "protein", "dairy", "pantry"
  addedDate: date('added_date').notNull(),
  expiresAt: date('expires_at'),        // null = non-perishable
  usedAt: timestamp('used_at', { withTimezone: true }),
  source: text('source').notNull().default('notion_note'),  // "notion_note", "manual"
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('available_ingredients_added_date_idx').on(table.addedDate),
  index('available_ingredients_unused_idx').on(table.addedDate).where(sql`${table.usedAt} IS NULL`),
]);

export const recipePreferenceScores = pgTable('recipe_preference_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  dimension: text('dimension').notNull(), // 'cuisine', 'protein', 'technique', 'spice_level', 'complexity', 'meal_weight'
  value: text('value').notNull(),         // 'thai', 'chicken', 'stir_fry', 'medium', 'quick', 'light'
  score: real('score').notNull().default(0.5),
  sampleCount: integer('sample_count').notNull().default(0),
  lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('recipe_pref_dim_val_idx').on(table.dimension, table.value),
]);

export const activitySuggestions = pgTable('activity_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  forDate: date('for_date').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(), // outdoor, indoor, social, creative, exercise
  location: text('location'),
  durationMinutes: integer('duration_minutes'),
  requiresVehicle: boolean('requires_vehicle').notNull().default(false),
  weatherContext: text('weather_context'), // "Sunny 18°C"
  distanceKm: real('distance_km'),              // null when unknown (non-distance activity)
  elevationGainM: real('elevation_gain_m'),     // null when unknown
  preferredConditions: jsonb('preferred_conditions'), // string[] — used for weekend matching
  scheduledTime: text('scheduled_time'), // free-form: "12:00", "noon", "afternoon", etc.
  imageUrl: text('image_url'),
  rating: text('rating'), // good_idea, bad_idea
  completed: boolean('completed').notNull().default(false),
  feedback: text('feedback'), // free-text user feedback
  knowledgeProcessed: boolean('knowledge_processed').notNull().default(false),
  preferenceProcessed: boolean('preference_processed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('activity_date_title_idx').on(table.forDate, table.title),
]);

/**
 * Learned activity preferences — mirrors recipePreferenceScores.
 * Dimensions: 'activity' (hiking, running), 'companion' (shelby, katie, solo),
 * 'weather' (sunny, rain), 'distance_bucket' ("8-14km"). Score 0-1, 0.5 neutral.
 */
export const activityPreferenceScores = pgTable('activity_preference_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  dimension: text('dimension').notNull(),
  value: text('value').notNull(),
  score: real('score').notNull().default(0.5),
  sampleCount: integer('sample_count').notNull().default(0),
  lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('activity_pref_dim_val_idx').on(table.dimension, table.value),
]);

export const fiSnapshots = pgTable('fi_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  petId: text('pet_id').notNull(),
  petName: text('pet_name').notNull(),
  breed: text('breed'),
  activityType: text('activity_type'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  areaName: text('area_name'),
  placeName: text('place_name'),
  walkDistance: real('walk_distance'),
  steps: integer('steps').notNull(),
  stepGoal: integer('step_goal').notNull(),
  totalDistance: real('total_distance').notNull(),
  batteryPercent: integer('battery_percent').notNull(),
  isCharging: boolean('is_charging').notNull().default(false),
  connectionType: text('connection_type'),
  lastConnectionAt: timestamp('last_connection_at', { withTimezone: true }),
  operationMode: text('operation_mode'),
  sleepMinutes: integer('sleep_minutes'),
  napMinutes: integer('nap_minutes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('fi_snapshot_created_at_idx').on(table.createdAt),
]);

export const fiDailyStats = pgTable('fi_daily_stats', {
  id: uuid('id').primaryKey().defaultRandom(),
  petId: text('pet_id').notNull(),
  forDate: date('for_date').notNull(),
  totalSteps: integer('total_steps').notNull(),
  stepGoal: integer('step_goal').notNull(),
  totalDistance: real('total_distance').notNull(),
  sleepMinutes: integer('sleep_minutes'),
  napMinutes: integer('nap_minutes'),
  walkCount: integer('walk_count'),
  maxBatteryPercent: integer('max_battery_percent'),
  minBatteryPercent: integer('min_battery_percent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('fi_daily_pet_date_idx').on(table.petId, table.forDate),
]);

export const petObservations = pgTable('pet_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  observationId: text('observation_id').notNull().unique(),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  remindAt: timestamp('remind_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // observationId already gets a unique index from .unique() above — only add the remindAt index
  // so the snooze-check query on tick can scan efficiently.
  index('pet_observations_remind_at_idx').on(table.remindAt),
]);

export const userSettings = pgTable('user_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * service-notion blog DB watcher (LOS-263). One row per page seen in the
 * configured `blog_db_id` Notion DB. We only emit BLOG_NOTES_READY when a row
 * transitions into status='Ready'; once emitted we keep `last_status='Ready'`
 * so re-polling doesn't re-emit. If the user moves the page back out of Ready
 * and then back into Ready, we'll emit again — that's the desired behaviour.
 */
export const notionBlogProcessedPages = pgTable('notion_blog_processed_pages', {
  pageId: text('page_id').primaryKey(),
  lastStatus: text('last_status').notNull(),
  emittedAt: timestamp('emitted_at', { withTimezone: true }),
  publishedNotionUrl: text('published_notion_url'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const newsArticles = pgTable('news_articles', {
  id: uuid('id').primaryKey().defaultRandom(),
  url: text('url').notNull().unique(),
  source: text('source').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  topics: jsonb('topics').$type<string[]>().notNull().default([]),
  relevance: real('relevance'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  digestDate: text('digest_date'),
  digestSlot: text('digest_slot'),
  rating: text('rating'),
  knowledgeProcessed: boolean('knowledge_processed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Aggregate topic preference scores for agent-news.
 * One row per topic. Score 0..1: >= 0.5 is a positive interest; < 0.5 is avoided.
 * Updated during nightly knowledge refinement from rated articles.
 */
export const newsTopicScores = pgTable('news_topic_scores', {
  topic: text('topic').primaryKey(),
  score: real('score').notNull().default(0.5),
  ratedCount: integer('rated_count').notNull().default(0),
  lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
});

export const newsDigests = pgTable('news_digests', {
  id: uuid('id').primaryKey().defaultRandom(),
  forDate: text('for_date').notNull(),
  slot: text('slot').notNull(),
  summary: text('summary').notNull(),
  articleIds: jsonb('article_ids').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('news_digest_date_slot_idx').on(table.forDate, table.slot),
]);

export const footballMatches = pgTable('football_matches', {
  id: uuid('id').primaryKey().defaultRandom(),
  apiMatchId: integer('api_match_id').notNull().unique(),
  competition: text('competition').notNull(),
  competitionCode: text('competition_code').notNull(),
  matchday: integer('matchday'),
  homeTeam: text('home_team').notNull(),
  awayTeam: text('away_team').notNull(),
  utcDate: timestamp('utc_date', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('SCHEDULED'),
  homeScore: integer('home_score'),
  awayScore: integer('away_score'),
  venue: text('venue'),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  resultNotified: boolean('result_notified').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workouts = pgTable('workouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  forDate: date('for_date').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  equipment: jsonb('equipment').$type<string[]>().notNull().default([]),
  exercises: jsonb('exercises').$type<{
    name: string;
    sets?: number;
    reps?: string;
    duration?: string;
    notes?: string;
  }[]>().notNull().default([]),
  durationMinutes: integer('duration_minutes').notNull(),
  intensityLevel: text('intensity_level').notNull(), // 'light' | 'moderate' | 'intense'
  calendarContext: text('calendar_context'),
  rating: text('rating'), // 'liked' | 'disliked' | null
  completed: boolean('completed').notNull().default(false),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  feedback: text('feedback'),
  rejectedReason: text('rejected_reason'),
  bookmarked: boolean('bookmarked').notNull().default(false),
  knowledgeProcessed: boolean('knowledge_processed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('workout_date_idx').on(table.forDate),
]);

export const gymPreferenceScores = pgTable('gym_preference_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  dimension: text('dimension').notNull(), // 'equipment' | 'intensity' | 'duration_bucket'
  value: text('value').notNull(),         // e.g. 'squat_rack', 'moderate', '35-40'
  score: real('score').notNull().default(0.5),
  sampleCount: integer('sample_count').notNull().default(0),
  lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('gym_pref_dim_val_idx').on(table.dimension, table.value),
]);

/**
 * Single-row table tracking the user's current knee status.
 * id is always 'singleton' — upsert on conflict.
 */
export const gymKneeStatus = pgTable('gym_knee_status', {
  id: text('id').primaryKey().default('singleton'),
  status: text('status').notNull().default('stable'), // 'stable' | 'flare' | 'recovery'
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── RS3 (RuneScape 3) ──────────────────────────────────────
export const rs3Snapshots = pgTable('rs3_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerName: text('player_name').notNull(),
  totalXp: bigint('total_xp', { mode: 'number' }).notNull(),
  totalLevel: integer('total_level').notNull(),
  overallRank: integer('overall_rank').notNull(),
  skills: jsonb('skills').notNull(), // Record<string, {xp: number, level: number, rank: number}>
  activities: jsonb('activities'), // Record<string, {rank: number, score: number}>
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('rs3_snapshot_player_created_idx').on(table.playerName, table.createdAt),
]);

export const rs3DailyStats = pgTable('rs3_daily_stats', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerName: text('player_name').notNull(),
  forDate: date('for_date').notNull(),
  totalXpGained: bigint('total_xp_gained', { mode: 'number' }).notNull().default(0),
  skillGains: jsonb('skill_gains').notNull().default({}), // Record<string, number> (skill → xp gained)
  levelUps: jsonb('level_ups').notNull().default({}), // Record<string, number> (skill → new level)
  snapshotCount: integer('snapshot_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('rs3_daily_player_date_idx').on(table.playerName, table.forDate),
]);

export const rs3InferredActivities = pgTable('rs3_inferred_activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerName: text('player_name').notNull(),
  forDate: date('for_date').notNull(),
  activityType: text('activity_type').notNull(), // canonical enum: herb_run, necromancy_training, etc.
  title: text('title').notNull(), // human-readable e.g. "~3 herb runs + 1 tree run"
  primarySkill: text('primary_skill').notNull(),
  xpGained: bigint('xp_gained', { mode: 'number' }).notNull(),
  skillBreakdown: jsonb('skill_breakdown').notNull().default(sql`'{}'::jsonb`), // Record<string, number>
  confidence: real('confidence').notNull(),
  reason: text('reason').notNull(),
  source: text('source').notNull().default('ai'), // 'ai' | 'manual'
  userFeedback: text('user_feedback'), // null | 'accurate' | 'inaccurate'
  userFeedbackNote: text('user_feedback_note'),
  ratedAt: timestamp('rated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('rs3_inferred_player_date_idx').on(table.playerName, table.forDate),
  index('rs3_inferred_activity_type_idx').on(table.activityType, table.forDate),
]);

export const rs3Patterns = pgTable('rs3_patterns', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerName: text('player_name').notNull(),
  patternType: text('pattern_type').notNull(), // 'activity_frequency' | 'main_session' | 'skill_focus' | 'daily_challenge' | 'rest_days' | 'next_level_eta'
  patternKey: text('pattern_key').notNull(), // skill name, activity type, or '*' for singletons
  value: jsonb('value').notNull().default(sql`'{}'::jsonb`), // shape varies by patternType
  summary: text('summary').notNull(), // "~2.4 per day", "Thursdays — 9 of last 12"
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('rs3_patterns_player_type_key_idx').on(table.playerName, table.patternType, table.patternKey),
]);

// ─── Farcaster ─────────────────────────────────────────────

export const farcasterAccounts = pgTable('farcaster_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  handle: text('handle').notNull().unique(),                    // 'henrypye' | 'flashcastr'
  fid: integer('fid').notNull().unique(),                       // Farcaster ID
  signerPrivateKey: text('signer_private_key').notNull(),       // encrypted Ed25519 hex (AES-256-GCM), self-registered (no app attribution)
  displayName: text('display_name').notNull(),
  pfpUrl: text('pfp_url'),
  enabled: boolean('enabled').notNull().default(true),
  requiresApproval: boolean('requires_approval').notNull().default(true),  // true = drafts need UI approval (personal), false = auto-publish (bots)
  contentSource: text('content_source'),                                   // 'ai_plan' (default) | 'agent-flashcastr' | null
  dailyCastTarget: integer('daily_cast_target').notNull().default(3),
  dailyEngagementLimit: integer('daily_engagement_limit').notNull().default(2),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const castQueue = pgTable('cast_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountHandle: text('account_handle').notNull(),
  text: text('text').notNull(),
  parentHash: text('parent_hash'),                              // for replies
  channelId: text('channel_id'),                                // target channel
  embeds: jsonb('embeds').default([]),                           // CastEmbed[] (url or castId)
  sourceEngine: text('source_engine').notNull(),                // 'farcaster-engine' | 'agent-blog' | etc.
  sourcePlanId: text('source_plan_id'),                         // FK to farcaster_cast_plans.id
  castHash: text('cast_hash'),                                  // populated after publish
  status: text('status').notNull().default('queued'),           // 'queued' | 'publishing' | 'published' | 'failed'
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(5),
  lastError: text('last_error'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('cast_queue_status_idx').on(table.status),
  index('cast_queue_account_idx').on(table.accountHandle),
]);

export const farcasterCastHistory = pgTable('farcaster_cast_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountHandle: text('account_handle').notNull(),
  castHash: text('cast_hash').notNull().unique(),
  parentHash: text('parent_hash'),                              // null = root cast
  parentAuthorFid: integer('parent_author_fid'),
  channelId: text('channel_id'),                                // '/invaders', '/art', null = main feed
  text: text('text').notNull(),
  embeds: jsonb('embeds').$type<string[]>().default([]),
  reactions: integer('reactions').notNull().default(0),          // likes received
  replies: integer('replies').notNull().default(0),
  recasts: integer('recasts').notNull().default(0),
  castedAt: timestamp('casted_at', { withTimezone: true }).notNull(),
  styleProcessed: boolean('style_processed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('fc_cast_history_account_idx').on(table.accountHandle),
  index('fc_cast_history_channel_idx').on(table.channelId),
  index('fc_cast_history_casted_at_idx').on(table.castedAt),
]);

export const farcasterStyleProfiles = pgTable('farcaster_style_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountHandle: text('account_handle').notNull(),
  channelId: text('channel_id'),                                // null = global/main feed style
  avgLength: integer('avg_length').notNull().default(150),
  toneKeywords: jsonb('tone_keywords').$type<string[]>().notNull().default([]),
  commonPhrases: jsonb('common_phrases').$type<string[]>().notNull().default([]),
  emojiFrequency: real('emoji_frequency').notNull().default(0), // 0-1 scale
  topicAffinity: jsonb('topic_affinity').$type<Record<string, number>>().notNull().default({}),
  exampleCasts: jsonb('example_casts').$type<string[]>().notNull().default([]),
  castCount: integer('cast_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('fc_style_account_channel_idx').on(table.accountHandle, table.channelId),
]);

export const farcasterFriends = pgTable('farcaster_friends', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountHandle: text('account_handle').notNull(),
  friendFid: integer('friend_fid').notNull(),
  friendUsername: text('friend_username').notNull(),
  friendDisplayName: text('friend_display_name'),
  likesGiven: integer('likes_given').notNull().default(0),      // user liked their casts
  likesReceived: integer('likes_received').notNull().default(0), // they liked user's casts
  repliesGiven: integer('replies_given').notNull().default(0),
  repliesReceived: integer('replies_received').notNull().default(0),
  recasts: integer('recasts').notNull().default(0),
  engagementScore: real('engagement_score').notNull().default(0.5),
  signalCount: integer('signal_count').notNull().default(0),
  lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('fc_friend_account_fid_idx').on(table.accountHandle, table.friendFid),
  index('fc_friend_engagement_idx').on(table.engagementScore),
]);

export const farcasterCastPlans = pgTable('farcaster_cast_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountHandle: text('account_handle').notNull(),
  planType: text('plan_type').notNull(),                        // 'original' | 'engagement' | 'conversation'
  channelId: text('channel_id'),                                // target channel or null for main feed
  text: text('text').notNull(),                                 // suggested cast content
  parentHash: text('parent_hash'),                              // if replying
  parentAuthorFid: integer('parent_author_fid'),
  parentText: text('parent_text'),                              // context: what we're replying to
  reasoning: text('reasoning').notNull(),                       // why this was suggested (shown in UI)
  contextSource: text('context_source'),                        // 'weather' | 'devblog' | 'friend_cast' | 'organic'
  status: text('status').notNull().default('pending'),          // 'pending' | 'approved' | 'rejected' | 'published' | 'edited' | 'expired'
  editedText: text('edited_text'),                              // if user edited before approving
  embeds: jsonb('embeds').default([]),                           // CastEmbed[] — highlight plans embed flashes (HEN-584)
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
  forDate: text('for_date').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('fc_cast_plan_date_status_idx').on(table.forDate, table.status),
  index('fc_cast_plan_account_idx').on(table.accountHandle),
]);

export const farcasterConversations = pgTable('farcaster_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountHandle: text('account_handle').notNull(),
  threadRootHash: text('thread_root_hash').notNull(),
  friendFid: integer('friend_fid').notNull(),
  friendUsername: text('friend_username').notNull(),
  lastCastHash: text('last_cast_hash').notNull(),
  lastCastByUser: boolean('last_cast_by_user').notNull(),       // true = we spoke last
  messageCount: integer('message_count').notNull().default(1),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('active'),           // 'active' | 'stale' | 'ended'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('fc_convo_account_thread_idx').on(table.accountHandle, table.threadRootHash),
  index('fc_convo_status_idx').on(table.status),
]);

// ─── Job Search ───────────────────────────────────────────

export const jobListings = pgTable('job_listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  url: text('url').notNull().unique(),
  source: text('source').notNull(), // 'linkedin' | 'indeed'
  title: text('title').notNull(),
  company: text('company').notNull(),
  location: text('location').notNull(),
  salary: text('salary'),
  description: text('description').notNull(),
  techStack: jsonb('tech_stack').$type<string[]>().notNull().default([]),
  relevanceScore: real('relevance_score'),
  matchReasons: jsonb('match_reasons').$type<string[]>().notNull().default([]),
  classification: jsonb('classification'),
  rating: text('rating'), // 'interested' | 'not_interested'
  applicationStatus: text('application_status'), // 'applied' | 'interviewing' | 'accepted' | 'rejected'
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  stale: boolean('stale').notNull().default(false),
  knowledgeProcessed: boolean('knowledge_processed').notNull().default(false),
  digestDate: text('digest_date'), // YYYY-MM-DD
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('job_listings_created_at_idx').on(table.createdAt),
  index('job_listings_digest_date_idx').on(table.digestDate),
  index('job_listings_app_status_idx').on(table.applicationStatus),
]);

export const jobDigests = pgTable('job_digests', {
  id: uuid('id').primaryKey().defaultRandom(),
  forDate: text('for_date').notNull().unique(),
  summary: text('summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobCv = pgTable('job_cv', {
  id: uuid('id').primaryKey().defaultRandom(),
  content: text('content').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobApplicationEvents = pgTable('job_application_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id').notNull().references(() => jobListings.id),
  status: text('status').notNull(), // 'applied' | 'interviewing' | 'accepted' | 'rejected'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('job_app_events_listing_idx').on(table.listingId),
]);

// Interview loop stages per job listing (LOS-352). Seeded on first "applied"
// transition, then edited/advanced as the candidate progresses through the loop.
export const jobInterviewStages = pgTable('job_interview_stages', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobListings.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  label: text('label').notNull(),
  status: text('status').notNull(), // 'upcoming' | 'active' | 'done' | 'skipped'
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('interview_stages_job_idx').on(table.jobId, table.ordinal),
]);

// ─── Blog Schedule ────────────────────────────────────────────────────────

export const blogSchedule = pgTable('blog_schedule', {
  id: uuid('id').primaryKey().defaultRandom(),
  blogType: text('blog_type').notNull(),               // 'dev-diary' | 'invader-roundup'
  frequency: text('frequency').notNull(),              // 'weekly'
  publishDays: jsonb('publish_days').$type<number[]>().notNull().default([]),  // day-of-week numbers [1,3,5]
  publishHour: integer('publish_hour').notNull(),      // hour in user's local timezone
  enabled: boolean('enabled').notNull().default(true),
  lastPublishedAt: timestamp('last_published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('blog_schedule_type_idx').on(table.blogType),
]);

/**
 * Provenance log persisted alongside each generated blog post.
 *
 * Captures every source the post was derived from, paragraph→source citations,
 * any claims the verification pass stripped, and the confidence scores that
 * drive the auto-publish gate. See `apps/agent-blog/src/anti-hallucination/`
 * (LOS-261) for the pipeline that produces this object.
 */
export interface ProvenanceLog {
  sources: { type: 'notes' | 'commit' | 'linear' | 'enrichment'; id: string; content: string }[];
  paragraphs: { paragraphIdx: number; sourceIds: string[] }[];
  strippedClaims: { claim: string; reason: string }[];
  /** 0..1, fraction of the original draft that survived verification. */
  draftConfidence: number;
  /** 0..1, classifier output for "no sensitive material present". */
  sensitiveConfidence: number;
  /** Category tags from the sensitive classifier (empty when clean). */
  sensitiveFlags: string[];
  /** Mappings from internal refs (LOS-NNN, branch names) to user-facing prose. */
  ticketTranslation: { from: string; to: string }[];
}

export const devBlogEntries = pgTable('dev_blog_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  forDate: date('for_date').notNull(),
  type: text('type').notNull().default('dev-diary'),
  summary: text('summary').notNull(),
  concepts: jsonb('concepts').$type<string[]>().notNull().default([]),
  repoCount: integer('repo_count').notNull().default(0),
  commitCount: integer('commit_count').notNull().default(0),
  paragraphPostId: text('paragraph_post_id'),
  paragraphUrl: text('paragraph_url'),
  coverImageUrl: text('cover_image_url'),
  /** 'notes' (Mode A — user notes), 'autonomous' (Mode B — dev updates), or null for legacy diary/roundup rows. */
  mode: text('mode'),
  /** 'published' (default — visible) | 'pending_review' (autoPublishOk=false, awaiting user) | 'rejected'. */
  status: text('status').notNull().default('published'),
  /** Anti-hallucination provenance bundle. See ProvenanceLog. */
  provenanceJson: jsonb('provenance_json').$type<ProvenanceLog>(),
  /** Mirror of provenanceJson.draftConfidence for cheap querying. 0..1. */
  confidenceScore: numeric('confidence_score', { precision: 4, scale: 3 }),
  /** Mirror of provenanceJson.sensitiveConfidence. 0..1. */
  sensitiveConfidence: numeric('sensitive_confidence', { precision: 4, scale: 3 }),
  /** Mirror of provenanceJson.sensitiveFlags for cheap filtering. */
  sensitiveFlags: jsonb('sensitive_flags').$type<string[]>().default([]),
  /** Mode A only — Notion page the source notes came from. */
  notionPageId: text('notion_page_id'),
  /** Mode A only — verbatim user notes the post was drafted from. */
  sourceNotesMd: text('source_notes_md'),
  /** Mode A only — generated draft markdown awaiting review. Populated when status='pending_review' so the reviewer (and reconcile) can replay the draft without re-running the AI pipeline (LOS-265). */
  generatedDraftMd: text('generated_draft_md'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Partial unique index: only enforce one-per-(date,type) for legacy diary/roundup
  // (mode IS NULL) and Mode B autonomous posts. Mode A notes-driven posts can
  // legitimately produce multiple posts per day (separate notes pages).
  uniqueIndex('dev_blog_date_type_idx')
    .on(table.forDate, table.type)
    .where(sql`${table.mode} IS NULL OR ${table.mode} = 'autonomous'`),
]);

/**
 * Predicate for `dev_blog_date_type_idx` — must be passed as `targetWhere` on
 * any `INSERT ... ON CONFLICT (for_date, type)` against `dev_blog_entries`,
 * otherwise Postgres rejects the statement with 42P10 (LOS-548). Keep this in
 * sync with the `where(...)` clause above and migration 0003.
 */
export const DEV_BLOG_DATE_TYPE_IDX_PREDICATE = sql`"mode" IS NULL OR "mode" = 'autonomous'`;

/**
 * Pre/post-edit snapshot for each published blog post. Lets us compute
 * edit_magnitude (Levenshtein-normalized distance between AI draft and the
 * user-edited version that actually shipped) so the post-edit-distance
 * learning loop has signal. One row per post.
 */
export const blogPostEdits = pgTable('blog_post_edits', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').notNull(),
  originalDraftMd: text('original_draft_md').notNull(),
  publishedMd: text('published_md').notNull(),
  /** 0..1, normalized Levenshtein distance between draft and published. */
  editMagnitude: numeric('edit_magnitude', { precision: 5, scale: 4 }).notNull(),
  /** Algorithm version for `editMagnitude`. v1 = LOS-265 Jaccard placeholder
   *  (legacy rows only); v2 = LOS-267 word-level Wagner–Fischer Levenshtein.
   *  The voice-corpus sampler filters to v2 so weights aren't comparing across
   *  scales. */
  magnitudeAlgoVersion: text('magnitude_algo_version').notNull().default('v2'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('blog_post_edits_post_idx').on(table.postId),
]);

/**
 * LOS-283 — agent-blog learning loop preference scores. Mirrors
 * `recipePreferenceScores` shape but persona-namespaced so dev-diary
 * (legally-constrained vocab) and invader-roundup (no constraint) maintain
 * independent score sets and don't bleed prompt context across personas.
 *
 * Dimensions (Phase 1):
 *  - `topic_category`     which commit themes land
 *  - `length_band`        short / medium / long
 *  - `structural_pattern` narrative / breakdown / announcement
 *  - `code_density`       light / medium / heavy
 *
 * Score in [0,1] with 0.5 neutral. Phase 2 will add Paragraph engagement
 * signals; Phase 1 derives signal from `blog_post_edits.edit_magnitude`.
 */
export const blogPreferenceScores = pgTable('blog_preference_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  persona: text('persona').notNull(),     // 'dev-diary' | 'invader-roundup'
  dimension: text('dimension').notNull(), // see header comment
  value: text('value').notNull(),
  score: real('score').notNull().default(0.5),
  sampleCount: integer('sample_count').notNull().default(0),
  lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('blog_pref_persona_dim_val_idx').on(table.persona, table.dimension, table.value),
]);

/**
 * LOS-283 Phase 2 — per-post stats snapshots from broadcast-paragraph's
 * nightly `BLOG_STATS_REFRESHED` event. One row per (post, refresh) so we
 * can compute deltas (subscriber growth, post deletion, view-count gain)
 * across successive payloads without re-querying Paragraph. Storing the
 * subscriber total redundantly per row is intentional — keeps delta
 * arithmetic to a single SELECT.
 */
export const blogStatsSnapshots = pgTable('blog_stats_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Paragraph post id. Matches `dev_blog_entries.paragraph_post_id` once
   *  that field is populated; we don't FK because the snapshot can arrive
   *  before agent-blog's BLOG_PUBLISHED handler has updated the row. */
  paragraphId: text('paragraph_id').notNull(),
  viewCount: integer('view_count').notNull(),
  /** Publication-wide subscriber total at the time of the refresh. Same
   *  value is repeated across every snapshot row for one refresh — that's
   *  the trade-off for keeping the query trivial. */
  subscriberCountTotal: integer('subscriber_count_total').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('blog_stats_snapshots_post_captured_idx').on(table.paragraphId, table.capturedAt.desc()),
  index('blog_stats_snapshots_captured_at_idx').on(table.capturedAt.desc()),
  // Idempotency guard: broadcast-paragraph has no DB volume, so a Railway
  // restart inside the 03:00–06:00 refresh window can re-emit the same
  // BLOG_STATS_REFRESHED payload. Inserts use ON CONFLICT DO NOTHING against
  // this unique key so duplicate snapshots are dropped silently.
  uniqueIndex('blog_stats_snapshots_post_captured_uniq').on(table.paragraphId, table.capturedAt),
]);

/**
 * LOS-266 — autonomous dev updates (Mode B) cadence ledger. One row per
 * published blog post. Mode B's per-tick guards count rows in the last
 * `today_start` window and check `max(published_at)` against the
 * `min_gap_hours` setting. Mode A also writes rows so the cadence is shared
 * across both publishing surfaces — a single user-visible publish budget.
 */
export const blogPublishLog = pgTable('blog_publish_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  /** 'notes' for Mode A publishes, 'autonomous_dev' for Mode B. */
  mode: text('mode').notNull(),
  postId: uuid('post_id').notNull(),
}, (table) => [
  index('blog_publish_log_published_at_idx').on(table.publishedAt.desc()),
]);

// ─── Git Agent ────────────────────────────────────────────────────────────

export const gitActivity = pgTable('git_activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  repo: text('repo').notNull(),
  commitMessage: text('commit_message').notNull(),
  filesChanged: jsonb('files_changed').$type<string[]>().notNull().default([]),
  committedAt: date('committed_at').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('git_activity_dedup_idx').on(table.repo, table.commitMessage, table.committedAt),
  index('git_activity_committed_at_idx').on(table.committedAt),
]);

export const gitSkillProfile = pgTable('git_skill_profile', {
  id: uuid('id').primaryKey().defaultRandom(),
  languages: jsonb('languages').$type<Record<string, number>>().notNull().default({}),
  frameworks: jsonb('frameworks').$type<Record<string, number>>().notNull().default({}),
  patterns: jsonb('patterns').$type<string[]>().notNull().default([]),
  projectSummaries: jsonb('project_summaries').$type<{ repo: string; description: string; stack: string[] }[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Flashcastr (Space Invader content agent) ─────────────────────────────

export const flashcastrInvaderEvents = pgTable('flashcastr_invader_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  invaderId: text('invader_id').notNull(),          // e.g. PA_1099, NY_69, LDN_46
  city: text('city').notNull(),                      // e.g. PA, NY, LDN
  eventType: text('event_type').notNull(),           // destruction, degradation, reactivation, restoration, status_update, addition, alert
  eventDate: text('event_date').notNull(),           // YYYY-MM-DD
  rawText: text('raw_text'),                         // original text from news feed
  sourceUrl: text('source_url'),                     // link to invader-spotter.art page
  scrapedAt: timestamp('scraped_at', { withTimezone: true }).notNull().defaultNow(),
  castGenerated: boolean('cast_generated').notNull().default(false),
}, (table) => [
  uniqueIndex('flashcastr_event_dedup_idx').on(table.invaderId, table.eventType, table.eventDate),
  index('flashcastr_event_date_idx').on(table.eventDate),
  index('flashcastr_event_city_idx').on(table.city),
]);

/**
 * Learned preference scores for flashcastr suggestion generation.
 * Dimensions: contentType (destruction/reactivation/addition/city_spotlight/milestone),
 * optional city (e.g. PA, LDN), optional noveltyBucket (first-time/repeat/iconic).
 * Score 0-1; clamped to [0.6, 0.95] by pushSignal; defaults to 0.7 when sampleCount < 10.
 */
export const flashcastrPreferenceScores = pgTable('flashcastr_preference_scores', {
  id: serial('id').primaryKey(),
  contentType: text('content_type').notNull(),
  city: text('city'),
  noveltyBucket: text('novelty_bucket'),
  score: real('score').notNull().default(0.5),
  sampleCount: integer('sample_count').notNull().default(0),
  lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('flashcastr_pref_content_city_novelty_idx').on(table.contentType, table.city, table.noveltyBucket),
  index('flashcastr_pref_content_type_idx').on(table.contentType),
]);

/**
 * Seen-URL cache for the multi-source web fetcher (HEN-582).
 * Tracks every curated source URL + every URL surfaced by open-web search.
 * `content_hash` is sha256 of the GET body — diff against stored hash to detect changes.
 * `source_label` = curated label (e.g. 'mapvaders', 'invader-spotter') or 'discovered' for search hits.
 * `classification` = 'news' | 'gallery' | 'social' | 'fan' | 'unknown'.
 */
export const flashcastrSeenUrls = pgTable('flashcastr_seen_urls', {
  url: text('url').primaryKey(),
  sourceLabel: text('source_label').notNull(),
  classification: text('classification').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
  lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
  contentHash: text('content_hash'),
  lastSummary: text('last_summary'),
}, (table) => [
  index('flashcastr_seen_urls_label_idx').on(table.sourceLabel),
]);

/**
 * Free-form news entries scraped from auth-gated fan sources (HEN-583).
 * `source` = e.g. 'awazleon'. URL-keyed via unique index for idempotent re-scrape.
 * `cast_generated` mirrors `flashcastrInvaderEvents` so the suggestion pipeline
 * can mark items used once consumed.
 */
export const flashcastrExternalNews = pgTable('flashcastr_external_news', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull(),
  url: text('url').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  publishedAt: text('published_at'),                  // 'YYYY-MM-DD' or null
  scrapedAt: timestamp('scraped_at', { withTimezone: true }).notNull().defaultNow(),
  castGenerated: boolean('cast_generated').notNull().default(false),
}, (table) => [
  uniqueIndex('flashcastr_external_news_url_idx').on(table.url),
]);

/**
 * Inbound Farcaster mentions of @flashcastr + replies on its own casts
 * (HEN — flashcastr-conversational-persona story 02). Read-only ingest:
 * `castHash` PK + `onConflictDoNothing` makes re-poll idempotent (no dup
 * rows). Status lifecycle: ingest (story 02) writes `new`; the conversational
 * reply engine (story 03) drains `new` and writes the terminal status —
 * `replied` (an in-character reply was dispatched, `processedAt` set) or
 * `skipped` (cooldown / out-of-scope / dispatch failure, no retry). Re-poll
 * never re-processes a terminal row. Each agent owns its own rows on its own
 * DB (no shared PG).
 */
export const flashcastrMentions = pgTable('flashcastr_mentions', {
  castHash: text('cast_hash').primaryKey(),             // inbound cast hash — dedup key
  authorFid: integer('author_fid').notNull(),
  authorUsername: text('author_username').notNull(),
  parentHash: text('parent_hash'),                      // cast this replies to (null = top-level mention)
  threadRootHash: text('thread_root_hash'),             // conversation root for thread-context assembly
  text: text('text').notNull(),
  kind: text('kind').notNull(),                          // 'mention' | 'reply'
  status: text('status').notNull().default('new'),       // 'new' | 'processed'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (table) => [
  index('flashcastr_mentions_status_idx').on(table.status),
  index('flashcastr_mentions_thread_idx').on(table.threadRootHash),
]);

/**
 * Learned public corrections (HEN — flashcastr-conversational-persona story
 * 04). A community reply that asserts @flashcastr stated a fact wrong
 * ("FTBL is Fontainebleau, not football") is classified `correction`,
 * acknowledged in character, and persisted here so the wrong claim never
 * recurs. Active rows (`retiredAt IS NULL`) are formatted oldest-first into
 * a corrections block prepended to the generation/reply prompts (daily-prep,
 * suggestion-gen, conversational replies). Retraction = set `retiredAt`;
 * retired rows are excluded from the injected block. Each agent owns its own
 * rows on its own DB (no shared PG). Mirrors kelly-frears `kelly_guidance`.
 */
export const flashcastrCorrections = pgTable('flashcastr_corrections', {
  id: uuid('id').primaryKey().defaultRandom(),
  wrongClaim: text('wrong_claim').notNull(),             // the assertion that was wrong, e.g. "FTBL is football"
  correctFact: text('correct_fact').notNull(),           // the corrected fact, e.g. "FTBL is Fontainebleau"
  sourceCastHash: text('source_cast_hash'),              // the inbound correction reply's cast hash
  authorFid: integer('author_fid').notNull(),            // who corrected us
  scope: text('scope').notNull().default('all'),         // 'all' | 'generation' | 'reply'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),  // null = active; set = retracted/excluded
}, (table) => [
  index('flashcastr_corrections_retired_idx').on(table.retiredAt),
  index('flashcastr_corrections_scope_idx').on(table.scope),
]);

/**
 * Audit log of every reply that intent-classifier flagged as a `correction`,
 * regardless of whether it was persisted. Drives two things:
 *   1) Daily budget cap on web-search fact-checks (last-24h count).
 *   2) Post-hoc review of which corrections were dropped + why.
 * Distinct from `flashcastrCorrections` (which holds only persisted, verified
 * rows that get injected into prompts).
 */
export const flashcastrCorrectionAudit = pgTable('flashcastr_correction_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceCastHash: text('source_cast_hash').notNull(),
  authorFid: integer('author_fid').notNull(),
  wrongClaim: text('wrong_claim').notNull(),
  correctFact: text('correct_fact').notNull(),
  relevant: boolean('relevant').notNull(),                              // passed the Invader-domain relevance gate
  factCheckVerdict: text('fact_check_verdict'),                         // 'high' | 'low' | 'reject' | null (skipped: irrelevant or budget exhausted)
  factCheckReasoning: text('fact_check_reasoning'),                     // web-search reasoning excerpt
  persisted: boolean('persisted').notNull().default(false),             // true iff a row was added to flashcastrCorrections
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('flashcastr_correction_audit_checked_at_idx').on(table.checkedAt),
]);

// ─── Meeting Prep ─────────────────────────────────────────────────────────

export const meetingPreps = pgTable('meeting_preps', {
  id: uuid('id').primaryKey().defaultRandom(),
  calendarEventId: text('calendar_event_id').notNull(),
  meetingTitle: text('meeting_title').notNull(),
  company: text('company'),
  attendeeNames: jsonb('attendee_names').$type<string[]>().notNull().default([]),
  depth: text('depth').notNull(),
  content: text('content').notNull(),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('meeting_prep_event_idx').on(table.calendarEventId),
  index('meeting_prep_start_time_idx').on(table.startTime),
]);

// ─── Finance ──────────────────────────────────────────────────────────────

/**
 * LOS-534: Clean debit/credit ledger replacing the old signed-amount schema.
 * debit and credit are always >= 0 (enforced by CHECK).
 * Exactly one of debit/credit is > 0 for posted rows; both are 0 for declined.
 * The `finance_ledger_clean` view excludes internal transfers and declined rows.
 *
 * NOTE: The debit_credit_xor CHECK constraint and the finance_ledger_clean view
 * are defined in the SQL migration only (Drizzle does not generate CHECK constraints
 * or views from the schema definition).
 */
export const financeLedger = pgTable('finance_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'amex' | 'bmo' | 'monzo_personal' | 'monzo_business' | 'gnosis_pay' */
  bank: text('bank').notNull(),
  /** Card last-four, 'personal', 'business', or bank account number */
  accountId: text('account_id'),
  postedDate: date('posted_date').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  description: text('description'),
  type: text('type'),
  debit: numeric('debit', { precision: 14, scale: 2 }).notNull().default('0'),
  credit: numeric('credit', { precision: 14, scale: 2 }).notNull().default('0'),
  currency: text('currency').notNull(),
  /** Original transaction amount in local currency (e.g. CAD for a Gnosis Pay purchase) */
  amountNative: numeric('amount_native', { precision: 14, scale: 4 }),
  currencyNative: text('currency_native'),
  /** 'posted' | 'declined' */
  status: text('status').notNull().default('posted'),
  sourceFile: text('source_file').notNull(),
  /** sha256 of bank|account_id|posted_date|description|debit|credit|currency|amount_native */
  sourceRowHash: text('source_row_hash').notNull().unique(),
  raw: jsonb('raw').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  bucket: text('bucket'),
  isInternalTransfer: boolean('is_internal_transfer').notNull().default(false),
}, (table) => [
  index('finance_ledger_bank_date_idx').on(table.bank, table.postedDate),
  index('finance_ledger_date_idx').on(table.postedDate),
  index('finance_ledger_bucket_idx').on(table.bucket),
  index('finance_ledger_transfer_idx').on(table.isInternalTransfer),
]);

/**
 * Debit candidates where a matching credit could not be found within ±3 days.
 * Populated by transfer-detector; used for admin review.
 */
export const financeTransferUnmatched = pgTable('finance_transfer_unmatched', {
  id: uuid('id').primaryKey().defaultRandom(),
  ledgerId: uuid('ledger_id').notNull().unique().references(() => financeLedger.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
});

