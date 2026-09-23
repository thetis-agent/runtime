import { z } from "zod";

export const ExecResultSchema = z.looseObject({
  code: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});
