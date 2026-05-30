/** Strip markdown code fences, trailing text, and parse JSON from an AI response. */
export function parseAIJson<T>(text: string): T {
  const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  // Try each { or [ as a potential JSON start — handles preamble that contains braces
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{' || ch === '[') {
      const closer = ch === '{' ? '}' : ']';
      const lastClose = cleaned.lastIndexOf(closer);
      if (lastClose > i) {
        try {
          return JSON.parse(cleaned.slice(i, lastClose + 1)) as T;
        } catch { /* try next candidate */ }
      }
    }
  }
  return JSON.parse(cleaned) as T;
}

/** Extract all text from an Anthropic response, handling tool-interleaved content blocks. */
export function extractResponseText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}
