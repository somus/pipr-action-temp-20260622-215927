import type { ChangeRequestAction, RuntimePlan, Task } from "@pipr/sdk";
import { commandPatternPrefixMatches, parseCommandPattern } from "../commands/grammar.js";

export type SelectedPlanCommand =
  | {
      kind: "matched";
      command: RuntimePlan["commands"][number];
      commandName: string;
      line: string;
      arguments: Record<string, string>;
    }
  | {
      kind: "invalid";
      command: RuntimePlan["commands"][number];
      error: string;
    };

export function selectRuntimeTasks(options: {
  plan: RuntimePlan;
  event: { action?: string };
  taskName?: string;
}): Task[] {
  if (options.taskName) {
    return options.plan.tasks.filter((task) => task.name === options.taskName);
  }
  return selectChangeRequestTasks(options.plan, options.event);
}

export function selectChangeRequestTasks(plan: RuntimePlan, event: { action?: string }): Task[] {
  const action = changeRequestActionForEvent(event.action);
  if (!action) {
    return [];
  }
  return uniqueTasks(
    plan.changeRequestTriggers
      .filter((trigger) => trigger.actions.includes(action))
      .map((trigger) => trigger.task),
  );
}

export function selectLocalTask(
  plan: RuntimePlan,
  localName: string,
): RuntimePlan["locals"][number] | undefined {
  return plan.locals.find((entry) => entry.name === localName);
}

export function selectPlanCommand(
  plan: RuntimePlan,
  line: string,
): SelectedPlanCommand | undefined {
  let firstInvalid: SelectedPlanCommand | undefined;
  for (const command of plan.commands) {
    const parsed = parseCommandPattern(command.pattern, line);
    if (!parsed.ok) {
      if (commandPatternPrefixMatches(command.pattern, line) && !firstInvalid) {
        firstInvalid = { kind: "invalid", command, error: parsed.error };
      }
      continue;
    }
    return {
      kind: "matched",
      command,
      commandName: planCommandName(command.pattern),
      line,
      arguments: parsed.value,
    };
  }
  return firstInvalid;
}

export function selectCommandForInvocation(
  plan: RuntimePlan,
  invocation: { taskName: string; pattern: string },
): RuntimePlan["commands"][number] | undefined {
  return (
    plan.commands.find(
      (candidate) =>
        candidate.task.name === invocation.taskName && candidate.pattern === invocation.pattern,
    ) ?? plan.commands.find((candidate) => candidate.task.name === invocation.taskName)
  );
}

export function parsePlanCommandInput(
  command: RuntimePlan["commands"][number],
  values: Record<string, string>,
): unknown {
  return command.parse ? command.parse(values) : values;
}

function changeRequestActionForEvent(action: string | undefined): ChangeRequestAction | undefined {
  if (action === "synchronize") {
    return "updated";
  }
  if (action === "ready_for_review") {
    return "ready";
  }
  if (
    action === "opened" ||
    action === "reopened" ||
    action === "ready" ||
    action === "closed" ||
    action === "updated"
  ) {
    return action;
  }
  return undefined;
}

function uniqueTasks(tasks: Task[]): Task[] {
  return [...new Map(tasks.map((task) => [task.name, task])).values()];
}

function planCommandName(pattern: string): string {
  return pattern.replace(/^@pipr\s+/, "").split(/\s+/)[0] ?? pattern;
}
