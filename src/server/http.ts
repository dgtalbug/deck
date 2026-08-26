import type { BunRequest, Server } from 'bun';
import { ZodError } from 'zod';
import {
  DeckError,
  LaneViolation,
  NotFoundError,
  WipLimitError,
} from '../core/board/errors.ts';
import { GhUnavailableError } from '../core/git/errors.ts';

export type RouteHandler = (
  req: BunRequest<string>,
  server: Server<undefined>,
) => Response | Promise<Response>;

export type RouteTable = Record<string, Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', RouteHandler>>>;

// Error mapping locked by the epic: LaneViolation → 400, WipLimitError → 409,
// unknown id → 404, GhUnavailableError → 503 (capability absent, not a bad
// request — v0.3.0), everything else bubbles to serve.ts's error() → 500.
export function handleError(error: unknown): Response {
  if (error instanceof LaneViolation) return jsonError(error, 400);
  if (error instanceof WipLimitError) return jsonError(error, 409);
  if (error instanceof NotFoundError) return jsonError(error, 404);
  if (error instanceof GhUnavailableError) return jsonError(error, 503);
  if (error instanceof ZodError) {
    return Response.json({ error: 'invalid request body', issues: error.issues }, { status: 400 });
  }
  if (error instanceof DeckError) return jsonError(error, 400);
  console.error('unexpected error:', error);
  return Response.json({ error: 'internal server error' }, { status: 500 });
}

function jsonError(error: DeckError, status: number): Response {
  return Response.json({ error: error.message, details: error.details }, { status });
}

// Wrap handler bodies so every route shares one error path.
export async function attempt(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    return handleError(error);
  }
}
