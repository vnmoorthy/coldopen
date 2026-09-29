// The pipeline logs a console.warn every time it falls back (no LLM key, Overpass down, ...).
// Those fallbacks are exactly what many tests exercise, so keep the test output readable.
import { beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
