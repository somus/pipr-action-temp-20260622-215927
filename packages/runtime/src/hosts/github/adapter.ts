import type { InlinePublicationItem } from "../../review/comment.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { CodeHostAdapter } from "../types.js";
import { createGitHubCommandClient, type GitHubCommandClient } from "./command.js";
import { loadGitHubIssueCommentEventContext, loadGitHubPullRequestEventContext } from "./event.js";
import { mapFindingToGithubReviewCommentLocation } from "./inline.js";
import {
  createGitHubPublicationClient,
  type GitHubPublicationClient,
  loadGitHubPriorReviewState,
  publishGitHubPublicationPlan,
} from "./publication.js";
import { ensureGitHubHeadCheckout, ensureGitHubWorkspaceSafeDirectory } from "./workspace.js";

export type GitHubHostAdapterOptions = {
  env?: NodeJS.ProcessEnv;
  commandClient?: GitHubCommandClient;
  publicationClient?: GitHubPublicationClient;
};

export function createGitHubHostAdapter(options: GitHubHostAdapterOptions = {}): CodeHostAdapter {
  const env = options.env ?? process.env;
  const commandClient = options.commandClient ?? createGitHubCommandClient(env);
  const publicationClient = options.publicationClient ?? createGitHubPublicationClient(env);

  return {
    id: "github",
    parseEvent(parseOptions) {
      return loadGitHubPullRequestEventContext(parseOptions);
    },
    async loadChangeRequest(ref) {
      const loaded = await commandClient.getPullRequest({
        repository: ref.repository,
        changeNumber: ref.changeNumber,
      });
      return {
        ...loaded,
        eventName: ref.eventName,
        action: ref.action,
        rawAction: ref.rawAction,
        workspace: ref.workspace,
      };
    },
    resolveCommandComment(parseOptions) {
      return loadGitHubIssueCommentEventContext(parseOptions);
    },
    getRepositoryPermission(options) {
      return commandClient.getRepositoryPermission(options);
    },
    ensureHeadCheckout: ensureGitHubHeadCheckout,
    publish(options) {
      return publishGitHubPublicationPlan({
        client: publicationClient,
        change: options.change,
        plan: options.plan,
      });
    },
    loadPriorReviewState(options) {
      return loadGitHubPriorReviewState({
        client: publicationClient,
        change: options.change,
      });
    },
    mapInlineLocation(item: InlinePublicationItem, _change: ChangeRequestEventContext) {
      return mapFindingToGithubReviewCommentLocation({
        finding: item.finding,
        range: item.range,
        headSha: item.reviewedHeadSha,
      });
    },
    ensureWorkspaceSafeDirectory: ensureGitHubWorkspaceSafeDirectory,
  };
}
