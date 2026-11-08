import PROMPT_RESEARCH_PUBLISH from "./prompt/research-publish.txt"
import PROMPT_RESEARCH_LITERATURE from "./prompt/research-literature.txt"
import { Config } from "../config"
import z from "zod"
import { Provider } from "../provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "../tool"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_RESEARCH_DATA_ANALYSIS from "./prompt/research-data-analysis.txt"
import PROMPT_RESEARCH_INTENT_AGENT from "./prompt/research-intent-agent.txt"
import PROMPT_RESEARCH_HYPO_PLANNER_ZERO from "./prompt/research-hypo-planner-zero.txt"
import PROMPT_RESEARCH_HYPO_PLANNER from "./prompt/research-hypo-planner.txt"
import PROMPT_RESEARCH_REFLECTION from "./prompt/research-reflection.txt"
import PROMPT_RESEARCH_MODEL_DESIGNER from "./prompt/research-model-designer.txt"
import PROMPT_RESEARCH_OPTIMIZER from "./prompt/research-optimizer.txt"
import PROMPT_RESEARCH_REFLECTION_TRAINING from "./prompt/research-reflection-training.txt"
import PROMPT_RESEARCH_REFLECTION_ARCHITECTURE from "./prompt/research-reflection-architecture.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { zod } from "@/util/effect-zod"
import { withStatics, type DeepMutable } from "@/util/schema"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Number),
})
  .annotate({ identifier: "Agent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<{
    identifier: string
    whenToUse: string
    systemPrompt: string
  }>
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                codesearch: "allow",
                read: "allow",
                external_directory: {
                  "*": "ask",
                  ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
                },
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
          "research-publish": {
            name: "research-publish",
            description: "NeoResearch final report from a frozen, verified experiment snapshot.",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(defaults, user, Permission.fromConfig({ "*": "deny" })),
            prompt: PROMPT_RESEARCH_PUBLISH,
          },
          "research-literature": {
            name: "research-literature", description: "Bound Literature phase tools", mode: "primary", steps: 12,
            options: {}, native: true, hidden: true,
            permission: Permission.merge(defaults, user, Permission.fromConfig({
              "*": "deny", literature_run: "allow", literature_list_intents: "allow",
              literature_search: "allow", literature_read_paper: "allow", literature_get_results: "allow",
            })),
            prompt: PROMPT_RESEARCH_LITERATURE,
          },
          "research-data-analysis": {
            name: "research-data-analysis",
            description: "NeoResearch autonomous loop — qualitative dataset analysis stage. Invoked programmatically.",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                webfetch: "allow",
                analyze_dataset: "allow",
              }),
              user,
            ),
            prompt: PROMPT_RESEARCH_DATA_ANALYSIS,
          },
          "research-intent-agent": {
            name: "research-intent-agent",
            description: "NeoResearch autonomous loop — intent gathering stage. Invoked programmatically.",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read_taskspec: "allow",
                update_taskspec: "allow",
                check_taskspec: "allow",
                ask_user: "allow",
                bash: "allow",
              }),
              user,
            ),
            prompt: PROMPT_RESEARCH_INTENT_AGENT,
          },
          "research-hypo-planner": {
            name: "research-hypo-planner",
            description: "NeoResearch autonomous loop — hypothesis planning stage. Invoked programmatically.",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                webfetch: "allow",
                hypothesis_add: "allow",
                hypothesis_update: "allow",
                hypothesis_abandon: "allow",
                hypothesis_list: "allow",
                read_task_evidence: "allow",
                hypothesis_select: "allow",
                pick_baseline: "allow",
                load_baseline: "allow",
                experiment_results: "allow",
                read_reflection: "allow",
                read_experiences: "allow",
              }),
              user,
            ),
            prompt: PROMPT_RESEARCH_HYPO_PLANNER,
          },
          "research-hypo-planner-zero": {
            name: "research-hypo-planner-zero",
            description: "NeoResearch autonomous loop — hypothesis planning stage. Invoked programmatically.",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                webfetch: "allow",
                hypothesis_add: "allow",
                hypothesis_update: "allow",
                hypothesis_abandon: "allow",
                hypothesis_list: "allow",
                read_task_evidence: "allow",
                hypothesis_select: "allow",
                pick_baseline: "deny",
                load_baseline: "deny",
                experiment_results: "allow",
                read_reflection: "allow",
                read_experiences: "allow",
              }),
              user,
            ),
            prompt: PROMPT_RESEARCH_HYPO_PLANNER_ZERO,
          },
          "research-reflection": {
            name: "research-reflection",
            description: "NeoResearch autonomous loop — post-experiment reflection stage. Invoked programmatically.",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                webfetch: "allow",
                experiment_results: "allow",
                read_reflection: "allow",
                read_training_curve: "allow",
                read_memory_lessons: "allow",
                read_experiences: "allow",
                write_experience: "allow",
                read_knowledge_cards: "allow",
                read_task_evidence: "allow",
                confirm_knowledge: "allow",
              }),
              user,
            ),
            prompt: PROMPT_RESEARCH_REFLECTION,
          },
          "research-optimizer": {
            name: "research-optimizer",
            description: "OptimizerAgent — fixed-design inner-loop training optimization.",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(defaults, Permission.fromConfig({ "*": "deny" }), user),
            prompt: PROMPT_RESEARCH_OPTIMIZER,
          },
          "research-reflection-training": {
            name: "research-reflection-training",
            description: "ReflectionAgent — fixed-design trial diagnosis.",
            mode: "primary", options: {}, native: true, hidden: true,
            permission: Permission.merge(defaults, user, Permission.fromConfig({ "*": "deny" })),
            prompt: PROMPT_RESEARCH_REFLECTION_TRAINING,
          },
          "research-reflection-architecture": {
            name: "research-reflection-architecture",
            description: "ReflectionAgent — completed-design architectural evidence assessment.",
            mode: "primary", options: {}, native: true, hidden: true,
            permission: Permission.merge(defaults, user, Permission.fromConfig({ "*": "deny" })),
            prompt: PROMPT_RESEARCH_REFLECTION_ARCHITECTURE,
          },
          "research-model-designer": {
            name: "research-model-designer",
            description: "NeoResearch autonomous loop — TSF candidate design stage. Invoked programmatically.",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                webfetch: "allow",
                experiment_results: "allow",
                read_task_evidence: "allow",
                read_experiences: "allow",
                read_reflection: "allow",
                read_training_curve: "allow",
              }),
              user,
            ),
            prompt: PROMPT_RESEARCH_MODEL_DESIGNER,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent.name
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible.name
        })

        return {
          get,
          list,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: z.object({
            identifier: z.string(),
            whenToUse: z.string(),
            systemPrompt: z.string(),
          }),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Agent from "./agent"
