import { v4 as uuid } from 'uuid';

export interface LifeEvent<T = unknown> {
  id: string;
  routingKey: string;
  timestamp: string;
  source: string;
  payload: T;
  relevance?: number; // 0-1, calculated by agent from knowledge graph
}

export interface EmailReceivedPayload {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  labels: string[];
  receivedAt: string;
}

export interface CalendarAttendee {
  email: string;
  displayName?: string;
  organizer?: boolean;
  domain: string;
}

export interface CalendarEventPayload {
  eventId: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  attendees?: CalendarAttendee[];
}

export interface FiLocationPayload {
  alertId: string;
  type: 'left-home' | 'arrived-new-place' | 'on-walk' | 'walk-distance';
  petName: string;
  title: string;
  body: string;
  latitude?: number;
  longitude?: number;
  placeName?: string;
  distance?: number;
}

export interface FiActivityPayload {
  alertId: string;
  type: 'goal-reached' | 'goal-progress' | 'low-activity';
  petName: string;
  title: string;
  body: string;
  steps: number;
  stepGoal: number;
  progressPercent: number;
}

export interface FiDevicePayload {
  alertId: string;
  type: 'low-battery' | 'charging' | 'connection-lost' | 'lost-dog-mode';
  petName: string;
  title: string;
  body: string;
  batteryPercent?: number;
}

export interface FiSleepPayload {
  alertId: string;
  type: 'unusual-sleep';
  petName: string;
  title: string;
  body: string;
  sleepMinutes: number;
  averageSleepMinutes: number;
}

export interface FootballReminderPayload {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  venue: string | null;
  kickoffTime: string;
}

export interface FootballResultPayload {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  competition: string;
}

export interface NewsDigestPayload {
  digestId: string;
  forDate: string;
  slot: string;
  summary: string;
  topArticles: { title: string; source: string; url: string }[];
}

export interface PetObservationDismissedPayload {
  observationId: string;
  dismissedAt: string; // ISO
}

export interface PetObservationSnoozedPayload {
  observationId: string;
  remindAt: string; // ISO — default next morning 08:00 user local time
}

export interface FiDailySummaryPayload {
  summaryId: string;
  petName: string;
  forDate: string;
  totalSteps: number;
  stepGoal: number;
  sleepMinutes: number | null;
  napMinutes: number | null;
  batteryPercent: number;
  walkCount: number | null;
}

export interface GymGeneratedPayload {
  workoutId: string;
  title: string;
  description: string;
  durationMinutes: number;
  intensityLevel: string;
  equipment: string[];
  notifyMessage?: string;
}

export interface GymRejectedPayload {
  workoutId: string;
  reason: string;
}

export interface Rs3DailySummaryPayload {
  summaryId: string;
  playerName: string;
  forDate: string;
  skills: { name: string; xpGained: number; newLevel?: number; leveledUp?: boolean }[];
  totalXpGained: number;
}

export interface DevBlogGeneratedPayload {
  entryId: string;
  forDate: string;
  summary: string;
  concepts: string[];
  commitCount: number;
  repoCount: number;
  paragraphUrl: string | null;
}

// ─── Blog (agent-blog + broadcast-paragraph) ──────────────────────────────

export interface BlogPublishRequestPayload {
  requestId: string;
  title: string;
  markdown: string;
  status: 'draft' | 'published';
  imageUrl?: string;
  subtitle?: string;
  categories?: string[];
  blogType: string;        // 'dev-diary' | 'invader-roundup' | 'notes'
  forDate: string;
  /** Mode A only — Notion page id, threaded so the round-trip is stateless. */
  notionPageId?: string;
}

export interface BlogPublishedPayload {
  requestId: string;
  postId: string;
  url: string;
  blogType: string;
  forDate: string;
  /** Echoed back from BlogPublishRequestPayload — Mode A consumers use this
   *  to flip Notion status + emit the deferred BLOG_GENERATED notification. */
  notionPageId?: string;
}

export interface BlogPublishFailedPayload {
  requestId: string;
  error: string;
  blogType: string;
  forDate: string;
  /** Echoed back from BlogPublishRequestPayload — Mode A consumers can surface
   *  the failure on the originating Notion page. */
  notionPageId?: string;
}

/**
 * broadcast-paragraph → agent-blog (LOS-283 Phase 2): nightly Paragraph
 * stats snapshot. Per-post view counts + subscriber total. agent-blog
 * persists each payload as a `blog_stats_snapshots` row per post and
 * derives implicit signals (subscriber growth, post deletion via missing
 * paragraphId) from successive payloads.
 */
export interface BlogStatsRefreshedPostStat {
  /** Paragraph post id (`ListOwnPosts200ItemsItem.id`). */
  paragraphId: string;
  /** Total views from Paragraph. `views` is optional on the SDK shape so
   *  we coerce missing values to 0 at the publisher boundary. */
  viewCount: number;
  /** Optional fields surfaced by `posts.list` so consumers can debug
   *  without re-querying. Match the SDK shape (epoch-ms timestamp string). */
  title?: string;
  /** Epoch-ms timestamp string the SDK returns; undefined for unpublished. */
  publishedAt?: string;
}

export interface BlogStatsRefreshedPayload {
  /** ISO-8601 timestamp of when broadcast-paragraph fetched the stats. */
  refreshedAt: string;
  /** Paragraph publication id the stats were fetched for. */
  publicationId: string;
  /** Total subscriber count for the publication at fetch time. */
  subscriberCount: number;
  /** Per-post stats for posts still listed by Paragraph. Posts that have
   *  been deleted/unpublished will be absent — agent-blog detects deletion
   *  by diffing successive payloads. */
  posts: BlogStatsRefreshedPostStat[];
}

/** PWA → agent-blog: regenerate the dev-diary entry for a specific day. */
export interface BlogRegenerateRequestPayload {
  forDate: string; // YYYY-MM-DD
}

/** api-gateway → agent-blog: user approved a pending-review draft. */
export interface BlogDraftApproveRequestPayload {
  /** dev_blog_entries.id */
  postId: string;
}

/** api-gateway → agent-blog: user rejected a pending-review draft. */
export interface BlogDraftRejectRequestPayload {
  /** dev_blog_entries.id */
  postId: string;
}

/** api-gateway → agent-blog: user edited the draft and chose to publish. */
export interface BlogDraftEditPublishRequestPayload {
  /** dev_blog_entries.id */
  postId: string;
  editedMarkdown: string;
}

export interface BlogGeneratedPayload {
  entryId: string;
  forDate: string;
  blogType: string;
  summary: string;
  concepts: string[];
  commitCount: number;
  repoCount: number;
  paragraphUrl: string | null;
  /** Mode A only — 'notes' (user-driven) or 'autonomous' (Mode B). Legacy paths omit. */
  mode?: 'notes' | 'autonomous';
  /** 'published' (auto-published) or 'pending_review' (failed anti-hallucination guard). */
  status?: 'published' | 'pending_review';
  /** Anti-hallucination flags surfaced to the notification body when status='pending_review'. */
  pendingReasons?: string[];
  /** Mode A only — Notion page id; lets the PWA route reviewers back to source. */
  notionPageId?: string;
  /** Mode A only — DB row id used for the /blog/review/{postId} actionUrl when pending. */
  postId?: string;
}

/**
 * service-notion → agent-blog: a page in the configured LifeOS/Blog Notion DB
 * has transitioned to status=Ready. Emitted at most once per (pageId, Ready
 * transition) — see `notion_blog_processed_pages`. agent-blog uses the
 * markdown content as the source for a Paragraph publish (LOS-263 / LOS-261).
 */
export interface BlogNotesReadyPayload {
  pageId: string;
  title: string;
  markdownContent: string;
  /** ISO timestamp of the emit. */
  detectedAt: string;
}

/**
 * agent-blog → service-notion: the Notion-sourced post has been published to
 * Paragraph. service-notion flips the page status to Published and appends a
 * block with the Paragraph URL + publish timestamp (LOS-263).
 */
export interface BlogPublishedNotionPayload {
  pageId: string;
  paragraphUrl: string;
  publishedAt: string; // ISO
}

// ─── Flashcastr roundup (agent-blog ↔ agent-flashcastr) ───────────────────

export interface FlashcastrRoundupRequestPayload {
  requestId: string;
  forDate: string;
  periodDays: number;
}

export interface FlashcastrRoundupEvent {
  invaderId: string;
  city: string;
  eventType: string;
  eventDate: string;
  rawText: string;
}

/**
 * One curated source URL whose content changed since last fetch (HEN-585).
 * `summary` is a head-truncated slice of the raw fetched body (not the full
 * page) — enough context for the Opus roundup writer without ballooning input.
 */
