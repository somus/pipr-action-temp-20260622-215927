import { describe, expect, it } from "bun:test";
import { buildPiprPlan, definePipr } from "@pipr/sdk";
import {
  parsePlanCommandInput,
  selectChangeRequestTasks,
  selectLocalTask,
  selectPlanCommand,
  selectRuntimeTasks,
} from "../task-selection.js";

describe("Task Selection", () => {
  it("selects change-request tasks in plan order from normalized actions", () => {
    const plan = testPlan();

    expect(selectChangeRequestTasks(plan, { action: "updated" }).map((task) => task.name)).toEqual([
      "review",
      "audit",
    ]);
    expect(
      selectRuntimeTasks({ plan, event: { action: "ready" } }).map((task) => task.name),
    ).toEqual(["ready"]);
  });

  it("selects local tasks by registered local name", () => {
    const plan = testPlan();

    expect(selectLocalTask(plan, "review")?.task.name).toBe("review");
    expect(
      selectRuntimeTasks({ plan, event: {}, taskName: "audit" }).map((task) => task.name),
    ).toEqual(["audit"]);
  });

  it("matches command lines and parses command input", () => {
    const plan = testPlan();
    const selected = selectPlanCommand(plan, "@pipr review --focus security");

    expect(selected).toMatchObject({
      kind: "matched",
      commandName: "review",
      arguments: { focus: "security" },
    });
    if (selected?.kind !== "matched") {
      throw new Error("test command did not match");
    }
    expect(parsePlanCommandInput(selected.command, selected.arguments)).toEqual({
      focus: "security",
    });
  });

  it("returns invalid command matches before falling through to help", () => {
    expect(selectPlanCommand(testPlan(), "@pipr review --focus")).toMatchObject({
      kind: "invalid",
    });
  });
});

function testPlan() {
  return buildPiprPlan(
    definePipr((pipr) => {
      const review = pipr.task({ name: "review", run() {} });
      const audit = pipr.task({ name: "audit", run() {} });
      const ready = pipr.task({ name: "ready", run() {} });
      pipr.on.changeRequest({ actions: ["updated"], task: review });
      pipr.on.changeRequest({ actions: ["updated"], task: audit });
      pipr.on.changeRequest({ actions: ["ready"], task: ready });
      pipr.local({ name: "review", task: review });
      pipr.command({
        pattern: "@pipr review --focus <focus>",
        task: review,
        parse: (values) => ({ focus: values.focus }),
      });
    }),
  );
}
