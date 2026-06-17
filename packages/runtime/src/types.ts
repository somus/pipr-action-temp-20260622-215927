export type ThinkingMode = "enabled" | "disabled";
export type ReasoningEffort = "low" | "medium" | "high";

export type ProviderConfig = {
  id: string;
  model: string;
  api_key_env: string;
  thinking?: ThinkingMode;
  reasoning_effort?: ReasoningEffort;
  extra?: Record<string, unknown>;
};

export type PiprConfig = {
  version: 1;
  extends: string[];
  default_provider: string;
  providers: ProviderConfig[];
  review: {
    max_inline_comments: number;
    min_confidence: number;
  };
};

export type SourceMap = {
  config: string;
  fields: Record<string, string>;
  modules: Partial<Record<RegistryCollectionName, Record<string, string>>>;
};

export type ResolvedConfig = {
  config: PiprConfig;
  source: "builtin:minimal" | string;
  sources: SourceMap;
  modules: RuntimeModuleSet;
  warnings: string[];
};

export type PullRequestEventContext = {
  eventName: string;
  action?: string;
  repo: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  workspace: string;
};

export type FileStatus = "added" | "modified" | "removed" | "renamed";
export type ReviewSide = "RIGHT" | "LEFT";
export type RangeKind = "added" | "deleted" | "context" | "mixed";

export type CommentableRange = {
  id: string;
  path: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  kind: RangeKind;
  hunkHeader: string;
  summary?: string;
  preview?: string;
};

export type DiffManifest = {
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  files: Array<{
    path: string;
    previousPath?: string;
    status: FileStatus;
    language?: string;
    additions: number;
    deletions: number;
    commentableRanges: CommentableRange[];
    riskSignals?: string[];
    changedSymbols?: string[];
    excludedReason?: string;
  }>;
};

export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "nit";
export type ReviewFindingCategory =
  | "correctness"
  | "security"
  | "tests"
  | "performance"
  | "maintainability"
  | "docs"
  | "architecture"
  | "other";

export type ReviewFinding = {
  title: string;
  body: string;
  path: string;
  rangeId: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  severity: ReviewFindingSeverity;
  category: ReviewFindingCategory;
  confidence: number;
  evidenceSnippet: string;
  suggestedFix?: string;
  semanticAnchor?: string;
  fingerprintHint?: string;
};

export type PrReview = {
  summary: {
    body: string;
  };
  inlineFindings: ReviewFinding[];
  metadata?: Record<string, unknown>;
};

export type DroppedFinding = {
  finding: ReviewFinding;
  reason: string;
};

export type ValidatedReview = {
  review: PrReview;
  validFindings: ReviewFinding[];
  droppedFindings: DroppedFinding[];
};

export type RegistryCollectionName =
  | "presets"
  | "workflows"
  | "blocks"
  | "agents"
  | "schemas"
  | "comments"
  | "tools";

export type RegistryEntry = {
  id: string;
  description: string;
  source: string;
  sourceLocation?: string;
};

export type WorkflowStep = {
  block: string;
  with?: unknown;
  output?: string;
};

export type WorkflowRegistryEntry = RegistryEntry & {
  events: string[];
  steps: WorkflowStep[];
};

export type BlockRegistryEntry = RegistryEntry & {
  steps?: WorkflowStep[];
};

export type RuntimeRegistry = {
  presets: RegistryEntry[];
  workflows: WorkflowRegistryEntry[];
  blocks: BlockRegistryEntry[];
  agents: RegistryEntry[];
  schemas: RegistryEntry[];
  comments: RegistryEntry[];
  tools: RegistryEntry[];
};

export type RuntimeModuleSet = Partial<{
  presets: RegistryEntry[];
  workflows: WorkflowRegistryEntry[];
  blocks: BlockRegistryEntry[];
  agents: RegistryEntry[];
  schemas: RegistryEntry[];
  comments: RegistryEntry[];
  tools: RegistryEntry[];
}>;
