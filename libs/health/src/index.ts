import { createServer } from "http";

export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  checks: Record<string, { status: string; message?: string }>;
  uptime: number;
}

export type HealthCheck = () => Promise<{ status: string; message?: string }>;

export function startHealthServer(
  port: number,
  checks: Record<string, HealthCheck>
): void {
  const startTime = Date.now();

  const server = createServer(async (req, res) => {
    if (req.url !== "/health") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    const results: HealthStatus["checks"] = {};
    let overallStatus: HealthStatus["status"] = "ok";

    for (const [name, check] of Object.entries(checks)) {
      try {
        results[name] = await check();
        if (results[name].status === "error") overallStatus = "error";
        else if (results[name].status === "degraded" && overallStatus !== "error")
          overallStatus = "degraded";
      } catch (err) {
        results[name] = { status: "error", message: (err as Error).message };
        overallStatus = "error";
      }
    }

    const health: HealthStatus = {
      status: overallStatus,
      checks: results,
      uptime: (Date.now() - startTime) / 1000,
    };

    res.setHeader("Content-Type", "application/json");
    res.statusCode = overallStatus === "ok" ? 200 : 503;
    res.end(JSON.stringify(health));
  });

  server.listen(port);
}