export interface FlashcastrSourceDelta {
  url: string;
  label: string;
  summary: string;
}

export interface FlashcastrExternalNewsItem {
  source: string;
  url: string;
  title: string;
  body: string;
  publishedAt: string | null;
}

export interface FlashcastrTopHunter {
  username: string;
  flashCount: number;
}

export interface FlashcastrTopCity {
  city: string;
  count: number;
}

export interface FlashcastrStats {
  topHunters: FlashcastrTopHunter[];
  topCities: FlashcastrTopCity[];
  totalFlashes: number;
}

export interface FlashcastrRoundupResponsePayload {
  requestId: string;
  events: FlashcastrRoundupEvent[];
  knowledge: {
    artistContext: string;
    communityCulture: string;
    globalMap: string;
  };
  /** HEN-585 — curated source deltas since last fetch. */
  sourceDeltas?: FlashcastrSourceDelta[];
  /** HEN-585 — auth-gated external news (e.g. awazleon). */
  externalNews?: FlashcastrExternalNewsItem[];
  /** HEN-585 — aggregate stats over the period from the flashcastr GraphQL API. */
  flashcastrStats?: FlashcastrStats;
  /** HEN-585 — URLs surfaced by the open-web search step. */
  discoveredUrls?: string[];
  /** Legacy free-form headline list — kept for back-compat with older blog code. */
  recentNews: string[];
}

// Flashcastr content exchange between agent-farcaster (coordinator) and agent-flashcastr (domain expert)
export interface FlashcastrContentRequestPayload {
  requestId: string;
  maxSuggestions: number;
  forDate: string;
}

export interface FlashcastrContentSuggestion {
  text: string;
  confidence: number;           // 0-1, agent-farcaster should only use >= 0.8
  contentType: string;          // destruction, reactivation, addition, city_spotlight, milestone
  sourceInvaderIds: string[];   // e.g. ["PA_1099", "LDN_46"]
  sourceUrl?: string;           // attribution link
}

export interface FlashcastrContentResponsePayload {
  requestId: string;
  suggestions: FlashcastrContentSuggestion[];
}

/** Per-suggestion summary sent back to agent-flashcastr for learning signal ingestion. */
export interface FlashcastrAcceptedSuggestion {
  contentType: string;
  city?: string;
  sourceInvaderIds: string[];
}

export interface FlashcastrContentAcceptedPayload {
  sourceInvaderIds: string[];
  forDate: string;
  /** Accepted suggestions with contentType/city for flashcastr learning signal ingestion. */
  acceptedSuggestions?: FlashcastrAcceptedSuggestion[];
}

export interface FlashcastrHighlightRequestPayload {
  requestId: string;
}

export interface FlashcastrHighlightResponsePayload {
  requestId: string;
  user: { fid: number; username: string };
  flash: { castHash: string; fid: number };
}

export interface RecipeImportedPayload {
  recipeId: string;
  title: string;
  description: string;
}

export interface RecipeBookmarkedPayload {
  recipeId: string;
  bookmarked: boolean;
}

export interface FarcasterPlanGeneratedPayload {
  planCount: number;
  accountHandle: string;
  forDate: string;
}

export interface FarcasterPlanApprovedPayload {
  planId: string;
  /** User-edited text from PWA, or undefined if approved without edits. Agent resolves original from DB. */
  editedText?: string;
}

export interface FarcasterPlanRejectedPayload {
  planId: string;
  /** User-provided reason for rejection (e.g., "FTBL is Fontainebleau not Football"). */
  reason?: string;
}

export interface CastGenerationRequestPayload {
  /** Farcaster handle to generate a plan for (e.g. "henrypye"). */
  handle: string;
}

/** Emitted by agent-farcaster N hours after publishing a flashcastr-sourced cast. Feeds flashcastr learning loop (PR2 emitter). */
export interface FarcasterCastEngagementPayload {
  castHash: string;
  sourceContentType?: string;
  sourceInvaderIds?: string[];
  reactions: number;
  recasts: number;
  replies: number;
  measuredAt: string;
  hoursSincePost: number;
}

// ─── Farcaster Account Lookup (broadcast-cast owns credentials) ──────────

export interface FarcasterAccountInfo {
  handle: string;
  fid: number;
  displayName: string;
  enabled: boolean;
  requiresApproval: boolean;
  contentSource: string | null;
  dailyCastTarget: number;
  dailyEngagementLimit: number;
}

export interface FarcasterAccountRequestPayload {
  requestId: string;
  /** 'all' = list all accounts, or a specific handle. */
  handle: string | 'all';
}

export interface FarcasterAccountResponsePayload {
  requestId: string;
  accounts: FarcasterAccountInfo[];
}

export type CastEmbed =
  | { type: 'url'; url: string }
  | { type: 'castId'; fid: number; hash: string };  // hash as hex string

export interface CastRequestPayload {
  accountHandle: string;
  /** 'cast' (default) to publish a new cast, 'recast' to recast an existing cast. */
  action?: 'cast' | 'recast';
  text: string;
  parentHash: string | null;
  channelId: string | null;
  channelParentUrl?: string;        // resolved channel parent_url (takes precedence over channelId)
  embeds: CastEmbed[];
  mentions?: number[];              // FIDs of mentioned users
  mentionsPositions?: number[];     // byte positions in text (UTF-8)
  /** For recasts: the hash of the cast to recast. */
  targetCastHash?: string;
  /** For recasts: the FID of the cast author. */
  targetFid?: number;
  sourceEngine: string;
  sourcePlanId: string | null;
}

export interface CastPublishedPayload {
  castQueueId: string;
  castHash: string;
  accountHandle: string;
  text: string;
  sourceEngine: string;
  sourcePlanId: string | null;
}

export interface CastFailedPayload {
  castQueueId: string;
  accountHandle: string;
  error: string;
  sourceEngine: string;
  sourcePlanId: string | null;
}

export interface JobDigestPayload {
  digestId: string;
  forDate: string;
  summary: string;
  topJobs: { title: string; company: string; relevanceScore: number }[];
}

export interface JobFeedbackPayload {
  listingId: string;
  rating: 'interested' | 'not_interested';
}

// ─── Orchestrator (daily planning) ───────────────────────────────────────────

export type Timeslot = 'breakfast' | 'morning' | 'midday' | 'afternoon' | 'evening';

export interface TimeslotBounds {
  start: string; // HH:MM
  end: string;   // HH:MM
}

export const TIMESLOT_ORDER: Timeslot[] = ['breakfast', 'morning', 'midday', 'afternoon', 'evening'];

export const TIMESLOT_DEFAULTS: Record<Timeslot, TimeslotBounds> = {
  breakfast:  { start: '07:30', end: '08:30' },
  morning:    { start: '08:30', end: '12:00' },
  midday:     { start: '12:00', end: '13:00' },
  afternoon:  { start: '13:00', end: '16:00' },
  evening:    { start: '16:00', end: '21:00' },
};

export interface PlanRequestPayload {
  date: string;
  dayType: 'weekday' | 'weekend';
  timeslots: Record<Timeslot, TimeslotBounds>;
  timeBlocks: Array<{
    start: string;
    end: string;
    category: 'focus' | 'afk' | 'physical' | 'errand' | 'flexible' | 'meeting';
    label?: string;
  }>;
  fixedCommitments: Array<{
    time: string;
    title: string;
    durationMinutes: number;
  }>;
  goals: Record<string, string[]>;
  priorities?: string[];
  notes?: string;
  /** Phase 1 context gathered from context-provider agents (weather, calendar, fi, football). */
  worldContext?: {
    weather?: { tempMax: number; weatherCode: number; precipitation: number; description: string };
    calendar?: Array<{ time: string; title: string; durationMinutes: number; category: string }>;
    pet?: { name: string; steps: number; stepGoal: number; walkCount: number };
    football?: Array<{ homeTeam: string; awayTeam: string; competition: string; kickoff: string }>;
  };
  /** Full profile prose from Notion Profile/** (director-only, not set by orchestrator). */
  profileContext?: string;
  /** When true, agents should bypass idempotency guards (admin re-trigger). */
  force?: boolean;
}

export interface PlanTask {
  title: string;
  estimatedMinutes: number;
  priority: 'must-do' | 'should-do' | 'nice-to-have';
  category: 'focus' | 'afk' | 'physical' | 'errand' | 'flexible' | 'meeting';
  context: string;
  repeatCount?: number;
  repeatWindow?: string;
  /** Freeform hint from the agent: "morning", "09:00", "evening", "dispersed", etc. */
  timePreference?: string;
  dependsOn?: string;
}

