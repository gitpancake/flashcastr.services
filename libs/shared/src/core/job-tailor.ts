import type { AIClient } from './ai-client.js';

export interface TailoredCvResult {
  bulletPoints: string[];
  skillsToEmphasize: string[];
  summaryLine: string | null;
}

/**
 * Generate tailored CV bullet points for a specific job listing.
 * Uses Claude Sonnet for quality since this directly impacts applications.
 */
export async function tailorCvForJob(
  ai: AIClient,
  jobDescription: string,
  jobTitle: string,
  company: string,
  cvContent: string,
  userSkills: string[],
): Promise<TailoredCvResult> {
  try {
    const parsed = await ai.completeJson<TailoredCvResult>({
      task: 'generate',
      taskName: 'tailor_cv',
      maxTokens: 1024,
      messages: [{
        role: 'user',
        content: `I'm applying for "${jobTitle}" at ${company}. Tailor my CV for this role.

Job Description:
${jobDescription.slice(0, 2000)}

My Current CV:
${cvContent.slice(0, 3000)}

My Key Skills: ${userSkills.join(', ')}

Generate:
1. 3-5 tailored bullet points for my experience section that highlight relevant achievements and skills for THIS specific role
2. Which of my skills to emphasize (order matters — most relevant first)
3. A one-sentence professional summary/objective line tailored to this role

Respond with ONLY valid JSON, no markdown:
{"bulletPoints": ["..."], "skillsToEmphasize": ["..."], "summaryLine": "..."}`,
      }],
    });
    return {
      bulletPoints: parsed.bulletPoints ?? [],
      skillsToEmphasize: parsed.skillsToEmphasize ?? [],
      summaryLine: parsed.summaryLine ?? null,
    };
  } catch {
    return { bulletPoints: [], skillsToEmphasize: [], summaryLine: null };
  }
}
