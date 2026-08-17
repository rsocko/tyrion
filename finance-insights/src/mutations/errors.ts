export type FinanceMutationErrorCode =
  | 'invalid_input'
  | 'permission_denied'
  | 'target_not_found'
  | 'proposal_not_found'
  | 'proposal_expired'
  | 'proposal_used'
  | 'stale_state'
  | 'connector_unavailable'
  | 'connector_authorization_failed'
  | 'mutation_rejected'
  | 'verification_failed'
  | 'reconciliation_failed'
  | 'audit_failed'
  | 'cancelled'
  | 'timed_out'
  | 'service_unavailable';

const SAFE_MESSAGES: Readonly<Record<FinanceMutationErrorCode, string>> =
  Object.freeze({
    invalid_input: 'The finance mutation request is invalid.',
    permission_denied: 'Finance mutation permission is required.',
    target_not_found: 'The requested finance mutation target was not found.',
    proposal_not_found: 'The finance mutation proposal was not found.',
    proposal_expired: 'The finance mutation proposal has expired.',
    proposal_used: 'The finance mutation proposal has already been used.',
    stale_state: 'Finance state changed after the proposal was prepared.',
    connector_unavailable: 'The Monarch connector is not ready for mutations.',
    connector_authorization_failed:
      'The Monarch connector requires authentication before this mutation can run.',
    mutation_rejected: 'The finance mutation was rejected.',
    verification_failed: 'The finance mutation could not be verified.',
    reconciliation_failed:
      'The finance mutation succeeded but local reconciliation failed.',
    audit_failed:
      'The finance mutation completed but its audit record could not be written.',
    cancelled: 'The finance mutation was cancelled.',
    timed_out: 'The finance mutation timed out.',
    service_unavailable: 'The finance mutation service is temporarily unavailable.',
  });

export class FinanceMutationError extends Error {
  constructor(readonly code: FinanceMutationErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'FinanceMutationError';
  }
}

export type FinanceMutationAdapterErrorCode =
  | 'not_found'
  | 'conflict'
  | 'authorization_failed'
  | 'rejected'
  | 'unavailable';

export class FinanceMutationAdapterError extends Error {
  constructor(readonly code: FinanceMutationAdapterErrorCode) {
    super('Finance mutation adapter failed');
    this.name = 'FinanceMutationAdapterError';
  }
}
