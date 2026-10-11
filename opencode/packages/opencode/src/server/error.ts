import { resolver } from "hono-openapi"
import z from "zod"
import { NotFoundError } from "../storage"

export function researchErrorStatus(name: string): 400 | 500 {
  return [
    "ResearchTaskSpecValidationError",
    "ResearchCandidateValidationError",
    "ResearchBudgetExceededError",
    "ResearchApprovalRequiredError",
  ].includes(name) ? 400 : 500
}

export const ERRORS = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(
          z
            .object({
              data: z.any(),
              errors: z.array(z.record(z.string(), z.any())),
              success: z.literal(false),
            })
            .meta({
              ref: "BadRequestError",
            }),
        ),
      },
    },
  },
  404: {
    description: "Not found",
    content: {
      "application/json": {
        schema: resolver(NotFoundError.Schema),
      },
    },
  },
} as const

export function errors(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, ERRORS[code as keyof typeof ERRORS]]))
}