export interface PlanContributionPayload {
  domain: string;
  tasks: PlanTask[];
  briefing: string;
  /** Domain state the orchestrator can use for cross-agent planning. */
  domainContext?: Record<string, any>;
}

export interface AssembledTask extends PlanTask {
  domain: string;
  timeslot: Timeslot;
  startTime: string; // HH:MM
}

export interface PlanAssembledPayload {
  date: string;
  tasks: AssembledTask[];
  totalEstimatedMinutes: number;
  domainCount: number;
  summary: string;
  /** Casual 2-4 sentence overview of the day for the Notion page header. */
  overview: string;
}

// ─── Plan revision (conversational retry) ───────────────────────────────────

/**
 * Orchestrator sends targeted feedback to a specific agent when its contribution
 * doesn't fit the plan. The agent responds with a revised PlanContribution.
 * Max 3 revision rounds per agent per plan cycle.
 */
export interface PlanRevisionRequestPayload {
  date: string;
  targetDomain: string;
  round: number;        // 1, 2, or 3
  feedback: string;     // human-readable: "Too long for the evening slot, suggest under 2 hours"
  originalContribution: PlanContributionPayload;
  slotConstraints?: {
    timeslot: Timeslot;
    availableMinutes: number;
    blockedBy: string[];  // other tasks already in this slot
  };
}

/**
 * Post-plan refinement hint sent when an agent fails all revision rounds.
 * Agent should process during nightly refinement to improve future contributions.
 */
export interface PlanRevisionFeedbackPayload {
  targetDomain: string;
  date: string;
  feedback: string;     // "I asked 3 times and couldn't use your suggestion for evening slot"
  failedRounds: number;
}

// ─── Director ──────────────────────────────────────────────────────────────

export interface PlanOutcomePayload {
  date: string;
  outcomes: Array<{
    domain: string;
    plannedTitle: string;
    plannedTime: string | null;
    actualStatus: 'completed' | 'moved' | 'skipped' | 'added';
    actualTime: string | null;
  }>;
  /** Optional directive for a specific agent. */
  directive?: {
    domain: string;
    message: string;
  };
}

export interface DirectorSynthesisPayload {
  date: string;
  patternsUpdated: number;
  summary: string;
}

// ─── Director chat ────────────────────────────────────────────────────────────

export interface DirectorChatAction {
  id: string;
  label: string;
  type: 'apply' | 'pick';
  description: string;
  payload: Record<string, any>;
}

export interface DirectorChatUserPayload {
  sessionId: string;
  message: string;
  timestamp: string;
}

export interface DirectorChatResponsePayload {
  sessionId: string;
  message: string;
  actions?: DirectorChatAction[];
  timestamp: string;
}

export interface DirectorActionRequestPayload {
  sessionId: string;
  actionId: string;
}

export interface DirectorActionResultPayload {
  sessionId: string;
  actionId: string;
  success: boolean;
  message: string;
  changes?: Array<{ field: string; from: string; to: string }>;
}

// ─── Notion sync ────────────────────────────────────────────────────────────

export interface TaskCompletionPayload {
  date: string;
  domain: string;
  taskTitle: string;
  target: number;
  completed: number;
  skipped: boolean;
  dayContext?: string;
}

export interface GoalsUpdatedPayload {
  domain: string;
  goals: string[];
  updatedAt: string;
}

// ─── Meeting Prep Pipeline ─────────────────────────────────────────────────

export interface PrepTriggerPayload {
  calendarEventId: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  attendees: CalendarAttendee[];
  category: string;
  hoursUntil: number;
  /** When true, delete existing prep and regenerate (admin re-trigger). */
  force?: boolean;
}

export interface PrepReadyPayload {
  calendarEventId: string;
  meetingTitle: string;
  startTime: string;
  company?: string;
  attendeeNames: string[];
  content: string;
  depth: 'light' | 'standard' | 'deep';
}

// ─── Git Agent ─────────────────────────────────────────────────────────────

export interface GitActivitySyncedPayload {
  forDate: string;
  commitCount: number;
  repoCount: number;
  repos: string[];
  commits?: { repo: string; message: string; filesChanged: string[] }[];
}

export interface GitFetchRequestPayload {
  sinceDate: string;
  untilDate: string;
  requestedBy: string;
}

/** Cross-service context query sent to service-git. */
export interface GitContextRequestPayload {
  requestId: string;
  requestedBy: string;
  /** Currently only 'git_activity' is supported; reserved for future expansion. */
  type: 'git_activity';
  dateRange?: { start: string; end: string };
  /** Filter to a specific repo name. */
  repo?: string;
  /** If true, response includes the current git_skill_profile slice. */
  includeSkillProfile?: boolean;
}

export interface GitActivityRecord {
  repo: string;
  commitMessage: string;
  filesChanged: string[];
  committedAt: string;
}

export interface GitContextResponsePayload {
  requestId: string;
  requestedBy: string;
  activities: GitActivityRecord[];
  skillProfile?: {
    languages: Record<string, number>;
    frameworks: Record<string, number>;
    patterns: string[];
  };
}

// ─── Content Ready (agents → display-sync) ─────────────────────────────────

export type ContentDomain =
  | 'recipe' | 'recipe_profile' | 'workout' | 'activity' | 'activity_profile'
  | 'rs3' | 'rs3_activity' | 'rs3_pattern' | 'rs3_progression'
  | 'email' | 'email_stats' | 'news' | 'news_interests' | 'weather'
  | 'farcaster' | 'farcaster_account' | 'farcaster_conversation' | 'farcaster_signal_trends' | 'farcaster_cast_history'
  | 'flashcastr' | 'pet' | 'git' | 'job' | 'blog'
  | 'calendar' | 'notification' | 'plan'
  | 'football' | 'football_table' | 'football_next_match' | 'football_following'
  | 'news_article' | 'rs3_goals' | 'calendar_prep'
  | 'agent_directory' | 'agent_health' | 'director_chat'
  | 'gym_profile' | 'ai_usage' | 'event_tape' | 'agent_skills'
  | 'blog_schedule' | 'blog_draft'
  | 'finance' | 'finance_entities' | 'finance_categories' | 'finance_knowledge' | 'finance_receipts' | 'finance_transactions';

/**
 * Agents publish CONTENT_READY events when they produce display-worthy data.
 * display-sync subscribes and stores thin records in its read cache.
 *
 * - `domain`: discriminator — maps to a display-sync table
 * - `action`: create/update/delete — how display-sync should handle it
 * - `entityId`: stable ID for upserts (agent's primary key for this record)
 * - `forDate`: date relevance (YYYY-MM-DD), used for display ordering
 * - `display`: thin payload — just what the PWA needs for cards/list views
 * - `fullDetailAvailable`: if true, PWA can request full detail via DETAIL_REQUEST
 */
export interface ContentReadyPayload<T = Record<string, unknown>> {
  domain: ContentDomain;
  action: 'create' | 'update' | 'delete';
  entityId: string;
  forDate: string;
  display: T;
  fullDetailAvailable: boolean;
}

// ─── Per-domain display payloads ────────────────────────────────────────────

export interface RecipeNutrition {
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
}

export interface RecipeDisplay {
  title: string;
  mealType: string;
  rating: string | null;
  bookmarked: boolean;
  prepMinutes: number;
  cookMinutes: number;
  calories: number | null;
  source?: 'generated' | 'imported' | 'book-cook';
  sourceUrl?: string;
  ingredients?: string[];
  instructions?: string[];
  nutrition?: RecipeNutrition;
  cuisine?: string;
  dietaryTags?: string[];
  /** Adaptation rationale from the generation AI — why this cuisine/protein/
   *  technique for this user on this day. Only populated for source='generated'. */
  directorNote?: string | null;
  /** Unsplash photo URL fetched on-demand via the "Find image" button. */
  imageUrl?: string | null;
}

export interface RecipeProfileTag {
  tag: string;
  score: number;
}

/**
 * Summary of the user's learned taste profile, emitted daily by agent-recipe
 * post-refinement. Singleton — one row keyed by a stable entityId ('profile').
 * Top-5 per category with score >= 0.5.
 */
export interface RecipeProfileDisplay {
  cuisines: RecipeProfileTag[];
  proteins: RecipeProfileTag[];
  techniques: RecipeProfileTag[];
  ratedCount: number;
  computedAt: string; // ISO
}

export interface WorkoutExercise {
  name: string;
  sets?: number;
  reps?: string | number; // supports range syntax like "8-12"
  weight?: number;
  rest?: number;
  duration?: string;
  notes?: string;
}

