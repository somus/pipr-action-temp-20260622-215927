import type { PublicationResult } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { parseChangeRequestEventContext } from "../../types.js";
import type { CodeHostAdapter } from "../types.js";

export function createLocalChangeRequestEvent(options: {
  rootDir: string;
  baseSha: string;
  headSha: string;
}): ChangeRequestEventContext {
  return parseChangeRequestEventContext({
    eventName: "local",
    action: "updated",
    platform: { id: "local" },
    repository: { slug: "local/repository" },
    change: {
      number: 1,
      title: "Local change",
      description: "",
      base: { sha: options.baseSha },
      head: { sha: options.headSha },
    },
    workspace: options.rootDir,
  });
}

export function createLocalHostAdapter(): CodeHostAdapter {
  return {
    id: "local",
    async parseEvent() {
      throw new Error("Local host adapter does not parse external events");
    },
    async loadChangeRequest() {
      throw new Error("Local host adapter does not load external change requests");
    },
    async resolveCommandComment() {
      throw new Error("Local host adapter does not resolve command comments");
    },
    async getRepositoryPermission() {
      return "admin";
    },
    ensureHeadCheckout() {},
    async publish(): Promise<PublicationResult> {
      throw new Error("Local host adapter does not publish review comments");
    },
    mapInlineLocation(item) {
      return item.range;
    },
  };
}
