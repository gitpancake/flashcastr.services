import { createServer } from "http";
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import { evaluateHealth, healthStatusCode, type HealthCheck } from "@flashcastr/health";

export function createMetricsRegistry(serviceName: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });
  return registry;
}

/**
 * Serves /metrics and /health. With no checks /health always reports ok,
 * as before; with checks it returns 503 when any check reports "error".
 */
export function startMetricsServer(registry: Registry, port: number, healthChecks: Record<string, HealthCheck> = {}): void {
  const startTime = Date.now();

  const server = createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());
      return;
    }

    if (req.url === "/health") {
      const health = await evaluateHealth(healthChecks, startTime);
      res.setHeader("Content-Type", "application/json");
      res.statusCode = healthStatusCode(health.status);
      res.end(JSON.stringify({ ...health, timestamp: Date.now() }));
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");
  });

  server.listen(port, () => {
    console.log(`Metrics server listening on port ${port}`);
  });
}

export { Registry, Counter, Gauge, Histogram };
