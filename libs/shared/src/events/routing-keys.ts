export const ROUTING_KEYS = {
  // Email
  EMAIL_RECEIVED: 'life.email.received',
  EMAIL_FEEDBACK: 'life.email.feedback',
  // User rates a specific email's relevance (PWA → agent-email). Feeds learning
  // loops: bumps sender_importance + domain_relevance and appends to
  // email_rating_log. See LOS-355 / LOS-356.
  EMAIL_RELEVANCE_RATED: 'life.email.relevance.rated',

  // Calendar
  CALENDAR_UPCOMING: 'life.calendar.upcoming',
  CALENDAR_STARTED: 'life.calendar.started',
  CALENDAR_HOLIDAY: 'life.calendar.holiday',

  // Weather
  WEATHER_UPDATED: 'life.weather.updated',
  /** Emitted by service-weather when coords are resolved via geocoding (missing lat/lon self-heal). */
  USER_LOCATION_RESOLVED: 'life.user.location.resolved',
  WEATHER_ALERT: 'life.weather.alert',
  /** Emitted by service-weather after each successful home-location poll. */
  WEATHER_FORECAST_SYNCED: 'life.weather.forecast_synced',
  /** Pull-based consumers request a forecast for an arbitrary location/window. */
  WEATHER_CONTEXT_REQUEST: 'life.weather.context_request',
  WEATHER_CONTEXT_RESPONSE: 'life.weather.context_response',

  // Image service
  IMAGE_REQUEST: 'life.image.request',
  IMAGE_RESPONSE: 'life.image.response',

  // Recipe
  RECIPE_GENERATED: 'life.recipe.generated',
  RECIPE_RATED: 'life.recipe.rated',
  RECIPE_BOOKMARKED: 'life.recipe.bookmarked',
  RECIPE_REGENERATE: 'life.recipe.regenerate',
  RECIPE_IMPORT: 'life.recipe.import',
  RECIPE_IMPORTED: 'life.recipe.imported',

  // Activity
  ACTIVITY_GENERATED: 'life.activity.generated',
  ACTIVITY_RATED: 'life.activity.rated',
  ACTIVITY_COMPLETED: 'life.activity.completed',
  ACTIVITY_FEEDBACK: 'life.activity.feedback',
  ACTIVITY_REGENERATE: 'life.activity.regenerate',
  ACTIVITY_RESCHEDULED: 'life.activity.rescheduled',

  // Fi (pet tracking)
  FI_LOCATION: 'life.fi.location',
  FI_ACTIVITY: 'life.fi.activity',
  FI_DEVICE: 'life.fi.device',
  FI_SLEEP: 'life.fi.sleep',
  FI_DAILY_SUMMARY: 'life.fi.daily_summary',
  PET_OBSERVATION_DISMISSED: 'life.pet.observation.dismissed',
  PET_OBSERVATION_SNOOZED: 'life.pet.observation.snoozed',

  // Football
  FOOTBALL_REMINDER: 'life.football.reminder',
  FOOTBALL_RESULT: 'life.football.result',

  // News
  NEWS_DIGEST: 'life.news.digest',
  NEWS_FEEDBACK: 'life.news.feedback',

  // Gym
  GYM_GENERATED: 'life.gym.generated',
  GYM_RATED: 'life.gym.rated',
  GYM_COMPLETED: 'life.gym.completed',
  GYM_REJECTED: 'life.gym.rejected',
  GYM_FEEDBACK: 'life.gym.feedback',
  GYM_BOOKMARK: 'life.gym.bookmark',
  GYM_REGENERATE: 'life.gym.regenerate',

  // RS3 (RuneScape 3)
  RS3_DAILY_SUMMARY: 'life.rs3.daily_summary',
  RS3_ACTIVITY_CLASSIFIED: 'life.rs3.activity_classified',
  RS3_ACTIVITY_FEEDBACK: 'life.rs3.activity.feedback',

  // Blog (agent-blog + broadcast-paragraph)
  BLOG_PUBLISH_REQUEST: 'life.blog.publish_request',
  BLOG_PUBLISHED: 'life.blog.published',
  BLOG_PUBLISH_FAILED: 'life.blog.publish_failed',
  BLOG_GENERATED: 'life.blog.generated',
  /** service-notion → agent-blog: page in LifeOS/Blog DB transitioned to status=Ready (LOS-263). */
  BLOG_NOTES_READY: 'life.blog.notes_ready',
  /** agent-blog → service-notion: page successfully published to Paragraph; flip Notion status + append URL (LOS-263). */
  BLOG_PUBLISHED_NOTION: 'life.blog.published_notion',
  /** api-gateway → agent-blog: user approved a pending-review draft; agent-blog re-emits BLOG_PUBLISH_REQUEST + tombstones the draft display row (LOS-265). */
  BLOG_DRAFT_APPROVE_REQUEST: 'life.blog.draft.approve_request',
  /** api-gateway → agent-blog: user rejected a draft; agent flips status='rejected' + tombstones the draft display row (LOS-265). */
  BLOG_DRAFT_REJECT_REQUEST: 'life.blog.draft.reject_request',
  /** api-gateway → agent-blog: user edited + published a draft; agent records edit_magnitude in blog_post_edits + emits BLOG_PUBLISH_REQUEST with edited markdown (LOS-265). */
  BLOG_DRAFT_EDIT_PUBLISH_REQUEST: 'life.blog.draft.edit_publish_request',
  /** broadcast-paragraph → agent-blog: nightly Paragraph stats snapshot (post views + subscriber count). Phase 1 stub — handler is a no-op until Phase 2 wires ingestion (LOS-283). */
  BLOG_STATS_REFRESHED: 'life.blog.stats.refreshed',
  // Regenerate on-demand (PWA → agent-blog via gateway)
  CONTENT_REGENERATE_REQUEST_BLOG: 'life.content.regenerate.request.blog',

  // Flashcastr (Space Invader domain expert)
  FLASHCASTR_CONTENT_REQUEST: 'life.flashcastr.content_request',
  FLASHCASTR_CONTENT_RESPONSE: 'life.flashcastr.content_response',
  FLASHCASTR_CONTENT_ACCEPTED: 'life.flashcastr.content_accepted',
  FLASHCASTR_ROUNDUP_REQUEST: 'life.flashcastr.roundup_request',
  FLASHCASTR_ROUNDUP_RESPONSE: 'life.flashcastr.roundup_response',
  FLASHCASTR_HIGHLIGHT_REQUEST: 'life.flashcastr.highlight_request',
  FLASHCASTR_HIGHLIGHT_RESPONSE: 'life.flashcastr.highlight_response',
  ADMIN_TRIGGER_FLASHCASTR: 'life.admin.trigger_flashcastr',

  // Farcaster
  FARCASTER_PLAN_GENERATED: 'life.farcaster.plan_generated',
  FARCASTER_PLAN_APPROVED: 'life.farcaster.plan_approved',
  FARCASTER_PLAN_REJECTED: 'life.farcaster.plan_rejected',
  FARCASTER_CONVERSATION_REPLY: 'life.farcaster.conversation_reply',
  CAST_GENERATION_REQUEST: 'life.farcaster.cast_generation_request',
  /** Emitted by agent-farcaster N hours after publishing a flashcastr-sourced cast. Feeds flashcastr learning loop. */
  FARCASTER_CAST_ENGAGEMENT: 'life.farcaster.cast_engagement',

  // Farcaster account lookup (broadcast-cast owns credentials)
  FARCASTER_ACCOUNT_REQUEST: 'life.farcaster.account_request',
  FARCASTER_ACCOUNT_RESPONSE: 'life.farcaster.account_response',

  // Cast (generic publisher)
  CAST_REQUEST: 'life.cast.request',
  CAST_PUBLISHED: 'life.cast.published',
  CAST_FAILED: 'life.cast.failed',

  // Finance
  FINANCE_STATEMENT_UPLOADED: 'life.finance.statement.uploaded',
  FINANCE_ANALYSIS_READY: 'life.finance.analysis.ready',
  FINANCE_TX_RECATEGORISED: 'life.finance.tx.recategorised',
  FINANCE_ENTITY_UPDATED: 'life.finance.entity.updated',
  FINANCE_KNOWLEDGE_UPLOADED: 'life.finance.knowledge.uploaded',
  FINANCE_KNOWLEDGE_PROCESSED: 'life.finance.knowledge.processed',
  FINANCE_KNOWLEDGE_DELETE_REQUESTED: 'life.finance.knowledge.delete_requested',
  FINANCE_RECEIPT_UPLOADED: 'life.finance.receipt.uploaded',
  FINANCE_RECEIPT_PROCESSED: 'life.finance.receipt.processed',
  /** Cross-agent: aggregate-only budget summary. Consumers read OV; never request entity/tx detail. */
  FINANCE_BUDGET_SUMMARY_UPDATED: 'life.finance.budget_summary.updated',
  /** PWA/gateway → agent-finance. Triggers pipeline 2 (AI annual report). Manual only. */
  FINANCE_REGENERATE_REPORT: 'life.finance.regenerate_report',
  /** agent-finance → subscribers. Annual report generated and persisted. */
  FINANCE_REPORT_READY: 'life.finance.report_ready',
  /** agent-finance → display-sync. Monthly summary recomputed (deterministic, no AI). */
  FINANCE_MONTHLY_SUMMARY_UPDATED: 'life.finance.monthly_summary_updated',
  /** api-gateway → agent-finance. Admin wipe of statement-derived tables (not categories/entities/DDs). */
  FINANCE_RESET_REQUEST: 'life.finance.reset.request',
  /** api-gateway → agent-finance. Admin trigger: re-run analysis for every month with transactions. */
  FINANCE_REANALYSE_ALL_REQUEST: 'life.finance.reanalyse.all.request',
  /** agent-finance → api-gateway. Counts of rows deleted by the reset. */
  FINANCE_RESET_RESPONSE: 'life.finance.reset.response',
  // Finance bulk import (LOS-509)
  /** api-gateway → agent-finance. Process one file in a bulk import batch. */
  FINANCE_IMPORT_FILE_REQUEST: 'life.finance.import.file.request',
  /** api-gateway → agent-finance. Batch row created; agents can track progress. */
  FINANCE_IMPORT_BATCH_CREATED: 'life.finance.import.batch.created',
  /** agent-finance → subscribers. Fired once all files in a batch are processed. */
  FINANCE_IMPORT_BATCH_COMPLETED: 'life.finance.import.batch.completed',
  /** agent-finance → display-sync. Bank coverage months updated after a batch. */
  FINANCE_BANK_COVERAGE_UPDATED: 'life.finance.bank.coverage.updated',

  // Job Search
  JOB_DIGEST: 'life.job.digest',
  JOB_FEEDBACK: 'life.job.feedback',
  JOB_TRIGGER: 'life.job.trigger',
  // Orchestrator (daily planning)
  ORCHESTRATOR_PLAN_REQUEST: 'life.orchestrator.plan_request',
  ORCHESTRATOR_PLAN_ASSEMBLED: 'life.orchestrator.plan_assembled',

  // Plan contributions (per-domain responses to plan request)
  RECIPE_PLAN_CONTRIBUTION: 'life.recipe.plan_contribution',
  GYM_PLAN_CONTRIBUTION: 'life.gym.plan_contribution',
  ACTIVITY_PLAN_CONTRIBUTION: 'life.activity.plan_contribution',
  RS3_PLAN_CONTRIBUTION: 'life.rs3.plan_contribution',
  JOB_PLAN_CONTRIBUTION: 'life.job.plan_contribution',
  WEATHER_PLAN_CONTRIBUTION: 'life.weather.plan_contribution',
  FOOTBALL_PLAN_CONTRIBUTION: 'life.football.plan_contribution',
  CALENDAR_PLAN_CONTRIBUTION: 'life.calendar.plan_contribution',
  FI_PLAN_CONTRIBUTION: 'life.fi.plan_contribution',

  // Plan revision (orchestrator → agent, conversational retry)
  PLAN_REVISION_REQUEST: 'life.orchestrator.plan_revision_request',
  PLAN_REVISION_FEEDBACK: 'life.orchestrator.plan_revision_feedback',

  // Notion sync
  NOTION_TASK_COMPLETION: 'life.notion.task_completion',
  NOTION_GOALS_UPDATED: 'life.notion.goals_updated',
  /** Emitted by service-notion when the user's Profile page content changes (hash-gated). */
  NOTION_PROFILE_CHANGED: 'life.notion.profile.changed',
  /** Emitted by service-notion when the dedicated Finances page content changes (hash-gated). */
  NOTION_FINANCE_PAGE_CHANGED: 'life.notion.finance.changed',

  // Notifications
  NOTIFICATION_CREATED_FRONTEND: 'life.notification.created.frontend',
  /** Legacy: was emitted by the retired service-notifications per successful web-push delivery. */
  NOTIFICATION_ROUTED: 'life.notification.routed',

  // Push subscriptions
  PUSH_SUBSCRIBE: 'life.push.subscribe',

  // Meeting Prep
  CALENDAR_PREP_TRIGGER: 'life.calendar.prep_trigger',
  RESEARCH_PREP_READY: 'life.research.prep_ready',

  // Git (service-git)
  GIT_ACTIVITY_SYNCED: 'life.git.activity_synced',
  GIT_FETCH_REQUEST: 'life.git.fetch_request',
  GIT_CONTEXT_REQUEST: 'life.git.context_request',
  GIT_CONTEXT_RESPONSE: 'life.git.context_response',

  // Agent tick trigger (gateway → specific agent)
  AGENT_TICK_TRIGGER: 'life.agent.tick.trigger',

  // Agent health + meta (base.ts broadcasts, LOS-258 Stream C)
  // Routing keys use per-agent suffix: life.agent.heartbeat.<agent>
  // Subscribe via patterns: life.agent.heartbeat.*, life.agent.meta.updated.*, life.agent.error.*

  // Content-ready (agents → display-sync)
  CONTENT_READY_RECIPE: 'life.content.ready.recipe',
  CONTENT_READY_RECIPE_PROFILE: 'life.content.ready.recipe_profile',
  CONTENT_READY_WORKOUT: 'life.content.ready.workout',
  CONTENT_READY_ACTIVITY: 'life.content.ready.activity',
  CONTENT_READY_ACTIVITY_PROFILE: 'life.content.ready.activity_profile',
  CONTENT_READY_WEATHER: 'life.content.ready.weather',
  CONTENT_READY_RS3: 'life.content.ready.rs3',
  CONTENT_READY_RS3_ACTIVITY: 'life.content.ready.rs3_activity',
  CONTENT_READY_RS3_PATTERN: 'life.content.ready.rs3_pattern',
  CONTENT_READY_RS3_PROGRESSION: 'life.content.ready.rs3_progression',
  CONTENT_READY_EMAIL: 'life.content.ready.email',
  CONTENT_READY_EMAIL_STATS: 'life.content.ready.email_stats',
  CONTENT_READY_NEWS: 'life.content.ready.news',
  CONTENT_READY_NEWS_INTERESTS: 'life.content.ready.news_interests',
  CONTENT_READY_FARCASTER: 'life.content.ready.farcaster',
  CONTENT_READY_FARCASTER_ACCOUNT: 'life.content.ready.farcaster_account',
  CONTENT_READY_FARCASTER_CONVERSATION: 'life.content.ready.farcaster_conversation',
  CONTENT_READY_FARCASTER_SIGNAL_TRENDS: 'life.content.ready.farcaster_signal_trends',
  CONTENT_READY_FARCASTER_CAST_HISTORY: 'life.content.ready.farcaster_cast_history',
  CONTENT_READY_FLASHCASTR: 'life.content.ready.flashcastr',
  CONTENT_READY_PET: 'life.content.ready.pet',
  CONTENT_READY_GIT: 'life.content.ready.git',
  CONTENT_READY_JOB: 'life.content.ready.job',
  CONTENT_READY_BLOG: 'life.content.ready.blog',
  CONTENT_READY_BLOG_SCHEDULE: 'life.content.ready.blog_schedule',
  /** agent-blog → display-sync: pending-review draft (Mode A failed-gate). Tombstone on approve/reject/edit-publish (LOS-265). */
  CONTENT_READY_BLOG_DRAFT: 'life.content.ready.blog_draft',
  CONTENT_READY_CALENDAR: 'life.content.ready.calendar',
  CONTENT_READY_NOTIFICATION: 'life.content.ready.notification',
  CONTENT_READY_PLAN: 'life.content.ready.plan',
  CONTENT_READY_FOOTBALL: 'life.content.ready.football',
  CONTENT_READY_FOOTBALL_TABLE: 'life.content.ready.football_table',
  CONTENT_READY_FOOTBALL_NEXT_MATCH: 'life.content.ready.football_next_match',
  CONTENT_READY_FOOTBALL_FOLLOWING: 'life.content.ready.football_following',
  CONTENT_READY_NEWS_ARTICLE: 'life.content.ready.news_article',
  CONTENT_READY_RS3_GOALS: 'life.content.ready.rs3_goals',
  CONTENT_READY_CALENDAR_PREP: 'life.content.ready.calendar_prep',
  CONTENT_READY_DIRECTOR_CHAT: 'life.content.ready.director_chat',
  CONTENT_READY_AGENT_DIRECTORY: 'life.content.ready.agent_directory',
  CONTENT_READY_AGENT_HEALTH: 'life.content.ready.agent_health',
  CONTENT_READY_GYM_PROFILE: 'life.content.ready.gym_profile',
  CONTENT_READY_AI_USAGE: 'life.content.ready.ai_usage',
  CONTENT_READY_EVENT_TAPE: 'life.content.ready.event_tape',
  CONTENT_READY_AGENT_SKILLS: 'life.content.ready.agent_skills',
  CONTENT_READY_FINANCE: 'life.content.ready.finance',
  CONTENT_READY_FINANCE_ENTITIES: 'life.content.ready.finance_entities',
  CONTENT_READY_FINANCE_CATEGORIES: 'life.content.ready.finance_categories',
  CONTENT_READY_FINANCE_KNOWLEDGE: 'life.content.ready.finance_knowledge',
  CONTENT_READY_FINANCE_RECEIPTS: 'life.content.ready.finance_receipts',
  CONTENT_READY_FINANCE_TRANSACTIONS: 'life.content.ready.finance_transactions',

  // Finance category lifecycle
  FINANCE_CATEGORY_UPSERTED: 'life.finance.category.upserted',
  FINANCE_CATEGORY_DEACTIVATED: 'life.finance.category.deactivated',

  // Detail requests (api-gateway → agent, for on-demand full detail)
  DETAIL_REQUEST: 'life.detail.request',
  DETAIL_RESPONSE: 'life.detail.response',

  // Config (settings changed signal — agents re-read from OV)
  CONFIG_UPDATED: 'life.config.updated',

  // Task completion request (agent → service-notion)
  COMPLETION_REQUEST: 'life.completion.request',
  COMPLETION_RESPONSE: 'life.completion.response',

  // Notion page fetch (director → service-notion, lightweight content read)
  NOTION_PAGE_FETCH_REQUEST: 'life.notion.page_fetch_request',
  NOTION_PAGE_FETCH_RESPONSE: 'life.notion.page_fetch_response',

  // Notion profile fetch (director → service-notion, full Profile/** tree)
  NOTION_PROFILE_FETCH_REQUEST: 'life.notion.profile_fetch_request',
  NOTION_PROFILE_FETCH_RESPONSE: 'life.notion.profile_fetch_response',

  // Director
  DIRECTOR_SYNTHESIS: 'life.director.synthesis',
  PLAN_OUTCOME: 'life.director.plan_outcome',

  // Director chat
  DIRECTOR_CHAT_USER: 'life.director.chat_user',
  DIRECTOR_CHAT_RESPONSE: 'life.director.chat_response',
  DIRECTOR_ACTION_REQUEST: 'life.director.action_request',
  DIRECTOR_ACTION_RESULT: 'life.director.action_result',

  // Admin triggers
  ADMIN_TRIGGER_REFINEMENT: 'life.admin.trigger_refinement',
  ADMIN_TRIGGER_NOTION_SYNC: 'life.admin.trigger_notion_sync',
  ADMIN_TRIGGER_MEETING_PREP: 'life.admin.trigger_meeting_prep',
  ADMIN_TRIGGER_EVENT_PREP: 'life.admin.trigger_event_prep',
  ADMIN_TRIGGER_BLOG: 'life.admin.trigger_blog',
  ADMIN_TRIGGER_CONSOLIDATION: 'life.admin.trigger_consolidation',
  ADMIN_TRIGGER_PLAN_ASSEMBLY: 'life.admin.trigger_plan_assembly',
  ADMIN_TRIGGER_TEST_NOTIFICATION: 'life.admin.trigger_test_notification',
  ADMIN_TRIGGER_CAST_PLAN: 'life.admin.trigger_cast_plan',

  // Reconcile — admin-triggered display cache republish
  RECONCILE_REQUEST: 'life.admin.reconcile.request',
  RECONCILE_PROGRESS: 'life.admin.reconcile.progress',
  RECONCILE_COMPLETE: 'life.admin.reconcile.complete',

  // Context service (OV proxy)
  OV_WRITE: 'life.context.ov_write',

  // Linear service (service-linear)
  LINEAR_TICKET_CREATE_REQUEST: 'life.linear.ticket.create.request',
  LINEAR_TICKET_CREATED: 'life.linear.ticket.created',
  LINEAR_TICKET_STATUS_REQUEST: 'life.linear.ticket.status.request',
  LINEAR_TICKET_STATUS_RESPONSE: 'life.linear.ticket.status.response',
  LINEAR_TICKET_DETAIL_REQUEST: 'life.linear.ticket.detail.request',
  LINEAR_TICKET_DETAIL_RESPONSE: 'life.linear.ticket.detail.response',
  /** List tickets matching a filter (LOS-266 — agent-blog Mode B uses this to
   *  enumerate Done tickets in the last 24h). Caller correlates via `requestId`. */
  LINEAR_TICKETS_LIST_REQUEST: 'life.linear.tickets.list_request',
  LINEAR_TICKETS_LIST_RESPONSE: 'life.linear.tickets.list_response',
  // Self-heal alias: caller pre-supplies priority 1 + labels; same create handler
  BUG_TICKET_CREATE: 'life.linear.bug.ticket.create',
  BUG_TICKET_CREATED: 'life.linear.bug.ticket.created',
} as const;

