import { createServer } from 'http';
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export function createMetricsRegistry(serviceName: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });
  return registry;
}

export function startMetricsServer(registry: Registry, port: number): void {
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    } else if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    } else {
      res.statusCode = 404;
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    console.log(`Metrics server listening on port ${port}`);
  });
}

/** Histogram for timing external API calls. Labels: api, operation, status */
export function createApiDurationHistogram(registry: Registry) {
  return new Histogram({
    name: 'external_api_duration_seconds',
    help: 'Duration of external API calls in seconds',
    labelNames: ['api', 'operation', 'status'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });
}

/** Counter for events published to RabbitMQ. Labels: routing_key */
export function createEventsPublishedCounter(registry: Registry) {
  return new Counter({
    name: 'events_published_total',
    help: 'Total events published to RabbitMQ',
    labelNames: ['routing_key'],
    registers: [registry],
  });
}

/** Histogram for AI/Claude API call durations. Labels: task */
export function createAiDurationHistogram(registry: Registry) {
  return new Histogram({
    name: 'ai_call_duration_seconds',
    help: 'Duration of AI/Claude API calls in seconds',
    labelNames: ['task'],
    buckets: [0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  });
}

/** Circuit breaker metrics for agent-pet Fi client */
export function createCircuitBreakerMetrics(registry: Registry) {
  return {
    state: new Gauge({ name: 'fi_circuit_breaker_state', help: 'Circuit breaker state (0=closed, 1=open)', registers: [registry] }),
    tripsTotal: new Counter({ name: 'fi_circuit_breaker_trips_total', help: 'Circuit breaker trip count', registers: [registry] }),
    consecutiveFailures: new Gauge({ name: 'fi_consecutive_failures', help: 'Current consecutive failure count', registers: [registry] }),
  };
}

/** Display-sync write metrics for api-gateway */
export function createDisplaySyncMetrics(registry: Registry) {
  return {
    rowsTotal: new Gauge({ name: 'display_sync_rows_total', help: 'Row count per domain table', labelNames: ['domain'], registers: [registry] }),
    writeDuration: new Histogram({ name: 'display_sync_write_duration_seconds', help: 'Display-sync write latency', labelNames: ['domain'], buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5], registers: [registry] }),
  };
}

export { Registry, Counter, Gauge, Histogram };
