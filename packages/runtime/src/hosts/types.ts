import type { InlinePublicationItem, PublicationPlan } from "../review/comment.js";
import type { PublicationResult } from "../review/publication-result.js";
import type {
  ChangeRequestEventContext,
  ChangeRequestRef,
  CommandPermissionLevel,
  RepositoryRef,
} from "../types.js";

export type HostEventParseOptions = {
  eventPath: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
};

export type CommandCommentEvent = {
  eventName: string;
  action?: string;
  rawAction?: string;
  repository: RepositoryRef;
  changeNumber: number;
  isChangeRequest: boolean;
  body: string;
  actor: string;
  workspace: string;
};

export type LoadedChangeRequest = {
  repository: RepositoryRef;
  change: ChangeRequestRef;
  eventName?: string;
  action?: string;
  rawAction?: string;
  workspace?: string;
};

export type RepositoryPermission = CommandPermissionLevel | "none";

export type CodeHostAdapter = {
  id: string;
  parseEvent(options: HostEventParseOptions): Promise<ChangeRequestEventContext>;
  loadChangeRequest(ref: {
    repository: RepositoryRef;
    changeNumber: number;
    workspace?: string;
    eventName?: string;
    action?: string;
    rawAction?: string;
  }): Promise<LoadedChangeRequest>;
  resolveCommandComment(options: HostEventParseOptions): Promise<CommandCommentEvent>;
  getRepositoryPermission(options: {
    repository: RepositoryRef;
    actor: string;
  }): Promise<RepositoryPermission>;
  ensureHeadCheckout(options: { rootDir: string; change: ChangeRequestEventContext }): void;
  publish(options: {
    plan: PublicationPlan;
    change: ChangeRequestEventContext;
  }): Promise<PublicationResult>;
  mapInlineLocation(item: InlinePublicationItem, change: ChangeRequestEventContext): unknown;
  ensureWorkspaceSafeDirectory?(options: { rootDir: string; env?: NodeJS.ProcessEnv }): void;
};