export interface WorkoutDisplay {
  title: string;
  durationMinutes: number;
  intensityLevel: string;
  rating: string | null;
  completed: boolean;
  bookmarked: boolean;
  exercises?: WorkoutExercise[];
  coachNotes?: string;
  warmup?: string[];
  cooldown?: string[];
  targetMuscles?: string[];
  equipment?: string[];
  /** Current knee status snapshot at time of publish (from agent-gym). */
  kneeStatus?: 'stable' | 'flare' | 'recovery';
  /** Days since `kneeStatus` last changed. */
  kneeDaysSinceChange?: number;
  /** User-provided reason for rejecting this workout (e.g. "Went on a 3hr MTB ride"). */
  rejectedReason?: string;
}

/**
 * Learned preference snapshot for the Coach's Notes surface on /gym.
 * Published daily by agent-gym after refinement.
 */
export interface GymProfileTag {
  tag: string;
  score: number;
  dimension: string; // 'equipment' | 'intensity' | 'duration_bucket'
}

export interface GymProfileDisplay {
  topFocus: GymProfileTag[]; // score >= 0.6, sorted desc
  topAvoid: GymProfileTag[]; // score <= 0.4, sorted asc
  lastUpdated: string;       // ISO
}

export interface ActivityDisplay {
  title: string;
  category: string;
  durationMinutes: number | null;
  rating: string | null;
  completed: boolean;
  location?: string;
  requiresVehicle?: boolean;
  weatherContext?: string;
  whySuggested?: string;
  indoorOutdoor?: 'indoor' | 'outdoor' | 'either';
  socialLean?: string;
  /** Free-form time the user wants to do the activity (e.g. "12:00", "afternoon"). */
  scheduledTime?: string | null;
  /** Distance covered, in km. Populated from Strava imports or AI estimate; null when unknown. */
  distanceKm?: number | null;
  /** Total elevation gain, in metres. Null when unknown. */
  elevationGainM?: number | null;
  /** Weather conditions that suit this activity (e.g. ["sunny","cloudy"]). */
  preferredConditions?: string[];
  /** Unsplash photo URL fetched on-demand via the "Find image" button. */
  imageUrl?: string | null;
}

export interface ActivityRescheduledPayload {
  activityId: string;
  /** Free-form time string: "12:00", "noon", "3pm", "afternoon", etc. */
  scheduledTime: string;
}

/** Entry in one of the profile groups (Likes / Companion / Avoid). Score is 0–1. */
export interface ActivityProfileEntry {
  tag: string;
  score: number;
}

/**
 * Distilled activity preference profile published by agent-activity after the
 * nightly knowledge refinement. Drives the "Activity profile" chips strip.
 */
export interface ActivityProfileDisplay {
  likes: ActivityProfileEntry[];
  companion: ActivityProfileEntry[];
  avoid: ActivityProfileEntry[];
  distanceSweetSpotKm: { min: number; max: number } | null;
  /** Total rated outings backing this profile. PWA uses this for empty-state threshold. */
  ratedCount: number;
}

/** Single day in a daily forecast strip. */
export interface WeatherDayForecast {
  date: string;            // YYYY-MM-DD
  condition: string;       // 'sunny' | 'cloudy' | 'rainy' | 'snowy' | ...
  highC: number;
  lowC: number;
  precipPct: number;       // 0-100
}

/**
 * Full per-day forecast row stored in the display-sync snapshot.
 * Superset of WeatherDayForecast — carries all fields the PWA needs so the
 * gateway resolver can serve them without a round-trip to the agent PG.
 */
export interface WeatherForecastDay {
  date: string;            // YYYY-MM-DD
  condition: string;       // coarse bucket, same as WeatherDayForecast.condition
  tempMax: number;         // °C
  tempMin: number;         // °C
  precipitation: number;   // mm
  precipPct: number;       // 0-100 approximate
  weatherCode: number;
  windSpeed: number;       // km/h
  uvIndex: number;
  sunrise: string;         // ISO time string
  sunset: string;          // ISO time string
}

/** Display payload for the primary weather location. */
export interface WeatherDisplay {
  location: string;
  /** 7-day forecast, ordered oldest → newest. */
  forecast: WeatherForecastDay[];
}

// ─── Weather service push + pull contract ────────────────────────────────────

/** Emitted by service-weather after each successful home-location poll. */
export interface WeatherForecastSyncedPayload {
  location: { lat: number; lon: number };
  forecast: WeatherForecastDay[];
  syncedAt: string; // ISO
}

/**
 * Pull-based consumers send this to request forecast data for any location
 * and optional time window. service-weather responds with WeatherContextResponse.
 */
export interface WeatherContextRequest {
  type: 'weather_forecast';
  /** Omit to use the user's home location from settings. */
  location?: string | { lat: number; lon: number };
  /** ISO date-time; defaults to now. */
  startTime?: string;
  /** ISO date-time; defaults to now + 24 h. */
  endTime?: string;
}

export interface WeatherContextResponse {
  location: { name: string; lat: number; lon: number };
  forecast: WeatherForecastDay[];
  resolvedAt: string; // ISO
}

export interface Rs3SkillDelta {
  name: string;
  xpGained: number;
  leveledUp?: boolean;
}

export interface Rs3InferredActivity {
  kind: string;
  confidence: number;
  description: string;
}

export interface Rs3Display {
  playerName: string;
  totalXpGained: number;
  topSkills: Rs3SkillDelta[];
  inferredActivity?: Rs3InferredActivity;
  // Count of skills (excluding 'overall') with xpGained > 0 for the day.
  // Separate from topSkills so the full count survives the top-5 cap.
  activeSkillsCount?: number;
}

/** Single learned pattern row — one per (playerName, patternType, patternKey). */
export interface Rs3PatternDisplay {
  playerName: string;
  patternType: string; // 'main_session' | 'skill_focus' | 'activity_frequency' | 'daily_challenge' | 'rest_days' | 'next_level_eta'
  patternKey: string;
  value: Record<string, unknown>;
  summary: string;
  computedAt: string; // ISO
}

/** Per-player 30-day skill progression summary. One row per player. */
export interface Rs3ProgressionSkill {
  skill: string;
  xpGained: number;
  currentLevel: number;
  currentXp: number;
  barNormalized: number; // xpGained / max(xpGained across returned skills), 0..1
}

export interface Rs3ProgressionDisplay {
  playerName: string;
  windowDays: number;
  skills: Rs3ProgressionSkill[]; // already sorted desc by xpGained
}

export type Rs3ActivityType =
  | 'herb_run'
  | 'tree_run'
  | 'necromancy_training'
  | 'invention_training'
  | 'slayer_task'
  | 'clue_scroll'
  | 'skilling_session'
  | 'daily_challenge'
  | 'idle_afk'
  | 'other';

export type Rs3ActivityFeedback = 'accurate' | 'inaccurate';

export interface Rs3ActivityDisplay {
  activityId: string;
  playerName: string;
  forDate: string; // YYYY-MM-DD
  activityType: Rs3ActivityType;
  title: string; // e.g. "~3 herb runs + 1 tree run"
  primarySkill: string;
  xpGained: number;
  skillBreakdown: Record<string, number>;
  confidence: number; // 0..1
  reason: string;
  userFeedback?: Rs3ActivityFeedback | null;
}

export interface Rs3ActivityFeedbackPayload {
  activityId: string;
  feedback: Rs3ActivityFeedback;
  note?: string;
}

/**
 * Raw contributions that combined into the email relevance scalar.
 * Populated by agent-email's scorer from LOS-355 onward — nullable on the
 * `EmailDisplay` payload for rows produced before the breakdown was captured.
 */
export interface EmailScoreBreakdown {
  /** Per-sender learned importance bump, 0..1. */
  senderImportance: number;
  /** Per-domain learned relevance, 0..1. */
  domainRelevance: number;
  /** Calendar-topic overlap boost, 0..0.2 (additive). */
  calendarContext: number;
  /** Pre-learning classifier base score, 0..1. */
  baseClassifier: number;
}

/**
 * Lightweight sender-trust signal derived from agent-email's sender-importance
 * table. Drives the §37 "4 prior threads · trusted sender" chip.
 */
export interface SenderTrust {
  priorThreadCount: number;
  trusted: boolean;
}

export interface EmailDisplay {
  from: string;
  subject: string;
  snippet: string;
  relevance: number | null;
  /** Labels from Gmail (used by filter chips). Null for historical rows. */
  labels?: string[];
  threadId?: string;
  receivedAt?: string;
  /** Score breakdown; null/undefined for rows produced before LOS-355. */
  scoreBreakdown?: EmailScoreBreakdown | null;
  /** Sender trust derived from sender-importance table. Null when unknown. */
  senderTrust?: SenderTrust | null;
}

