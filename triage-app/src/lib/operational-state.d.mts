import type { AuthState } from "./bridge-client";

export type OperationalViewState = AuthState | "checking" | "unavailable";

export function connectionPresentation(state: OperationalViewState): {
  label: string;
  description: string;
  tone: "good" | "warning" | "bad" | "checking";
};
