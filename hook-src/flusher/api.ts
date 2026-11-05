// The flusher's view of the Tickr agent routes: outcome classes and the client interface. The
// sender stage consumes it; until a client is configured the flusher uses OFFLINE_API.

export type SendOutcome =
  | { kind: "applied"; created: boolean; finalized: boolean; detached: boolean }
  | { kind: "retry"; afterMs: number }
  | { kind: "pause"; reason: "unauthorized" | "forbidden_role" | "segments_disabled" | "clock_skew" }
  | { kind: "terminal"; code: string; closesSegment: boolean };

export interface AgentApi {
  me(): Promise<{ workspaceId: string; serverTime: string } | SendOutcome>;
  putSegment(id: string, body: object, agent: string): Promise<SendOutcome>;
  putUsage(id: string, body: object): Promise<SendOutcome>;
}

const LATER: SendOutcome = { kind: "retry", afterMs: 60_000 };

/** Sends nothing: every call answers "retry later". */
export const OFFLINE_API: AgentApi = {
  me: () => Promise.resolve(LATER),
  putSegment: () => Promise.resolve(LATER),
  putUsage: () => Promise.resolve(LATER),
};
