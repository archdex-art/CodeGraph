// Agent swarm domain types.

export type AgentId =
  | "security"
  | "performance"
  | "refactor"
  | "deadcode"
  | "dependency"
  | "architecture"
  | "test";

export type Priority = "P0" | "P1" | "P2" | "P3";

export interface Finding {
  id: string;
  agent: AgentId;
  severity: number; // 1..5
  confidence: number; // 0..1
  title: string;
  detail: string;
  file: string;
  line: number;
  symbol: string | null;
  blastRadius: number; // >=1 (graph fan-in / usage)
  suggestedFix: string;
  effort: "S" | "M" | "L"; // rough remediation size
  // computed by the judge:
  priority?: Priority;
  score?: number;
  corroboratedBy?: AgentId[]; // other agents that flagged the same target
}

export interface AgentReport {
  agent: AgentId;
  label: string;
  findings: number;
  summary: string;
}

export interface RemediationPlan {
  generatedAt: number;
  repoScore: number;
  projectedScore: number; // estimated score after addressing P0+P1
  totalFindings: number;
  agents: AgentReport[];
  buckets: Record<Priority, Finding[]>;
  topFindings: Finding[]; // flat, ranked
  summary: string;
}
