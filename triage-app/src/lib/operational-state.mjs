const presentations = Object.freeze({
  checking: {
    label: "Checking",
    description: "Checking bridge reachability and Monarch authentication.",
    tone: "checking",
  },
  unavailable: {
    label: "Unavailable",
    description: "The operational UI cannot reach or authorize with the bridge.",
    tone: "bad",
  },
  unauthenticated: {
    label: "Not authenticated",
    description: "No bridge-managed Monarch session exists.",
    tone: "warning",
  },
  connected: {
    label: "Connected",
    description: "The bridge verified its managed Monarch session.",
    tone: "good",
  },
  expired: {
    label: "Expired",
    description: "Monarch rejected the prior session. Authenticate again.",
    tone: "bad",
  },
  degraded: {
    label: "Degraded",
    description: "A session exists, but Monarch verification is temporarily unavailable.",
    tone: "warning",
  },
});

export function connectionPresentation(state) {
  return presentations[state] || presentations.unavailable;
}
