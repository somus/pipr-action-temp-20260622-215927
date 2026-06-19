import { z } from "zod";

export function createCommandRunSchema(targetIdSchema: z.ZodString) {
  return z
    .object({
      workflows: z.array(targetIdSchema).min(1).optional(),
      block: targetIdSchema.optional(),
    })
    .strict()
    .superRefine((run, context) => {
      const targets = Number(Boolean(run.workflows)) + Number(Boolean(run.block));
      if (targets !== 1) {
        context.addIssue({
          code: "custom",
          message: "Command run must specify exactly one of workflows or block",
        });
      }
    });
}

export function createCommandDefinitionSchema(
  commandIdSchema: z.ZodString,
  targetIdSchema: z.ZodString,
) {
  return z
    .object({
      id: commandIdSchema,
      aliases: z.array(z.string().min(1)).min(1),
      run: createCommandRunSchema(targetIdSchema),
    })
    .strict();
}
