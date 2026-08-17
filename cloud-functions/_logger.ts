/**
 * Shared logger factory for cloud-functions.
 */
export function createLogger(tag: string) {
  return {
    log(...args: unknown[]) {
      console.log(`[${tag}][${new Date().toISOString()}]`, ...args);
    },
    warn(...args: unknown[]) {
      console.warn(`[${tag}][${new Date().toISOString()}]`, ...args);
    },
    error(...args: unknown[]) {
      console.error(`[${tag}][${new Date().toISOString()}]`, ...args);
    },
  };
}
