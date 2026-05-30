/**
 * Builds deep knowledge about the Space Invader artist and community
 * by searching the web and synthesizing into OV observation files.
 *
 * Uses Claude web_search + web_fetch tools (same pattern as agent-devblog's
 * invader-roundup.ts). Runs weekly during refinement, not every tick.
 */

import type { AIClient } from '@life-os/shared';
import { writeAgentObservation } from '@life-os/shared';

const AGENT_NAME = 'flashcastr';

/**
 * Research the artist's background, techniques, and philosophy.
 * Sources: Wikipedia, New Yorker profile, art publications.
 */
async function buildArtistContext(ai: AIClient): Promise<string> {
  console.log('[flashcastr] Knowledge: researching artist context...');

  const searchResult = await ai.complete({
    task: 'search',
    taskName: 'knowledge_artist_search',
    maxTokens: 2048,
    tools: [{
      type: 'web_search_20260209' as const,
      name: 'web_search',
      max_uses: 5,
      allowed_callers: ['direct'],
    }],
    system: `You are researching the street artist Invader (Space Invader / Franck Slama).
Search for authoritative sources covering:
1. The artist's mission and philosophy (pixel art reclaiming public space)
2. The point system (how invaders are scored, what makes a high-value piece)
3. Techniques and materials (ceramic tiles, mosaic, generations of style)
4. Notable campaigns by city (Paris waves, NYC, Hong Kong, Tokyo, etc.)
5. Legal context (arrests, removals, the tension with authorities)

Output ONLY a numbered list of the most relevant URLs:
URL: [url]
TITLE: [title]
RELEVANCE: [why this is useful]`,
    messages: [{
      role: 'user',
      content: 'Find authoritative sources about the street artist Invader — biography, techniques, point system, notable campaigns, legal issues.',
    }],
  });

  const fetchResult = await ai.complete({
    task: 'extract',
    taskName: 'knowledge_artist_fetch',
    maxTokens: 4096,
    tools: [{
      type: 'web_fetch_20260309' as const,
      name: 'web_fetch',
      max_uses: 3,
      allowed_callers: ['direct'],
    }],
    system: `Extract key facts about the street artist Invader from the provided sources.
Organize into these categories:
- MISSION: philosophy, motivation, what "invasion" means
- POINT SYSTEM: how invaders are scored (10-50 points), what determines value
- TECHNIQUES: materials (ceramic tiles, mosaic), style evolution, installation methods
- CITY CAMPAIGNS: notable cities, number of invaders per city, famous waves
- LEGAL: arrests, removals, controversies, the street art vs vandalism tension
- MILESTONES: total count, countries, notable exhibitions

Output structured notes only. No prose.`,
    messages: [{
      role: 'user',
      content: `Read these sources and extract facts about Invader:\n\n${searchResult.text}`,
    }],
  });

  const result = await ai.complete({
    task: 'summarize',
    taskName: 'knowledge_artist_synthesize',
    maxTokens: 2048,
    system: `Synthesize research notes into a concise knowledge document about the street artist Invader.
This document will be used by a Farcaster content agent to write informed posts about Space Invader art.

Format as markdown with clear sections. Include specific numbers, dates, and facts.
Focus on information that makes content more interesting and contextual — not just dry facts,
but the stories and significance behind them.

Max 1500 words.`,
    messages: [{
      role: 'user',
      content: `Synthesize these research notes into a knowledge document:\n\n${fetchResult.text}`,
    }],
  });

  return result.text;
}

/**
 * Research the community culture around Space Invader art.
 * Sources: community blogs, FlashInvaders app info, fan articles.
 */
