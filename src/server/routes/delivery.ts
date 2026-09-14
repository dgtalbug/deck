// Delivery routes (E05 DECK-ARCH-014, additive): policy enrollment,
// finalization, delivery status and cleanup retries over HTTP — the same
// cores the CLI doors call. Outcomes are explicit: preparation returns
// delivery pending; `deliver` returns delivered | awaiting-merge | refused
// with the unsatisfied condition.
import { z } from 'zod';
import { enrollPolicy } from '../../core/board/rules.ts';
import { deliveryStatus, finalizeDelivery } from '../../core/engine/delivery.ts';
import { retryCleanup } from '../../core/engine/delivery-cleanup.ts';
import { DeliveryRefusedError } from '../../core/engine/delivery.ts';
import type { ProjectRegistry } from '../../core/projects/registry.ts';
import { projectStore } from '../stores.ts';
import { attempt, type RouteTable } from '../http.ts';

export const parity = {
  'POST /:project/cards/:id/policy': 'enrollPolicy',
  'POST /:project/cards/:id/deliver': 'finalizeDelivery',
  'GET /:project/cards/:id/delivery': 'deliveryStatus',
  'POST /:project/cards/:id/cleanup': 'retryCleanup',
};

export const policyBody = z.object({
  mode: z.enum(['team', 'solo']),
  requiredChecks: z.array(z.string().min(1)).optional(),
  requiredApprovals: z.number().int().min(0).optional(),
  manualCriteria: z.array(z.string().min(1)).optional(),
});

export function deliveryRoutes(registry: ProjectRegistry): RouteTable {
  const store = (project: string) => projectStore(registry, project);
  return {
    '/:project/cards/:id/policy': {
      POST: (req) =>
        attempt(async () => {
          const body = policyBody.parse(await req.json());
          const policy = enrollPolicy(await store(req.params.project!), req.params.id!, body);
          return Response.json({ policy });
        }),
    },
    '/:project/cards/:id/deliver': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          try {
            const outcome = await finalizeDelivery(await store(req.params.project!), req.params.id!);
            return Response.json({
              result: outcome.result,
              reason: outcome.reason,
              card: outcome.card,
              delivery: outcome.delivery,
            });
          } catch (error) {
            if (error instanceof DeliveryRefusedError) {
              return Response.json({ error: error.message, details: error.details }, { status: 409 });
            }
            throw error;
          }
        }),
    },
    '/:project/cards/:id/delivery': {
      GET: (req) =>
        attempt(async () => Response.json(deliveryStatus(await store(req.params.project!), req.params.id!))),
    },
    '/:project/cards/:id/cleanup': {
      POST: (req) =>
        attempt(async () => {
          await req.json().catch(() => undefined);
          const outcome = await retryCleanup(await store(req.params.project!), req.params.id!);
          return Response.json(outcome);
        }),
    },
  };
}
