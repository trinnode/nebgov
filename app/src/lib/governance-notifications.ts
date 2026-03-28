/**
 * Browser notification preferences and on-device event history (localStorage).
 */

export const LS_NOTIFY_TOGGLES = "nebgov-notify-toggles";
export const LS_NOTIFY_HISTORY = "nebgov-notify-history";
export const LS_PROPOSAL_META = "nebgov-proposal-meta";

/** Keys match the six user-facing toggle groups in the UI. */
export type NotificationToggleKey =
  | "created_self"
  | "active"
  | "voting_ends_soon"
  | "outcome"
  | "queued"
  | "executed";

export type NotificationToggles = Record<NotificationToggleKey, boolean>;

export const DEFAULT_NOTIFICATION_TOGGLES: NotificationToggles = {
  created_self: true,
  active: true,
  voting_ends_soon: true,
  outcome: true,
  queued: true,
  executed: true,
};

export type NotificationEventKind =
  | NotificationToggleKey
  | "passed"
  | "failed";

export type NotificationHistoryEntry = {
  id: string;
  kind: NotificationEventKind;
  proposalId: string;
  title: string;
  body: string;
  at: number;
  ledger?: number;
};

const MAX_HISTORY = 200;

export function loadNotificationToggles(): NotificationToggles {
  if (typeof window === "undefined") return { ...DEFAULT_NOTIFICATION_TOGGLES };
  try {
    const raw = localStorage.getItem(LS_NOTIFY_TOGGLES);
    if (!raw) return { ...DEFAULT_NOTIFICATION_TOGGLES };
    const parsed = JSON.parse(raw) as Partial<NotificationToggles>;
    return { ...DEFAULT_NOTIFICATION_TOGGLES, ...parsed };
  } catch {
    return { ...DEFAULT_NOTIFICATION_TOGGLES };
  }
}

export function saveNotificationToggles(t: NotificationToggles): void {
  localStorage.setItem(LS_NOTIFY_TOGGLES, JSON.stringify(t));
  window.dispatchEvent(new Event("nebgov-notify-toggles"));
}

export function loadNotificationHistory(): NotificationHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_NOTIFY_HISTORY);
    if (!raw) return [];
    return JSON.parse(raw) as NotificationHistoryEntry[];
  } catch {
    return [];
  }
}

export function appendNotificationHistory(
  entry: Omit<NotificationHistoryEntry, "id" | "at"> & { at?: number }
): void {
  const row: NotificationHistoryEntry = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
    at: entry.at ?? Date.now(),
    kind: entry.kind,
    proposalId: entry.proposalId,
    title: entry.title,
    body: entry.body,
    ledger: entry.ledger,
  };
  const prev = loadNotificationHistory();
  const next = [row, ...prev].slice(0, MAX_HISTORY);
  localStorage.setItem(LS_NOTIFY_HISTORY, JSON.stringify(next));
  window.dispatchEvent(new Event("nebgov-notify-history"));
}

export type ProposalMeta = {
  endLedger: number;
  startLedger: number;
  proposer: string;
};

export function loadProposalMeta(): Record<string, ProposalMeta> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_PROPOSAL_META);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, ProposalMeta>;
  } catch {
    return {};
  }
}

export function saveProposalMeta(meta: Record<string, ProposalMeta>): void {
  localStorage.setItem(LS_PROPOSAL_META, JSON.stringify(meta));
}

export function mergeProposalMetaEntry(
  proposalId: bigint,
  patch: ProposalMeta
): void {
  const all = loadProposalMeta();
  all[proposalId.toString()] = patch;
  saveProposalMeta(all);
}
