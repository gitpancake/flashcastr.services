import { createServer } from "http";
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export function createMetricsRegistry(serviceName: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });
  return registry;
}

export function startMetricsServer(registry: Registry, port: number): void {
  const server = createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } else if (req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
    } else {
      res.statusCode = 404;
      res.end("Not Found");
    }
  });

  server.listen(port, () => {
    console.log(`Metrics server listening on port ${port}`);
  });
}

export { Registry, Counter, Gauge, Histogram };