/**
 * Singleton stats payload published by agent-email after each tick.
 * Stored in display-sync as entityId='stats'; read by the emailInboxStats resolver.
 * Carries the 7-day learning accuracy computed from email_rating_log (agent-email PG).
 */
export interface EmailStatsDisplay {
  /** Fraction of ratings over the last 7 days that agreed with the relevance class. */
  learningAccuracy7d: number | null;
  /** ISO timestamp of when this was computed. */
  computedAt: string;
}

/**
 * User-facing relevance rating for a specific email. Consumed by agent-email
 * to bump sender_importance + domain_relevance and to append to email_rating_log.
 */
export interface EmailRelevanceRatedPayload {
  messageId: string;
  relevant: boolean;
}

/** @deprecated Use NewsDigestDisplay */
export type NewsDisplay = NewsDigestDisplay;

export interface NewsDigestDisplay {
  slot: string;
  summary: string;
  articleCount: number;
  articleIds: string[];
  articles: Array<{
    id: string;
    url: string;
    source: string;
    title: string;
    description: string;
    topics: string[];
    relevance: number;
    publishedAt: string;
  }>;
}

export interface FlashcastrDisplay {
  invaderId: string;
  city: string;
  eventType: string;
}

export interface PetLocation {
  lat: number;
  lng: number;
  zone: string;
}

export interface PetDisplay {
  petName: string;
  totalSteps: number;
  stepGoal: number;
  walkCount: number | null;
  napMinutes?: number | null;
  sleepMinutes?: number | null;
  activityType?: string | null;
  areaName?: string | null;
  placeName?: string | null;
  location?: PetLocation;
  batteryPercent?: number;
  connectionStatus?: 'connected' | 'disconnected' | 'unknown';
  alertType?: string;
  lastSeenAt?: string;
}

export interface GitDisplay {
  commitCount: number;
  repoCount: number;
  repos: string[];
}

export type JobInterviewStageStatus = 'upcoming' | 'active' | 'done' | 'skipped';

export interface JobInterviewStage {
  id: string;
  ordinal: number;
  label: string;
  status: JobInterviewStageStatus;
  scheduledAt?: string;
  notes?: string;
}

export interface JobDisplay {
  title: string;
  company: string;
  relevanceScore: number | null;
  applicationStatus: string | null;
  location?: string;
  salary?: string;
  matchReasons?: string[];
  techStack?: string[];
  postedAt?: string;
  url?: string;
  classification?: string;
  interviewStages?: JobInterviewStage[];
}

export interface BlogDisplay {
  blogType: string;
  summary: string;
  concepts: string[];
  paragraphUrl: string | null;
  status?: 'draft' | 'scheduled' | 'published';
  readingTimeMinutes?: number;
  markdown?: string;
}

/**
 * LOS-265 — Mode A pending-review draft surfaced in the PWA review queue.
 * agent-blog publishes one row per `dev_blog_entries` row with status='pending_review';
 * tombstones (data=null) on approve / reject / edit-publish.
 * entityId = dev_blog_entries.id (uuid).
 */
export interface BlogDraftDisplay {
  /** dev_blog_entries.id — the post we're reviewing. */
  postId: string;
  forDate: string;
  title: string;
  generatedDraftMd: string;
  /** Verbatim user notes the draft was built from. */
  sourceNotesMd: string;
  notionPageId: string;
  /** Mirror of provenance.draftConfidence (0..1). */
  confidenceScore: number;
  /** Mirror of provenance.sensitiveConfidence (0..1). */
  sensitiveConfidence: number;
  sensitiveFlags: string[];
  /** User-readable reasons the draft failed auto-publish. */
  pendingReasons: string[];
  /** Claims the guard refused to keep (from provenance_json). */
  strippedClaims: string[];
  /** ISO timestamp the row was created. */
  createdAt: string;
}

/**
 * Singleton schedule entry per blog type — published by agent-blog on startup
 * and after each successful publication. entityId = `blog_schedule:{blogType}`.
 */
export interface BlogScheduleDisplay {
  blogType: string;
  nextPublishAt: string | null;    // ISO datetime of next scheduled publish, or null if disabled
  lastPublishedAt: string | null;  // ISO datetime of last successful publish
  enabled: boolean;
}

export interface CalendarDisplay {
  title: string;
  startTime: string;
  endTime: string;
  location: string | null;
  category: string;
  attendees?: CalendarAttendee[];
  prepDocStatus?: 'none' | 'generating' | 'ready';
  prepNotionUrl?: string;
  meetingNoteId?: string;
}

export interface PlanDisplay {
  taskCount: number;
  totalMinutes: number;
  summary: string;
  overview: string;
}

// ─── New display types (LOS-255) ──────────────────────────────────────────

export type FootballMatchStatus =
  | 'TIMED' | 'SCHEDULED' | 'IN_PLAY' | 'PAUSED' | 'HALFTIME'
  | 'FINISHED' | 'POSTPONED' | 'CANCELLED' | 'SUSPENDED' | 'AWARDED';

export interface FootballMatchDisplay {
  competition: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: string;
  venue: string | null;
  status: FootballMatchStatus;
  homeScore?: number;
  awayScore?: number;
  followedTeam: string;
}

// ─── Football enriched display types (LOS-334) ──────────────────────────

export type FootballFormResult = 'W' | 'D' | 'L';

export interface FootballTableRowDisplay {
  position: number;
  team: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalDifference: number;
  points: number;
  isFollowed: boolean;
}

export interface FootballTableDisplay {
  competitionCode: string;     // 'PL', 'MLS', ...
  competitionName: string;
  matchweek: number | null;
  totalMatchweeks: number | null;
  rows: FootballTableRowDisplay[];
}

export interface FootballH2HMeetingDisplay {
  date: string;                // ISO
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  /** Winner from this meeting's perspective. Stored so the read side can
   *  pivot aggregates (home/away wins/draws) against an upcoming fixture
   *  without re-deriving from scores. */
  winner: 'home' | 'away' | 'draw';
}

export interface FootballNextMatchSideDisplay {
  team: string;
  position: number | null;
  points: number | null;
  /**
   * Last-5 form, oldest → newest left-to-right. Length is 0–5 (new teams
   * early in a competition may have fewer than 5 completed matches).
   * Readonly: consumers must not mutate.
   */
  formLast5: readonly FootballFormResult[];
}

export interface FootballH2HDisplay {
  /** Last 3–5 meetings, newest first. Aggregates (homeWins/draws/awayWins
   *  pivoted to a fixture's home side) are derived on the read side. */
  lastMeetings: FootballH2HMeetingDisplay[];
}

/**
 * Enriched "next match" card — superset of FootballMatchDisplay that bundles
 * league standings snippet for each side, last-5 form, and H2H aggregate.
 * Published separately from the basic FootballMatchDisplay stream so existing
 * list queries are unaffected.
 */
export interface FootballNextMatchDisplay {
  competition: string;
  competitionCode: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: string;
  venue: string | null;
  followedTeam: string;
  home: FootballNextMatchSideDisplay;
  away: FootballNextMatchSideDisplay;
  h2h: FootballH2HDisplay;
}

/**
 * Status of the next match for a followed team, as a discriminated union.
 * The legacy string label ('Live 2h', 'Sat', 'Jun') is now formatted by
 * `formatFootballNextStatus()` on the read side.
 */
export type FootballNextStatus =
  | { kind: 'live' }
  | { kind: 'scheduled'; kickoffUtc: string }
  | { kind: 'none' };

export interface FootballFollowingTeamDisplay {
  team: string;
  competitionCode: string;
  nextKickoffUtc: string | null;
  nextStatus: FootballNextStatus;
  nextOpponent: string | null;
  nextIsHome: boolean | null;
}

/**
 * Format a FootballNextStatus as the legacy short label. Keeps the PWA
 * working unchanged while the structured fields are also available.
 * Pure function — safe to call from agent, gateway, or PWA.
 */
export function formatFootballNextStatus(status: FootballNextStatus, timezone: string, now: Date = new Date()): string | null {
  if (status.kind === 'none') return null;
  if (status.kind === 'live') return 'Live';

  const kickoff = new Date(status.kickoffUtc);
  const diffMs = kickoff.getTime() - now.getTime();
  if (diffMs < 0) return null;

  const diffDays = diffMs / 86_400_000;
  if (diffDays < 1) return 'Today';
  if (diffDays < 2) return 'Tomorrow';
  if (diffDays < 7) {
    return kickoff.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'short' });
  }
  return kickoff.toLocaleDateString('en-US', { timeZone: timezone, month: 'short' });
}

