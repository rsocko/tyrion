import type { PolicyActorV1 } from "@rsocko/tyrion-kid-engine/contracts/v1";

export const HOMELAB_HOUSEHOLD_ID = "homelab-household";
export const HOMELAB_POLICY_ACTOR_ID = "local-operator";
export const MISSION_CONTROL_ATTRIBUTION_ACTOR_ID =
  "mission-control-finance-manager";

export function resolveHomelabPolicyActor(): PolicyActorV1 {
  return {
    actorId: HOMELAB_POLICY_ACTOR_ID,
    householdId: HOMELAB_HOUSEHOLD_ID,
    permissions: [
      "policy:read",
      "policy:write",
      "reattribution:preview",
      "reattribution:apply",
    ],
  };
}

export function resolveMissionControlAttributionActor(): PolicyActorV1 {
  return {
    actorId: MISSION_CONTROL_ATTRIBUTION_ACTOR_ID,
    householdId: HOMELAB_HOUSEHOLD_ID,
    permissions: ["attribution:batch", "attribution:actions"],
  };
}
