import { createMetricsRegistry, startMetricsServer, Counter, Gauge, Histogram } from "@flashcastr/metrics";
import type { Registry } from "@flashcastr/metrics";

export const registry: Registry = createMetricsRegistry("api");

// ============================================
// COUNTERS
// ============================================

export const graphqlRequestsTotal = new Counter({
  name: "flashcastr_api_graphql_requests_total",
  help: "Total GraphQL requests",
  labelNames: ["operation_type", "operation_name"],
  registers: [registry],
});

export const graphqlErrorsTotal = new Counter({
  name: "flashcastr_api_graphql_errors_total",
  help: "Total GraphQL errors",
  labelNames: ["operation_type", "operation_name"],
  registers: [registry],
});

export const signupsInitiatedTotal = new Counter({
  name: "flashcastr_api_signups_initiated_total",
  help: "Total user signups initiated",
  registers: [registry],
});

export const signupsCompletedTotal = new Counter({
  name: "flashcastr_api_signups_completed_total",
  help: "Total user signups completed successfully",
  registers: [registry],
});

export const usersDeletedTotal = new Counter({
  name: "flashcastr_api_users_deleted_total",
  help: "Total users deleted",
  registers: [registry],
});

export const cacheHitsTotal = new Counter({
  name: "flashcastr_api_cache_hits_total",
  help: "Cache hits",
  labelNames: ["cache_name"],
  registers: [registry],
});

export const cacheMissesTotal = new Counter({
  name: "flashcastr_api_cache_misses_total",
  help: "Cache misses",
  labelNames: ["cache_name"],
  registers: [registry],
});

export const neynarRequestsTotal = new Counter({
  name: "flashcastr_api_neynar_requests_total",
  help: "Requests to Neynar API",
  labelNames: ["endpoint", "status"],
  registers: [registry],
});

export const databaseQueriesTotal = new Counter({
  name: "flashcastr_api_database_queries_total",
  help: "Total database queries executed",
  labelNames: ["query_type"],
  registers: [registry],
});

// ============================================
// GAUGES
// ============================================

export const activeUsersTotal = new Gauge({
  name: "flashcastr_api_active_users_total",
  help: "Total active (non-deleted) users",
  registers: [registry],
});

export const totalFlashesCount = new Gauge({
  name: "flashcastr_api_total_flashes",
  help: "Total flashes in database",
  registers: [registry],
});

// ============================================
// HISTOGRAMS
// ============================================

export const graphqlDurationSeconds = new Histogram({
  name: "flashcastr_api_graphql_duration_seconds",
  help: "Duration of GraphQL operations in seconds",
  labelNames: ["operation_type", "operation_name"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const databaseQueryDurationSeconds = new Histogram({
  name: "flashcastr_api_database_query_duration_seconds",
  help: "Duration of database queries in seconds",
  labelNames: ["query_type"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export { startMetricsServer };