export interface FootballFollowingDisplay {
  teams: FootballFollowingTeamDisplay[];
}

export interface FarcasterCastDisplay {
  account: string;
  text: string;
  status: 'draft' | 'approved' | 'published' | 'rejected';
  rejectionReason?: string;
  publishedAt?: string;
  castHash?: string;
  editedText?: string;
  // Optional richer context surfaced to the PWA (LOS-305b §23 rebuild)
  planType?: string;            // 'original' | 'engagement' | 'conversation'
  channelId?: string | null;    // target channel, null = main feed
  parentHash?: string | null;
  parentText?: string | null;
  reasoning?: string;
  contextSource?: string | null;
  scheduledFor?: string | null;
  createdAt?: string;
}

/**
 * Display payload for a managed Farcaster account (e.g. `@henrypye`, `@flashcastr`).
 * Mirrors the non-secret fields from `broadcast-cast`'s local account store.
 */
export interface FarcasterAccountDisplay {
  handle: string;
  fid: number;
  displayName: string;
  pfpUrl?: string | null;
  enabled: boolean;
  requiresApproval: boolean;
  contentSource: string | null;   // 'ai_plan' | 'agent-flashcastr' | null
  dailyCastTarget: number;
  dailyEngagementLimit: number;
}

/**
 * Display payload for an active conversation with a Farcaster friend —
 * derived from `farcaster_conversations` rows in the agent DB.
 */
export interface FarcasterConversationDisplay {
  accountHandle: string;
  threadRootHash: string;
  friendFid: number;
  friendUsername: string;
  friendDisplayName?: string | null;
  lastCastHash: string;
  lastCastByUser: boolean;
  messageCount: number;
  startedAt: string;                          // ISO
  lastActivityAt: string;                     // ISO
  status: 'active' | 'stale' | 'ended';
}

/**
 * Aggregate engagement signal trends for a managed account, produced by
 * agent-farcaster's nightly `analyze-engagement` refinement job. Powers the
 * §23 signal trends surface in the PWA (top channels, best hours, friends).
 */
export interface FarcasterSignalTrendChannel {
  channel: string;              // channelId or 'main' for null
  castCount: number;
  totalEngagement: number;
  avgEngagement: number;
}

export interface FarcasterSignalTrendHour {
  hour: number;                 // 0-23, user-local
  castCount: number;
  avgEngagement: number;
}

export interface FarcasterSignalTrendFriend {
  username: string;
  engagementScore: number;      // 0-1
  interactions: number;         // likesGiven+received + replies + recasts
}

export interface FarcasterSignalTrendsDisplay {
  accountHandle: string;
  windowDays: number;           // e.g. 7 for last 7d
  totalCasts: number;
  totalEngagement: number;      // reactions + replies + recasts across casts
  avgEngagementPerCast: number;
  topChannels: FarcasterSignalTrendChannel[];
  topHours: FarcasterSignalTrendHour[];
  topFriends: FarcasterSignalTrendFriend[];
  computedAt: string;           // ISO
}

/**
 * A single published cast from the account's cast history, broadcast by
 * agent-farcaster after each sync window. Powers the cast history section
 * on the /farcaster PWA page (LOS-459).
 */
export interface FarcasterCastHistoryDisplay {
  accountHandle: string;
  castHash: string;
  text: string;
  channelId: string | null;
  publishedAt: string;           // ISO
  reactions: number;
  replies: number;
  recasts: number;
}

/**
 * Aggregate topic-preference scores learned from per-article ratings
 * (via NEWS_FEEDBACK → agent-news refinement). One row per user surfaced
 * to the /news "Interests" strip. Scores are 0..1 where >= 0.5 = positive.
 */
export interface NewsTopicScore {
  topic: string;
  score: number;      // 0..1
  ratedCount: number; // how many rated articles contributed to this topic
}

export interface NewsInterestsDisplay {
  topics: NewsTopicScore[];
  totalRatedCount: number;
  updatedAt: string; // ISO
}

export interface NewsArticleDisplay {
  slot: string;
  source: string;
  title: string;
  summary: string;
  url: string;
  relevance: number;
  rating?: string;
  topics?: string[];
  publishedAt?: string;
}

export interface Rs3GoalsDisplay {
  playerName: string;
  skill: string;
  targetLevel: number;
  targetXp: number;
  startedAt: string;
  pace7dXp?: number;
  etaDate?: string;
}

export interface CalendarPrepDisplay {
  eventId: string;
  notionPageUrl: string;
  generatedAt: string;
  topic: string;
  bulletSummary?: string[];
}

export interface AgentDirectoryDisplay {
  kind: 'agent' | 'module' | 'broadcast' | 'service';
  domain: string;
  role: string;
  observationCount: number;
  lastObservation?: string;
  lastRefinementAt?: string;
}

export interface DirectorChatDisplay {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
}

// ─── Agent heartbeat + meta payloads (LOS-258 Stream C, types defined here) ─

export interface AgentHeartbeatPayload {
  agent: string;
  status: 'healthy' | 'drift' | 'down';
  lastTick: string;
  lagSeconds?: number;
  queueDepth?: number;
  errorRate1m?: number;
}

/** Display projection of agent health — same shape as the heartbeat payload. */
export type AgentHealthDisplay = AgentHeartbeatPayload;

export interface AgentMetaPayload {
  agent: string;
  kind: 'agent' | 'module' | 'broadcast' | 'service';
  domain: string;
  role: string;
  observationCount: number;
  lastObservation?: string;
  lastRefinementAt?: string;
}

export interface AgentErrorPayload {
  agent: string;
  code: string;
  message: string;
  occurredAt: string;
  context?: Record<string, unknown>;
}

// ─── Detail request/response (api-gateway ↔ agent) ─────────────────────────

export interface DetailRequestPayload {
  domain: ContentDomain;
  entityId: string;
  requestId: string;
}

export interface DetailResponsePayload<T = unknown> {
  requestId: string;
  domain: ContentDomain;
  entityId: string;
  detail: T;
}

// ─── Config (bus-based settings for workers) ────────────────────────────────

/**
 * Lightweight signal: "settings changed, re-read from OV."
 * No key/value payload — agents re-read all settings from OV on receiving this.
 */
export interface ConfigUpdatedPayload {
  /** Who triggered the change (e.g., 'notion-profile', 'pwa'). */
  source: string;
}

// ─── Push subscriptions ────────────────────────────────────────────────────

