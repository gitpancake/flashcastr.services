import { createServer } from "http";

export type HealthLevel = "ok" | "degraded" | "error";

export interface HealthCheckResult {
  status: HealthLevel;
  message?: string;
}

export type HealthCheck = () => Promise<HealthCheckResult> | HealthCheckResult;

export interface HealthStatus {
  status: HealthLevel;
  checks: Record<string, HealthCheckResult>;
  uptime: number;
}

function worse(a: HealthLevel, b: HealthLevel): HealthLevel {
  if (a === "error" || b === "error") return "error";
  if (a === "degraded" || b === "degraded") return "degraded";
  return "ok";
}

export async function evaluateHealth(checks: Record<string, HealthCheck>, startTime = Date.now()): Promise<HealthStatus> {
  const results: HealthStatus["checks"] = {};
  let overall: HealthLevel = "ok";

  for (const [name, check] of Object.entries(checks)) {
    try {
      results[name] = await check();
    } catch (err) {
      results[name] = { status: "error", message: (err as Error).message };
    }
    overall = worse(overall, results[name].status);
  }

  return { status: overall, checks: results, uptime: (Date.now() - startTime) / 1000 };
}

/** HTTP status for a health result: only "error" is unhealthy; "degraded" still serves. */
export function healthStatusCode(status: HealthLevel): number {
  return status === "error" ? 503 : 200;
}

export function startHealthServer(port: number, checks: Record<string, HealthCheck>): void {
  const startTime = Date.now();

  const server = createServer(async (req, res) => {
    if (req.url !== "/health") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    const health = await evaluateHealth(checks, startTime);
    res.setHeader("Content-Type", "application/json");
    res.statusCode = healthStatusCode(health.status);
    res.end(JSON.stringify(health));
  });

  server.listen(port);
}
