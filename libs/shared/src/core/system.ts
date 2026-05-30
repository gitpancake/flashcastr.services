/**
 * Static platform constants.
 *
 * `AGENT_COUNT` is currently a hand-maintained count of agents + services
 * reporting heartbeats on `life.events`. Exposed via GraphQL `systemStatus`.
 * Will eventually be replaced by a live registry (see Linear: derive live
 * agent count from registry or api-gateway message tally).
 */
export const AGENT_COUNT = 21;
