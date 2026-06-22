export type { GitHubPublicationClient } from "../hosts/github/publication.js";
export {
  createGitHubPublicationClient,
  publishGitHubPublicationPlan as publishPublicationPlan,
} from "../hosts/github/publication.js";
export type { PublicationResult } from "./publication-result.js";
export { PublicationError } from "./publication-result.js";
