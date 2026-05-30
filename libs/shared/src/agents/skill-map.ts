/**
 * Static per-agent skill tags surfaced on the PWA `/agents` expanded card.
 * service-git overrides itself at runtime via CONTENT_READY_AGENT_SKILLS
 * (derived from `git_skill_profile`); other agents read from here.
 *
 * Keep entries short — 2–5 tags each. Maps to agent names used elsewhere
 * (the PWA's AGENTS roster and display-sync `displayAgentDirectory.name`).
 */
export const STATIC_AGENT_SKILLS: Record<string, string[]> = {
  farcaster: ['social', 'casts', 'channels', 'engagement'],
  recipe: ['meal-planning', 'nutrition', 'imports'],
  gym: ['workouts', 'coaching', 'knee-safe'],
  research: ['web-search', 'briefing', 'prep-docs'],
  blog: ['dev-diary', 'writing', 'paragraph'],
  pet: ['fi-tracking', 'activity', 'location'],
  activity: ['outdoors', 'suggestions', 'weather-aware'],
  flashcastr: ['space-invaders', 'roundup', 'knowledge'],
  news: ['digest', 'filtering', 'topics'],
  calendar: ['events', 'prep-trigger', 'upcoming'],
  weather: ['forecast', 'alerts', 'vancouver'],
  email: ['classification', 'triage', 'gmail'],
  rs3: ['xp-tracking', 'patterns', 'progression'],
  football: ['fixtures', 'league-table', 'followed'],
  job: ['search', 'filtering', 'relevance'],
  git: ['commits', 'repos', 'skill-profile'],
};

/** Lookup helper — returns static skills, or `[]` when the agent is unknown. */
export function staticSkillsFor(agent: string): string[] {
  return STATIC_AGENT_SKILLS[agent] ?? [];
}
