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
  it("selects change-request tasks in plan order with GitHub action mapping", () => {
    const plan = testPlan();

    expect(
      selectChangeRequestTasks(plan, { action: "synchronize" }).map((task) => task.name),
    ).toEqual(["review", "audit"]);
    expect(
      selectRuntimeTasks({ plan, event: { action: "ready_for_review" } }).map((task) => task.name),
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
      const review = pipr.task("review", () => {});
      const audit = pipr.task("audit", () => {});
      const ready = pipr.task("ready", () => {});
      pipr.on.changeRequest(["updated"], review);
      pipr.on.changeRequest(["updated"], audit);
      pipr.on.changeRequest(["ready"], ready);
      pipr.local("review", review);
      pipr.command(
        "@pipr review --focus <focus>",
        {
          parse: (values) => ({ focus: values.focus }),
        },
        review,
      );
    }),
  );
}
