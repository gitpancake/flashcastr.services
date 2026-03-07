import { config } from "dotenv";

export function loadConfig(): void {
  config({ path: ".env" });
}

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not defined in environment`);
  return value;
}

export function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export function intEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}