export interface PushSubscribePayload {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// ─── Notification routed (legacy — service-notifications was retired) ─────

export type NotificationSeverity = 'breaking' | 'digest' | 'low';
export type NotificationChannel = 'frontend';

export interface NotificationRoutedPayload {
  notificationId: string;
  channel: NotificationChannel;
  severity: NotificationSeverity;
  sourceAgent: string;
  /** SHA256(endpoint).slice(0, 16) — no raw endpoint URL in the event stream */
  subscriptionHash: string;
  routedAt: string;
}

// ─── Completion request (agent refinement → service-notion) ─────────────

export interface CompletionRequestPayload {
  requestId: string;
  requester: string;  // agent domain name (e.g., 'activity', 'recipe')
  date: string;       // YYYY-MM-DD
}

export interface CompletionResponsePayload {
  requestId: string;
  requester: string;
  completions: TaskCompletionPayload[];
}

// ─── Notion page fetch (director → service-notion) ───────────────────────

export interface NotionPageFetchRequestPayload {
  requestId: string;
  date: string;
  requester: string;
}

export interface NotionPageFetchResponsePayload {
  requestId: string;
  date: string;
  pageId: string | null;
  content: string | null;
}

export interface NotionProfileFetchRequestPayload {
  requestId: string;
  requester: string;
}

export interface NotionProfileFetchResponsePayload {
  requestId: string;
  /** Main profile page content */
  profile: string | null;
  /** Subpage contents keyed by title (e.g., "Goals", "CV") */
  subpages: Record<string, string>;
}

export interface NotionProfileChangedPayload {
  /** Full raw profile prose (main page + subpages concatenated). */
  text: string;
  /** sha256 slice used for dedup — 16 hex chars. */
  contentHash: string;
}

// ─── /agents page wiring (LOS-348) ──────────────────────────────────────────

/** Emitted by AIClient after every completion — fuels the /agents model+agent
 *  routing strip and daily spend cell. entityId = `${ts}:${agent}:${model}` (unique per call). */
export interface AiUsageDisplay {
  ts: string;                  // ISO
  agent: string;
  model: string;               // full model id (e.g. 'claude-sonnet-4-6')
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd: number;
  taskName?: string;
}

/** Append-only tape row. Producer flushes a bounded ring buffer every 5s as
 *  CONTENT_READY_EVENT_TAPE events. entityId = `${ts}:${routingKey}` so
 *  replays are idempotent. */
export interface EventTapeDisplay {
  ts: string;                  // ISO
  routingKey: string;
  source?: string;
  payloadPreview: string;      // short JSON preview, ≤256 chars, safe to show in UI
  byteSize: number;            // original payload size in bytes
}

/** Per-agent skill list. Published daily by service-git for itself; other agents
 *  use the static SKILL_MAP in `@life-os/shared`. entityId = agent name. */
export interface AgentSkillsDisplay {
  agent: string;
  skills: string[];
}

// ─── Image service ──────────────────────────────────────────────────────────

export interface ImageRequestPayload {
  requestId: string;            // UUID for correlation
  query: string;                // Unsplash search query (domain-specific, built by caller)
  entityId: string;             // activityId / recipeId
  callbackRoutingKey: string;   // e.g. 'life.image.response.activity'
}

export interface ImageResponsePayload {
  requestId: string;
  entityId: string;
  imageUrl: string | null;
}

// ─── Context service (OV proxy) ─────────────────────────────────────────────

export interface OvWritePayload {
  path: string;    // OV URI, e.g. /agent/recipe/learned/preferences.md
  content: string;
}

// ─── Finance (agent-finance) ────────────────────────────────────────────────

export type FinanceBank = 'amex' | 'monzo' | 'gnosis_pay' | 'bmo';

export type FinanceEntityKind =
  | 'person' | 'employer' | 'landlord' | 'vendor' | 'government' | 'bank' | 'unknown';

export type FinanceEntityRelationship =
  | 'family' | 'friend' | 'self' | 'business';

export type FinanceCategoryDirection = 'in' | 'out' | 'either';
export type FinanceCategoryGroup =
  | 'income' | 'fixed' | 'discretionary' | 'savings' | 'transfer' | 'other';

/** Gateway → agent on CSV upload. Gateway enforces a 5 MB cap on `csvContent`. */
export interface FinanceStatementUploadedPayload {
  bank: FinanceBank;
  month: string;            // 'YYYY-MM'
  filename: string;
  csvContent: string;
  uploadedAt: string;
}

/** Agent → notifications / subscribers after deep-dive completes. */
export interface FinanceAnalysisReadyPayload {
  month: string;
  healthScore: number;
  totalIncome: number;
  totalSpend: number;
  savingsRate: number;
  topInsight: string;
}

/** PWA → agent when the user re-labels a single transaction. `userCorrected=true` then locks it. */
export interface FinanceTxRecategorisedPayload {
  transactionId: string;
  newCategorySlug: string;
  userNote?: string;
}

/** PWA → agent when user edits an entity (rename, set relationship, attach note). */
export interface FinanceEntityUpdatedPayload {
  entityId: string;
  canonicalName?: string;
  kind?: FinanceEntityKind;
  relationship?: FinanceEntityRelationship | null;
  notes?: string;
}

/** Gateway → agent. Gateway enforces a 20 MB cap on `contentBase64`. */
export interface FinanceKnowledgeUploadedPayload {
  sourceId: string;
  filename: string;
  contentType: string;
  contentBase64: string;
}

/** Agent → subscribers once a knowledge source is distilled (LOS-488). */
export interface FinanceKnowledgeProcessedPayload {
  sourceId: string;
  status: 'ready' | 'failed';
  principleCount?: number;
  error?: string;
}

/** Gateway → agent. Triggers deletion of a knowledge source and its OV artefacts. */
export interface FinanceKnowledgeDeleteRequestedPayload {
  sourceId: string;
}

/** Agent → subscribers once a receipt photo is OCR'd and matched (LOS-486). */
export interface FinanceReceiptProcessedPayload {
  receiptId: string;
  transactionId: string | null;
  status: 'matched' | 'unmatched' | 'failed';
  error?: string;
}

/** Monthly summary for list views. */
export interface FinanceDisplay {
  type: 'finance_summary';
  month: string;
  healthScore: number;
  totalIncome: number;
  totalSpend: number;
  savingsRate: number;
  subscriptionCost: number;
  categoryBreakdown: Record<string, number>;
  topGoalStatus: string;
  analysisPreview: string;
}

export interface FinanceEntityRow {
  id: string;
  canonicalName: string;
  kind: FinanceEntityKind | string;
  relationship: FinanceEntityRelationship | null;
  defaultCategorySlug: string | null;
  /** e.g. "Likely primary salary (±£20 over 6 months)". */
  inferredLabel: string | null;
  recurrence: string | null;
  avgAmountCad: number | null;
  totalIn: number;
  totalOut: number;
  txCount: number;
  lastSeen: string;
  confirmedByUser: boolean;
}

export interface FinanceEntitiesDisplay {
  type: 'finance_entities';
  entities: FinanceEntityRow[];
}

export interface FinanceCategoryRow {
  id: string;
  slug: string;
  label: string;
  direction: FinanceCategoryDirection;
  group: FinanceCategoryGroup;
  isActive: boolean;
  sortOrder: number;
}

export interface FinanceCategoriesDisplay {
  type: 'finance_categories';
  categories: FinanceCategoryRow[];
}

/** One transaction row surfaced in the PWA Transactions tab. */
export interface FinanceTransactionRow {
  id: string;
  date: string;
  description: string;
  entityId: string | null;
  entityName: string | null;
  amountCad: number;
  direction: 'in' | 'out';
  categorySlug: string | null;
  categoryLabel: string | null;
  userCorrected: boolean;
  notes: string | null;
}

/** Month-keyed transactions blob. entityId = `finance_transactions_YYYY-MM`. */
export interface FinanceTransactionsDisplay {
  type: 'finance_transactions';
  month: string;
  transactions: FinanceTransactionRow[];
}

export interface FinanceKnowledgeSource {
  id: string;
  filename: string;
  sourceTitle: string | null;
  summary: string | null;
  principleCount: number;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  uploadedAt: string;
}

export interface FinanceKnowledgeDisplay {
  type: 'finance_knowledge';
  sources: FinanceKnowledgeSource[];
}

/**
 * Opaque goal identifier — the slug from the user's Notion Finances/Goals page.
 * Consumers must treat this as opaque; it MUST NOT carry a human-readable title
 * or any counterparty name.
 */
export type FinanceGoalSlug = string;

/**
 * Cross-agent aggregate summary. Written to OV at `resources/user/finances/budget_summary`
 * after every deep-dive run. Strictly redacted: no entity names, no counterparties,
 * no per-entity amounts, no loan balances — goals identified by slug only.
 */
export interface FinanceBudgetSummary {
  month: string;
  monthlyDiscretionaryBudgetCad: number;
  savingsRateTarget: number;
  savingsRateActual: number;
  onTrackGoals: FinanceGoalSlug[];
  atRiskGoals: FinanceGoalSlug[];
  offTrackGoals: FinanceGoalSlug[];
  updatedAt: string;
}

export interface FinanceCategoryUpsertedPayload {
  slug: string;
  label: string;
  direction: FinanceCategoryDirection;
  group: FinanceCategoryGroup;
  aiHint?: string;
  sortOrder?: number;
}

export interface FinanceCategoryDeactivatedPayload {
  slug: string;
}

/** Gateway → agent. Image bytes to OCR for receipt extraction (LOS-486). */
export interface FinanceReceiptUploadedPayload {
  imageBase64: string;
  contentType: string;
}

/** CONTENT_READY display payload for the receipts tab (LOS-486). */
export interface FinanceReceiptsDisplayPayload {
  type: 'finance_receipts';
  recentReceipts: Array<{
    id: string;
    store: string;
    purchaseDate: string;
    totalAmount: number;
    itemCount: number;
  }>;
  upcomingRestocks: Array<{
    itemKey: string;
    displayName: string;
    nextExpectedDate: string;
    avgGapDays: number;
  }>;
  monthlyStats: {
    receiptsThisMonth: number;
    itemsThisMonth: number;
    topCategories: Array<{ category: string; amount: number }>;
  };
}

// ─── Finance reset (LOS-508) ────────────────────────────────────────────────

/** api-gateway → agent-finance. Triggers a transactional wipe of statement-derived tables. */
export interface FinanceResetRequestPayload {
  correlationId: string;
}

/**
 * api-gateway → agent-finance. Admin trigger to re-run monthly analysis for every
 * month that has at least one transaction. Handler queries distinct months from
 * its own DB and fans out one FINANCE_IMPORT_BATCH_COMPLETED per month so each
 * gets an independent retry budget.
 */
export interface FinanceReanalyseAllRequestPayload {
  requestedAt: string;
}

/** agent-finance → api-gateway. Counts of rows removed during the reset. */
export interface FinanceResetResponsePayload {
  correlationId: string;
  deletedTransactions: number;
  deletedBankImports: number;
  deletedMonthlySummaries: number;
  deletedEntities: number;
  deletedCategories: number;
}

// ─── Finance pipeline 2 — annual report (LOS-504) ───────────────────────────

/** Gateway → agent-finance. Triggers pipeline 2 (AI annual report). Payload is opaque trigger. */
export interface FinanceRegenerateReportPayload {
  requestedAt: string;
}

/** Per-goal progress snapshot, produced by computeGoalProgress(). */
export interface FinanceGoalProgressEntry {
  goalSlug: string;
  /** Human-readable label derived from goal slug (e.g. "Australia flights"). */
  label: string;
  status: 'on_track' | 'behind' | 'ahead' | 'no_data';
  /** Plain-English recommendation. May cite principleIds. */
  recommendation: string;
  /** Principle IDs from the knowledge index cited in recommendation. */
  citedPrincipleIds: string[];
  targetAmount: number | null;
  deadline: string | null;
}

// ─── Finance forecast + coaching (LOS-532) ───────────────────────────────────

export interface FinanceForecastPayload {
  horizonMonths: 12;
  scenarios: {
    statusQuo: FinanceForecastSeries;
    improved: FinanceForecastSeries;
  };
}

export interface FinanceForecastSeries {
  monthly: Array<{
    month: string; // YYYY-MM
    projectedIncome: number;
    projectedSpend: number;
    projectedSavings: number;
    cumulativeSavings: number;
    goalProgress: Array<{ goalSlug: string; pctComplete: number | null }>;
  }>;
}

export interface FinanceCoachingPayload {
  startDoing: FinanceCoachingItem[];
  stopDoing: FinanceCoachingItem[];
  consolidate: FinanceCoachingItem[];
  strategies: FinanceCoachingItem[];
}

export interface FinanceCoachingItem {
  id: string;
  title: string;
  rationale: string;
  estimatedAnnualImpactCad: number | null;
  citedPrincipleIds: string[];
}

/** service-notion → agent-finance. Dedicated Finances Notion page changed (hash-gated). */
export interface NotionFinancePageChangedPayload {
  pageId: string;
  contentHash: string;
  parsedGoals: Array<{
    id: string;
    title: string;
    type: 'savings' | 'budget' | 'debt';
    targetAmount?: number;
    monthlyAmount?: number;
    weeklyBudget?: number;
    currency: 'GBP' | 'CAD' | 'USD' | 'EUR';
    targetDate?: string;
    notes?: string;
  }>;
  updatedAt: string;
}

/** agent-finance → subscribers. Full annual report snapshot, published on FINANCE_REPORT_READY. */
export interface FinanceReportReadyPayload {
  reportId: string;
  generatedAt: string;
  throughMonth: string;
  narrative: string;
  recommendations: string[];
  citedPrincipleIds: string[];
  goalProgress: FinanceGoalProgressEntry[];
  txDelta: number;
  principlesDelta: number;
  goalsChanged: boolean;
  /** Notion page URL, set once service-notion upserts it. Null if Notion sync hasn't run yet. */
  notionUrl: string | null;
  /** Cost in USD for this pipeline-2 run. */
  costUsd: number;
  /** 12-month deterministic forecast, both status-quo and coaching-improved scenarios. */
  forecast: FinanceForecastPayload;
  /** AI-generated structured savings coaching (start/stop/consolidate/strategies). */
  coaching: FinanceCoachingPayload;
  /** Human-readable bullet list describing how the forecast was computed. */
  forecastAssumptions: string[];
}

// ─── Finance bulk import (LOS-509) ──────────────────────────────────────────

/** api-gateway → agent-finance. Process one file in a bulk import batch. */
export interface FinanceImportFileRequestPayload {
  batchId: string;
  bank: 'amex' | 'monzo' | 'gnosis_pay' | 'bmo';
  csvText: string;     // raw CSV contents — inlined; PWA reads File.text() and passes through
  fileName: string;
}

/** api-gateway → agent-finance. Batch row created; agents can track progress. */
export interface FinanceImportBatchCreatedPayload {
  batchId: string;
  bank: string;
  fileCount: number;
  reportedGaps: string[];  // YYYY-MM strings the UI flagged as gaps at submit
}

/** agent-finance → subscribers. Fired once all files in a batch are processed. */
export interface FinanceImportBatchCompletedPayload {
  batchId: string;
  /** 'complete' | 'partial_failure' */
  status: string;
  monthsTouched: string[];  // distinct YYYY-MM values from inserted rows
}

/** agent-finance → display-sync. Per-bank coverage months refreshed. */
export interface FinanceBankCoverageUpdatedPayload {
  bank: string;
  coveredMonths: string[];  // sorted YYYY-MM strings
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

export interface ReconcileRequestPayload {
  requestId: string;
  agent: string;  // agent name or '*' for all
  reason?: string;
}

export interface ReconcileProgressPayload {
  requestId: string;
  agent: string;
  emitted: number;
  estimatedTotal?: number;
  startedAt: string;
}

export interface ReconcileCompletePayload {
  requestId: string;
  agent: string;
  emitted: number;
  durationMs: number;
  error?: string;
}

// ─── Linear service (service-linear) ────────────────────────────────────────

export interface LinearTicketCreateRequestPayload {
  requestId: string;
  title: string;
  description: string;           // markdown
  labels: string[];              // by name; auto-created by service-linear if missing
  priority: 1 | 2 | 3 | 4;       // 1=Urgent, 2=High, 3=Normal, 4=Low
  assignToCurrentCycle?: boolean; // defaults to true
}

export interface LinearTicketCreatedPayload {
  requestId: string;
  linearTicketId: string;
  linearUrl: string;
}

export interface LinearTicketStatusRequestPayload {
  requestId: string;
  ticketId: string; // Linear issue id or identifier (e.g. LOS-123)
}

export interface LinearTicketStatusResponsePayload {
  requestId: string;
  ticketId: string;
  status: string;
  statusType: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
  updatedAt: string;
  completedAt?: string;
}

export interface LinearTicketDetailRequestPayload {
  requestId: string;
  ticketId: string;
}

export interface LinearTicketDetailResponsePayload {
  requestId: string;
  ticket: {
    id: string;
    identifier: string;  // e.g. "LOS-360"
    title: string;
    description: string;
    status: string;
    statusType: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
    priority: number;
    labels: string[];
    assignee?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    cycleId?: string;
    projectId?: string;
    url: string;
  };
}

/** List tickets matching a server-side filter. Used by agent-blog Mode B
 *  (LOS-266) to enumerate Done tickets in the last 24h before scoring. */
export interface LinearTicketsListRequestPayload {
  requestId: string;
  /** ISO timestamp lower bound for `completedAt`. Inclusive. */
  completedSince?: string;
  /** Linear status type filter (e.g. `'completed'`). Matches the `state.type`
   *  enum used in LinearTicketStatusResponsePayload.statusType. */
  state?: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
  /** Default 50, hard cap 200 to keep payloads bounded. */
  limit?: number;
}

export interface LinearTicketsListResponsePayload {
  requestId: string;
  tickets: Array<{
    id: string;
    identifier: string;
    title: string;
    description: string;
    completedAt?: string;
    labels: string[];
    parentId?: string;
  }>;
}

/** Thin alias over LinearTicketCreateRequest used by the self-heal flow.
 *  Caller pre-supplies priority: 1 and labels: ['self-heal', ...].
 *  Same handler; only the fingerprint field distinguishes the response. */
export interface BugTicketCreatePayload extends LinearTicketCreateRequestPayload {
  fingerprint?: string;
}

export interface BugTicketCreatedPayload extends LinearTicketCreatedPayload {
  fingerprint?: string;
}

// ─── Event factory ──────────────────────────────────────────────────────────

export function createLifeEvent<T>(params: {
  routingKey: string;
  source: string;
  payload: T;
  relevance?: number;
}): LifeEvent<T> {
  return {
    id: uuid(),
    timestamp: new Date().toISOString(),
    routingKey: params.routingKey,
    source: params.source,
    payload: params.payload,
    relevance: params.relevance,
  };
}
