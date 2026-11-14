/** JSON shapes the browser receives (dates are ISO strings, ids are hex strings). */
export type Iso = string;

export interface HistoryEntry { status: string; at: Iso; wallAt: Iso; by: string; note?: string }
export interface TaskJ {
  _id: string; claimId: string; taskId: string; type: string; title?: string; track: "intake" | "repair" | "rental" | "medical" | "close";
  dependsOn: string[]; status: string; isWait?: boolean; params?: Record<string, unknown>; history: HistoryEntry[]; createdAt?: Iso; updatedAt?: Iso;
}
export interface ActionJ {
  _id: string; claimId: string; taskId: string; system: string; kind: string; idempotencyKey: string; payload: Record<string, unknown>;
  expectedEffect: Record<string, unknown>; verifyBy: string; status: string; attempts: number; deadline: Iso; history: HistoryEntry[];
  supersedes?: { actionId: string }; gate?: string; approvalId?: string; lastError?: string | null; createdAt?: Iso; response?: unknown; readback?: unknown;
}
export interface ObservationJ {
  _id: string; claimId: string; source: string; kind: string; body: Record<string, unknown>; matchedActionId?: string; verified: boolean;
  trust?: "known" | "company_line" | "unknown"; receivedAt: Iso; receivedWallAt?: Iso; processedAt?: Iso; processedBy?: string; note?: string;
}
export interface ApprovalJ {
  _id: string; claimId: string; actionId?: string; taskId?: string; gate: string; approverRole: "claimant" | "operator"; request: string;
  details?: Record<string, unknown>; status: "pending" | "approved" | "declined"; decidedBy?: string; decidedAt?: Iso; decisionNote?: string; createdAt?: Iso;
}
export interface TimerJ { _id: string; claimId: string; taskId: string; rule: string; dueAt: Iso; fired: boolean; cancelled: boolean; escalationLevel: number; approvalId?: string; actionId?: string; firedAt?: Iso; params?: Record<string, unknown> }
export interface MoneyRowJ { itemId: string; kind: string; category: string; billed: number; submitted: number; paid: number; billedToSubmittedGap: number; submittedToPaidGap: number; reason?: string }
export interface ClaimJ {
  _id: string; claimant: { name: string; firstName?: string; phone?: string; email?: string }; phase: string; compactSummary: string;
  policy: { number: string; insurer: string; rentalDailyLimit: number; rentalMaxDays: number; deductible?: number };
  vehicle: { make: string; model: string; vin?: string; year?: number };
  accident?: { date: string; place: string; description: string; injuries: boolean };
  external?: Record<string, unknown>; facts?: Record<string, unknown>;
  money: { totals: { category: string; billed: number; submitted: number; paid: number }[]; items: unknown[] };
  createdAt: Iso;
}
export interface DocumentJ { _id: string; docType: string; source: string; extractedText: string; createdAt: Iso; gridfsId: string }
export interface ClaimSnapshot {
  claim: ClaimJ; tasks: TaskJ[]; actions: ActionJ[]; observations: ObservationJ[]; approvals: ApprovalJ[]; timers: TimerJ[];
  money: MoneyRowJ[]; documents: DocumentJ[]; lease: { workerId: string; expiresAt: Iso } | null; simNow: Iso;
}
export interface ClaimRow { _id: string; claimantName: string; phase: string; createdAt: Iso; openGates: number; unconfirmedActions: number; tasksDone: number; tasksTotal: number; leaseHolder: string | null; leaseLive: boolean }
export interface AgentStatus {
  reachable: boolean;
  clock?: { sim: Iso; wall: Iso };
  workers?: { configured: string[]; running: { workerId: string; pid: number; startedAt: Iso }[]; history: { workerId: string; event: string; at: Iso }[] } | null;
  leases?: { claimId: string; workerId: string; expiresAt: Iso; live: boolean }[];
  workerState?: { workerId: string; resumeTokenSavedAt: Iso | null; heartbeatAt: Iso | null; held: string[]; pid: number | null; replayedFromToken: number }[];
  llmMode?: string;
  speed?: number;
}
