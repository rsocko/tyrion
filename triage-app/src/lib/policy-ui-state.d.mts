export type PolicyUiState =
  | "loading"
  | "unavailable"
  | "unauthenticated"
  | "empty"
  | "ready"
  | "saving"
  | "previewing"
  | "applying"
  | "success"
  | "conflict"
  | "failure";

export function policyStatePresentation(state: PolicyUiState): {
  label: string;
  description: string;
};
