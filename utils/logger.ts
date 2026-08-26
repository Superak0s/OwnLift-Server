// console already ships info/warn/error — the only thing worth adding is a
// timestamp, which is what this is.
const stamp =
  (level: "info" | "warn" | "error") =>
  (...args: unknown[]) =>
    console[level](`[${new Date().toISOString()}] ${level.toUpperCase()}`, ...args)

export const logger = {
  info: stamp("info"),
  warn: stamp("warn"),
  error: stamp("error"),
}