export const EXCHANGE_NAME = 'life.events';

export const SUBSCRIBE_PATTERNS = {
  ALL_EMAIL: 'life.email.*',
  ALL_CALENDAR: 'life.calendar.*',
  ALL_WEATHER: 'life.weather.*',
  ALL_RECIPE: 'life.recipe.*',
  ALL_ACTIVITY: 'life.activity.*',
  ALL_FI: 'life.fi.*',
  ALL_FOOTBALL: 'life.football.*',
  ALL_NEWS: 'life.news.*',
  ALL_GYM: 'life.gym.*',
  ALL_RS3: 'life.rs3.*',
  ALL_BLOG: 'life.blog.*',
  ALL_FARCASTER: 'life.farcaster.*',
  ALL_CAST: 'life.cast.*',
  ALL_JOB: 'life.job.*',
  ALL_ORCHESTRATOR: 'life.orchestrator.*',
  ALL_PLAN_CONTRIBUTIONS: 'life.*.plan_contribution',
  ALL_NOTION: 'life.notion.*',
  ALL_RESEARCH: 'life.research.*',
  ALL_GIT: 'life.git.*',
  ALL_FINANCE: 'life.finance.*',
  ALL_NOTIFICATIONS: 'life.notification.created.*',
  ALL_CONTENT_READY: 'life.content.ready.*',
  ALL_AGENT_HEARTBEAT: 'life.agent.heartbeat.*',
  ALL_AGENT_META: 'life.agent.meta.updated.*',
  ALL_AGENT_ERROR: 'life.agent.error.*',
} as const;