async function buildCommunityCulture(ai: AIClient): Promise<string> {
  console.log('[flashcastr] Knowledge: researching community culture...');

  const searchResult = await ai.complete({
    task: 'search',
    taskName: 'knowledge_community_search',
    maxTokens: 2048,
    tools: [{
      type: 'web_search_20260209' as const,
      name: 'web_search',
      max_uses: 5,
      allowed_callers: ['direct'],
    }],
    system: `You are researching the community around Space Invader street art.
Search for sources covering:
1. What "flashing" means (photographing + logging invaders via the FlashInvaders app)
2. The FlashInvaders mobile app — how it works, point scoring, city completion
3. Community maps and tracking projects (invader-spotter.art, community databases)
4. Notable "flashers" and their contributions
5. The competitive/collectible aspect — leaderboards, city races, rare finds
6. Stories of people discovering invaders while traveling

Output ONLY a numbered list of relevant URLs.`,
    messages: [{
      role: 'user',
      content: 'Find sources about the Space Invader community — FlashInvaders app, flashing culture, community tracking, collector behavior.',
    }],
  });

  const fetchResult = await ai.complete({
    task: 'extract',
    taskName: 'knowledge_community_fetch',
    maxTokens: 4096,
    tools: [{
      type: 'web_fetch_20260309' as const,
      name: 'web_fetch',
      max_uses: 3,
      allowed_callers: ['direct'],
    }],
    system: `Extract facts about the Space Invader community from the provided sources.
Organize into:
- FLASHING: what it means, how people do it, the culture
- APP: FlashInvaders app mechanics, scoring, features
- COMMUNITY PROJECTS: maps, databases, tracking tools
- COLLECTOR CULTURE: competition, leaderboards, city completion, rare finds
- STORIES: interesting personal accounts of finding invaders

Output structured notes only.`,
    messages: [{
      role: 'user',
      content: `Read these sources and extract community culture facts:\n\n${searchResult.text}`,
    }],
  });

  const result = await ai.complete({
    task: 'summarize',
    taskName: 'knowledge_community_synthesize',
    maxTokens: 1500,
    system: `Synthesize research notes into a concise knowledge document about the Space Invader community.
This will be used by a content agent to write posts that resonate with the community.

Focus on the human side — why people flash, what makes finding an invader exciting,
the culture of sharing discoveries. This context helps the agent write posts that feel
like they come from someone who genuinely understands the community.

Format as markdown. Max 1000 words.`,
    messages: [{
      role: 'user',
      content: `Synthesize into a community culture knowledge document:\n\n${fetchResult.text}`,
    }],
  });

  return result.text;
}

/**
 * Build a global map summary from existing scraped invader-spotter data.
 * No web search needed — this aggregates from the DB.
 */
async function buildGlobalMapSummary(ai: AIClient, cityStats: string): Promise<string> {
  console.log('[flashcastr] Knowledge: building global map summary...');

  const result = await ai.complete({
    task: 'summarize',
    taskName: 'knowledge_global_map',
    maxTokens: 1500,
    system: `Summarize invader activity data into a global map overview.
This is a reference document showing which cities have the most activity.

Format as markdown with:
- Top cities ranked by total events
- Cities with most destructions (concerning trends)
- Cities with most new additions (active campaigns)
- Cities with reactivations (comeback stories)

Be concise — this is a reference snapshot, not analysis. Max 800 words.`,
    messages: [{
      role: 'user',
      content: `Here are the aggregated city statistics from invader-spotter.art:\n\n${cityStats}`,
    }],
  });

  return result.text;
}

/**
 * Run the full knowledge seeding pipeline.
 * Writes 3 observation files to OV:
 * - artist-context.md
 * - community-culture.md
 * - global-map.md
 */
export async function seedKnowledgeBase(
  db: any,
  ai: AIClient,
  cityStats: string,
): Promise<void> {
  console.log('[flashcastr] Starting knowledge base seed...');

  const [artistContext, communityCulture, globalMap] = await Promise.all([
    buildArtistContext(ai),
    buildCommunityCulture(ai),
    buildGlobalMapSummary(ai, cityStats),
  ]);

  await Promise.all([
    writeAgentObservation(db, AGENT_NAME, 'artist-context.md', artistContext),
    writeAgentObservation(db, AGENT_NAME, 'community-culture.md', communityCulture),
    writeAgentObservation(db, AGENT_NAME, 'global-map.md', globalMap),
  ]);

  console.log('[flashcastr] Knowledge base seed complete — 3 observation files written');
}
