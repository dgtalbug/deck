export type ProjectionEligibilityStatus = 'eligible' | 'ineligible' | 'unknown';

export interface ProjectionSourceRecord {
  cardId: string;
  criterionId: string;
  requestedScopeRevision: number;
  currentScopeRevision: number | null;
  currentLane: string | null;
  scopeDigest: string | null;
  policyVersion: number | null;
  evidence: {
    id: string;
    result: 'passed' | 'failed' | 'unavailable';
    scopeRevision: number;
    policyVersion: number;
    inputFingerprint: string;
  } | null;
  delivery: {
    id: string;
    state: 'prepared' | 'pending' | 'delivered' | 'refused';
    mode: 'team' | 'solo';
    provenance: 'hosted' | 'local' | null;
    scopeRevision: number;
    policyVersion: number;
    inputFingerprint: string | null;
  } | null;
}

export interface ProjectionEligibility {
  status: ProjectionEligibilityStatus;
  assurance: 'hosted' | 'local' | 'unknown';
  evidenceId: string | null;
  deliveryId: string | null;
  reasons: string[];
  sourceDrift: 'none' | 'changed' | 'reopened' | 'unknown';
}

export function readCapabilityEligibility(source: ProjectionSourceRecord): ProjectionEligibility {
  const reasons: string[] = [];
  let sourceDrift: ProjectionEligibility['sourceDrift'] = 'none';
  if (source.currentScopeRevision === null || source.scopeDigest === null) {
    sourceDrift = 'unknown';
    reasons.push('exact source scope revision is unavailable');
  } else if (source.currentScopeRevision !== source.requestedScopeRevision) {
    sourceDrift = 'changed';
    reasons.push('source scope revision changed after completion');
  }
  if (source.currentLane !== null && source.currentLane !== 'done') {
    sourceDrift = 'reopened';
    reasons.push('source work is no longer done');
  }
  if (source.policyVersion === null) {
    reasons.push('original delivery policy version is unavailable');
  }
  if (source.evidence === null) {
    reasons.push('attributable evidence is missing');
  } else {
    if (source.evidence.result !== 'passed') reasons.push(`evidence result is ${source.evidence.result}`);
    if (source.evidence.scopeRevision !== source.requestedScopeRevision) reasons.push('evidence scope revision does not match source');
    if (source.policyVersion !== null && source.evidence.policyVersion !== source.policyVersion) {
      reasons.push('evidence policy version does not match original policy');
    }
  }
  if (source.delivery === null) {
    reasons.push('attributable delivery is missing');
  } else {
    if (source.delivery.state !== 'delivered') reasons.push(`delivery state is ${source.delivery.state}`);
    if (source.delivery.scopeRevision !== source.requestedScopeRevision) reasons.push('delivery scope revision does not match source');
    if (source.policyVersion !== null && source.delivery.policyVersion !== source.policyVersion) {
      reasons.push('delivery policy version does not match original policy');
    }
    if (
      source.evidence !== null &&
      source.delivery.inputFingerprint !== null &&
      source.delivery.inputFingerprint !== source.evidence.inputFingerprint
    ) {
      reasons.push('delivery input fingerprint does not match evidence');
    }
  }

  const assurance = source.delivery?.provenance ?? 'unknown';
  const status = reasons.length === 0 ? 'eligible' : sourceDrift === 'unknown' ? 'unknown' : 'ineligible';
  return {
    status,
    assurance,
    evidenceId: source.evidence?.id ?? null,
    deliveryId: source.delivery?.id ?? null,
    reasons,
    sourceDrift,
  };
}
