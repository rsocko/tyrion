export type FinanceInquiryErrorCode =
  | 'invalid_input'
  | 'permission_denied'
  | 'not_found'
  | 'cancelled'
  | 'timed_out'
  | 'output_bound_exceeded'
  | 'source_unavailable';

const SAFE_MESSAGES: Readonly<Record<FinanceInquiryErrorCode, string>> =
  Object.freeze({
    invalid_input: 'The finance inquiry request is invalid.',
    permission_denied: 'Finance inquiry permission is required.',
    not_found: 'The requested finance record was not found.',
    cancelled: 'The finance inquiry was cancelled.',
    timed_out: 'The finance inquiry timed out.',
    output_bound_exceeded: 'The finance inquiry result exceeded its safe output limit.',
    source_unavailable: 'Finance data is temporarily unavailable.',
  });

export class FinanceInquiryError extends Error {
  readonly code: FinanceInquiryErrorCode;

  constructor(code: FinanceInquiryErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'FinanceInquiryError';
    this.code = code;
  }
}
