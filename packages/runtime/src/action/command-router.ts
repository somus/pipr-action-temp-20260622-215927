import type { RuntimePlan } from "@pipr/sdk";
import { isPiprCommandLine } from "../commands/grammar.js";
import {
  parsePlanCommandInput as parseSelectedPlanCommandInput,
  selectCommandForInvocation,
  selectPlanCommand,
} from "../config/task-selection.js";
import type { RepositoryPermission } from "../hosts/types.js";
import type { CommandPermissionLevel } from "../types.js";

const permissionOrder: CommandPermissionLevel[] = ["read", "triage", "write", "maintain", "admin"];

export type PlanCommandResolution =
  | { kind: "ignored"; reason: string }
  | {
      kind: "help";
      reason: string;
      requiredPermission: CommandPermissionLevel;
      body: string;
    }
  | {
      kind: "invalid";
      reason: string;
      requiredPermission: CommandPermissionLevel;
      body: string;
    }
  | {
      kind: "matched";
      invocation: {
        taskName: string;
        commandName: string;
        requiredPermission: CommandPermissionLevel;
        line: string;
        pattern: string;
        arguments: Record<string, string>;
        inputs?: unknown;
      };
    };

export function resolvePlanCommand(
  plan: RuntimePlan,
  line: string | undefined,
): PlanCommandResolution {
  if (!line) {
    return { kind: "ignored", reason: "comment did not contain a command line" };
  }
  if (!isPiprCommandLine(line)) {
    return { kind: "ignored", reason: "comment did not target pipr" };
  }
  const selected = selectPlanCommand(plan, line);
  if (selected?.kind === "matched") {
    return {
      kind: "matched",
      invocation: {
        taskName: selected.command.task.name,
        commandName: selected.commandName,
        requiredPermission: selected.command.permission,
        line: selected.line,
        pattern: selected.command.pattern,
        arguments: selected.arguments,
      },
    };
  }
  if (selected?.kind === "invalid") {
    return {
      kind: "invalid",
      reason: selected.error,
      requiredPermission: selected.command.permission,
      body: renderPlanCommandHelp(plan, selected.error),
    };
  }
  return {
    kind: "help",
    reason: `unknown pipr command '${line}'`,
    requiredPermission: "read",
    body: renderPlanCommandHelp(plan, `Unknown command: ${line}`),
  };
}

function renderPlanCommandHelp(plan: RuntimePlan, reason?: string): string {
  const lines = ["# pipr commands", ""];
  if (reason) {
    lines.push(reason, "");
  }
  for (const command of plan.commands) {
    lines.push(`- ${command.pattern} (${command.permission})`);
  }
  return lines.join("\n");
}

export function parsePlanCommandInputs(
  plan: RuntimePlan,
  invocation: Extract<PlanCommandResolution, { kind: "matched" }>["invocation"],
): PlanCommandResolution {
  const matchingCommand = selectCommandForInvocation(plan, invocation);
  if (!matchingCommand) {
    return {
      kind: "invalid",
      reason: `No command registered for task '${invocation.taskName}'`,
      requiredPermission: invocation.requiredPermission,
      body: renderPlanCommandHelp(plan),
    };
  }
  try {
    return {
      kind: "matched",
      invocation: {
        ...invocation,
        inputs: parseSelectedPlanCommandInput(matchingCommand, invocation.arguments),
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: "invalid",
      reason,
      requiredPermission: invocation.requiredPermission,
      body: renderPlanCommandHelp(plan, reason),
    };
  }
}

export function hasRequiredRepositoryPermission(
  actual: RepositoryPermission,
  required: CommandPermissionLevel,
): boolean {
  if (actual === "none") {
    return false;
  }
  return permissionOrder.indexOf(actual) >= permissionOrder.indexOf(required);
}

export function permissionDeniedHelp(plan: RuntimePlan, required: CommandPermissionLevel): string {
  return renderPlanCommandHelp(plan, `Permission denied: requires ${required}.`);
}
