/**
 * Shared prompt builder for consistent AI prompt construction across agents.
 *
 * Standard section ordering:
 *   Role → Domain Knowledge → User Profile → Constraints →
 *   Learned Patterns → World Context → Instructions → Response Format
 */

export interface PromptSection {
  heading: string;
  content: string;
}

export interface AgentPromptConfig {
  /** Agent role description from OV */
  role?: string;
  /** Domain-specific knowledge from OV */
  domain?: string;
  /** User profile (name, occupation, location, etc.) */
  userProfile?: string;
  /** User constraints (injuries, schedule limits, etc.) */
  constraints?: string;
  /** Learned patterns from nightly refinement */
  learnedPatterns?: string;
  /** Dynamic world context (weather, calendar, etc.) */
  worldContext?: string;
  /** Task-specific instructions */
  instructions: string;
  /** JSON response format example. Wrapped in the standard preamble. */
  responseFormat: string;
  /** Extra sections inserted before Instructions (e.g., per-agent context) */
  extraSections?: PromptSection[];
}

/** Standard preamble for JSON response format instructions. */
const JSON_FORMAT_PREAMBLE = 'Respond with ONLY valid JSON, no markdown:';

/**
 * Build a structured agent prompt with consistent section ordering.
 * Empty sections are omitted. Returns the full prompt string.
 */
export function buildAgentPrompt(config: AgentPromptConfig): string {
  const staticPart = buildStaticSystemPrompt(config);
  const dynamicPart = buildDynamicUserMessage(config);
  return [staticPart, dynamicPart].filter(Boolean).join('\n\n');
}

/** The standard JSON response format preamble. Use for inline prompts that don't use buildAgentPrompt. */
export const RESPONSE_FORMAT_PREAMBLE = JSON_FORMAT_PREAMBLE;

/**
 * Returns only the cacheable static sections: role → domain → userProfile → constraints → learnedPatterns.
 * Pass as the `system` field with `cacheSystem: true`.
 * Empty/undefined fields are omitted.
 */
export function buildStaticSystemPrompt(
  config: Pick<AgentPromptConfig, 'role' | 'domain' | 'userProfile' | 'constraints' | 'learnedPatterns'>,
): string {
  const sections: string[] = [];

  if (config.role) {
    sections.push(`## Agent Role\n${config.role}`);
  }
  if (config.domain) {
    sections.push(`## Domain Knowledge\n${config.domain}`);
  }
  if (config.userProfile) {
    sections.push(`## User Profile\n${config.userProfile}`);
  }
  if (config.constraints) {
    sections.push(`## User Constraints\n${config.constraints}`);
  }
  if (config.learnedPatterns) {
    sections.push(`## Learned Patterns\n${config.learnedPatterns}`);
  }

  return sections.join('\n\n');
}

/**
 * Returns only the dynamic sections: worldContext → extraSections → instructions → responseFormat.
 * Pass as the content of the user message.
 * Empty/undefined fields are omitted (except instructions and responseFormat which are required).
 */
export function buildDynamicUserMessage(
  config: Pick<AgentPromptConfig, 'worldContext' | 'extraSections' | 'instructions' | 'responseFormat'>,
): string {
  const sections: string[] = [];

  if (config.worldContext) {
    sections.push(`## World Context\n${config.worldContext}`);
  }

  if (config.extraSections) {
    for (const s of config.extraSections) {
      if (s.content) {
        sections.push(`## ${s.heading}\n${s.content}`);
      }
    }
  }

  if (config.instructions) {
    sections.push(`## Instructions\n${config.instructions}`);
  }

  sections.push(`## Response Format\n${JSON_FORMAT_PREAMBLE}\n${config.responseFormat}`);

  return sections.join('\n\n');
}
