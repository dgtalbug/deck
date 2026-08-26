// Float positions with midpoint insert. ~50 same-spot inserts halve the gap
// each time until precision collapses; when the neighbor gap drops below
// MIN_GAP the whole lane renumbers at POSITION_STEP intervals (epic
// Feasibility 3).
export const POSITION_STEP = 1024;
export const MIN_GAP = 1e-6;

export function endPosition(positions: number[]): number {
  return positions.length > 0 ? Math.max(...positions) + POSITION_STEP : POSITION_STEP;
}

export function midpoint(prev: number, next: number): number {
  return (prev + next) / 2;
}

export function gapTooSmall(prev: number, next: number): boolean {
  return next - prev < MIN_GAP;
}

export function renumberPositions(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * POSITION_STEP);
}
