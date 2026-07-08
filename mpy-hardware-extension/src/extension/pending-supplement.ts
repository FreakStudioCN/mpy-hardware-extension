import type { SupplementAttachment } from "../core/supplement-router.ts";

// Session-scoped state for a user supplement queued during a running build (deliverables
// 07 §3). Lives in the extension host, not in any Skill input schema. Consumed at the
// after-`phase_complete` safe point.
export type SupplementStatus = "queued" | "applied" | "reroute_required" | "discarded";

export interface PendingSupplement {
  text: string;
  attachments: SupplementAttachment[];
  receivedPhase: string;
  receivedAt: string;
  status: SupplementStatus;
}
