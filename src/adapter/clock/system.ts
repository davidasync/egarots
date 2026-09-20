import type { Clock } from "../../core/storage/ports";

export function newClock(): Clock {
  return { now: () => new Date() };
}
