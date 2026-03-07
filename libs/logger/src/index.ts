export function createLogger(serviceName: string) {
  const prefix = `[${serviceName}]`;

  return {
    info: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
    debug: (...args: unknown[]) => {
      if (process.env.LOG_LEVEL === "debug") {
        console.debug(prefix, ...args);
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
