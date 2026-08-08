const presentations = Object.freeze({
  loading: ["Loading", "Loading household policy configuration."],
  unavailable: ["Unavailable", "Policy configuration is unavailable."],
  unauthenticated: ["Access required", "Trusted policy access is required."],
  empty: ["Empty", "No household policy has been saved."],
  ready: ["Ready", "Household policy is ready to edit."],
  saving: ["Saving", "Saving the household policy."],
  previewing: ["Previewing", "Calculating bounded re-attribution impact."],
  applying: ["Applying", "Applying the confirmed re-attribution preview."],
  success: ["Success", "The last policy operation completed."],
  conflict: ["Conflict", "The policy changed and must be reloaded."],
  failure: ["Failure", "The last policy operation failed."],
});

export function policyStatePresentation(state) {
  const [label, description] =
    presentations[state] ?? presentations.unavailable;
  return { label, description };
}
