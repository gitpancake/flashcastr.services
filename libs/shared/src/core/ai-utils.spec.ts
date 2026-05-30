import { describe, it, expect } from 'vitest';
import { parseAIJson } from './ai-utils.js';

describe('parseAIJson', () => {
  it('parses standard JSON object without preamble', () => {
    const input = '{"tasks":[{"title":"Walk the dog"}]}';
    const result = parseAIJson<{ tasks: { title: string }[] }>(input);
    expect(result.tasks[0].title).toBe('Walk the dog');
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const input = '```json\n{"tasks":[{"title":"Walk the dog"}]}\n```';
    const result = parseAIJson<{ tasks: { title: string }[] }>(input);
    expect(result.tasks[0].title).toBe('Walk the dog');
  });

  it('parses JSON with prose preamble', () => {
    const input =
      'Looking at your constraints and the weather today, here is my suggestion:\n{"tasks":[{"title":"Stanley Park loop"}]}';
    const result = parseAIJson<{ tasks: { title: string }[] }>(input);
    expect(result.tasks[0].title).toBe('Stanley Park loop');
  });

  it('parses JSON array with prose preamble', () => {
    const input =
      'Based on your preferences, I recommend:\n[{"title":"Morning yoga"},{"title":"Grocery run"}]';
    const result = parseAIJson<{ title: string }[]>(input);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Morning yoga');
    expect(result[1].title).toBe('Grocery run');
  });

  it('parses JSON with trailing commentary', () => {
    const input = '{"score":0.8}\nLet me know if you want adjustments.';
    const result = parseAIJson<{ score: number }>(input);
    expect(result.score).toBe(0.8);
  });

  it('parses JSON with both preamble and trailing text', () => {
    const input =
      'Here you go:\n{"result":"done"}\nHope that helps!';
    const result = parseAIJson<{ result: string }>(input);
    expect(result.result).toBe('done');
  });

  it('handles preamble containing curly braces', () => {
    const input = 'Use the format {key: value} as follows:\n{"result":"done"}';
    const result = parseAIJson<{ result: string }>(input);
    expect(result.result).toBe('done');
  });

  it('throws on input with no valid JSON', () => {
    expect(() => parseAIJson('no json here')).toThrow();
  });
});
