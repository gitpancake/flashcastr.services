import { createLogger, flushLogs, type Logger } from "@flashcastr/logger";
import { startMetricsServer, type Registry } from "@flashcastr/metrics";
import type { HealthCheck } from "@flashcastr/health";

export interface ServiceContext {
  log: Logger;
  /** Register a step to run on SIGINT/SIGTERM. Steps run in reverse registration order. */
  onShutdown(name: string, step: () => Promise<void> | void): void;
}

export interface RunServiceOptions {
  registry: Registry;
  metricsPort: number;
  healthChecks?: Record<string, HealthCheck>;
  start: (context: ServiceContext) => Promise<void>;
}

interface ShutdownStep {
  name: string;
  run: () => Promise<void> | void;
}

/**
 * Standard process lifecycle for a service: metrics + health endpoint,
 * ordered shutdown on signals, and a logged exit on unhandled errors.
 */
export function runService(name: string, options: RunServiceOptions): void {
  const log = createLogger(name);
  const steps: ShutdownStep[] = [];
  let exiting = false;

  const exit = async (code: number): Promise<never> => {
    await flushLogs();
    process.exit(code);
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    log.info(`Received ${signal}, shutting down...`);
    for (const step of [...steps].reverse()) {
      try {
        await step.run();
      } catch (err) {
        log.error(`Shutdown step "${step.name}" failed:`, err);
      }
    }
    await exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection:", reason);
    void exit(1);
  });
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception:", err);
    void exit(1);
  });

  startMetricsServer(options.registry, options.metricsPort, options.healthChecks);

  const context: ServiceContext = {
    log,
    onShutdown: (stepName, run) => steps.push({ name: stepName, run }),
  };

  options.start(context)
    .then(() => log.info(`${name} started`))
    .catch((err) => {
      log.error(`${name} failed to start:`, err);
      void exit(1);
    });
}
