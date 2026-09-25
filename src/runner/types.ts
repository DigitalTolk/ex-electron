// Wire types shared between the runner and the ex backend's runner API
// (ex/internal/handler/agentrunner.go). Field names match the Go JSON tags.

export interface RunnerHarness {
  name: string; // "claude" | "codex"
  version?: string;
  authed: boolean;
}

export interface AgentLimits {
  maxTurns?: number;
  maxWallClockSec?: number;
  maxTokens?: number;
  maxPosts?: number;
  maxConsultDepth?: number;
  // Task budgets (direct @mentions): deep work gets more turns/wall-clock
  // than ambient conversation. Mirrors the backend's TurnsFor/WallClockFor.
  maxTaskTurns?: number;
  maxTaskWallClockSec?: number;
}

// turnsFor mirrors the backend's mode-aware turn budget: direct tasks get
// depth, ambient modes (watch/heartbeat/followup) stay conversational.
export function turnsFor(limits: AgentLimits, mode: string | undefined): number {
  // Coding-task runs are uncapped by decision (plan-coding-agent.md): 0 means
  // "pass no --max-turns"; the server's rolling idle deadline is the reaper.
  if (mode === 'task') return 0;
  if (mode === 'direct' || !mode) return limits.maxTaskTurns || 128;
  return limits.maxTurns || 16;
}

// TaskSpec is the coding-task snapshot on a task-mode assignment (mirrors the
// Go model.TaskSpec). The workspace manager prepares the project checkout from
// it before the harness starts; the prompt preamble narrates it.
export interface TaskSpecRepo {
  path: string; // GitLab "group/sub/repo"
  role: string; // backend | frontend | mobile | infra | other
  branch: string;
  baseBranch?: string; // "" → the repo's default branch
  mrURL?: string;
}

export interface TaskSpec {
  id: string;
  projectKey: string; // e.g. "cliffhub" — the workspace folder + channel key
  projectName: string; // e.g. "CliffHub"
  title: string;
  goal: string;
  kind: string; // bug | feature | chore
  state: string;
  repos: TaskSpecRepo[];
  channelID: string;
  threadRootID: string;
  testURL?: string;
  signedOff?: boolean;
  runnerID?: string;
}

export interface Assignment {
  runID: string;
  agentID: string;
  agentName: string;
  invokerID: string;
  invokerName: string;
  parentID: string;
  parentType: string;
  threadRootID?: string;
  messageID: string;
  harness: string;
  model?: string;
  persona: string;
  mode?: string; // "direct" | "watch" | "heartbeat" | "followup" | "task"
  // askFirst (follow-up runs): the invoker wants an approval gate before the
  // agent actually posts its reply.
  askFirst?: boolean;
  // Watcher runs: the creator's standing order + how much the agent may do
  // (notify | draft | reply | autonomous). notify/draft can't post publicly.
  watchInstruction?: string;
  actionMode?: string;
  prompt: string;
  contextBundle: string;
  // Connectors the invoking message explicitly picked with /slug tokens.
  connectorSlugs?: string[];
  // Coding task (mode "task"): the workspace manager clones/fetches the
  // project and the harness runs INSIDE the checkout.
  task?: TaskSpec;
  // Harness tool classes the invoker pre-approved for this agent
  // (read | edit | shell | web): the permission gateway skips the card.
  autoAllow?: string[];
  limits: AgentLimits;
  mcpToken: string;
  leaseExpiresAt: string;
  deadline: string;
}

// One runner→backend event. seq is a per-run monotonic counter starting at 1
// so retried batches are idempotent server-side.
export interface RunEventInput {
  seq: number;
  type: 'turn' | 'usage' | 'progress' | 'tool' | 'tool_result' | 'state' | 'prompt';
  payload?: Record<string, unknown>;
}

export interface EventsResponse {
  abort: boolean;
  reason?: string;
}

export interface RegisterResponse {
  runnerID: string;
  agents: { id: string; displayName: string; slug: string }[];
  leaseSec: number;
}

export interface HeartbeatResponse {
  kill: string[];
}

// Outcome of one harness execution, reported to complete/fail.
export interface RunOutcome {
  ok: boolean;
  finalText: string;
  reason?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export type RunnerLogger = (msg: string, extra?: Record<string, unknown>) => void;
