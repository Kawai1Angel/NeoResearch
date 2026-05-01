/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import {
  createResearchSlashSelection,
  ResearchSlashMenu,
  moveSlashSelection,
  resetResearchSlashMenuSelectionForTest,
  resolveSlashOption,
  slashOptionMatches,
  type SlashOption,
} from "../../../src/cli/cmd/tui/routes/research-slash-menu"

const colors = {
  panel: "#101214",
  border: "#2f3336",
  text: "#f2f4f8",
  textMuted: "#8b949e",
  primary: "#8ccf7e",
}

function SlashMenuHarness(props: { options: SlashOption[]; selection?: ReturnType<typeof createResearchSlashSelection> }) {
  const [value] = createSignal("/")

  return <ResearchSlashMenu value={value()} options={() => props.options} colors={colors} selection={props.selection} />
}

afterEach(() => {
  resetResearchSlashMenuSelectionForTest()
})

test("slash popup moves the current selection with arrow keys and shows its description", async () => {
  const options = [
    { display: "/alpha", description: "Alpha description" },
    { display: "/bravo", description: "Bravo description" },
    { display: "/charlie", description: "Charlie description" },
  ]
  const selection = createResearchSlashSelection()
  const app = await testRender(
    () => <SlashMenuHarness options={options} selection={selection} />,
    { width: 80, height: 18 },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Selected /alpha Alpha description")

    app.mockInput.pressArrow("down")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Selected /bravo Bravo description")
    expect(resolveSlashOption("/", options, selection)?.display).toBe("/bravo")

    app.mockInput.pressArrow("up")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Selected /alpha Alpha description")
  } finally {
    app.renderer.destroy()
  }
})

test("slash popup windows long command lists around the current selection", async () => {
  const options = Array.from({ length: 10 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0")
    return {
      display: `/cmd-${number}`,
      description: `Command ${number} details`,
    }
  })

  const app = await testRender(() => <SlashMenuHarness options={options} />, { width: 80, height: 20 })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("1-8/10")

    for (let index = 0; index < 8; index++) {
      app.mockInput.pressArrow("down")
      await app.renderOnce()
    }

    const frame = app.captureCharFrame()
    expect(frame).toContain("Selected /cmd-09 Command 09 details")
    expect(frame).toContain("3-10/10")
    expect(frame).not.toContain("/cmd-01")
  } finally {
    app.renderer.destroy()
  }
})

test("slash selection state can be isolated between menu controllers", () => {
  const options = [
    { display: "/alpha", description: "Alpha description" },
    { display: "/bravo", description: "Bravo description" },
    { display: "/charlie", description: "Charlie description" },
  ]
  const first = createResearchSlashSelection()
  const second = createResearchSlashSelection()

  moveSlashSelection("/", options, 1, first)

  expect(resolveSlashOption("/", options, first)?.display).toBe("/bravo")
  expect(resolveSlashOption("/", options, second)?.display).toBe("/alpha")
})

test("slash popup ranks prefix matches before substring priority matches", () => {
  const options = [
    { display: "/next", description: "Run recommended research action" },
    { display: "/export", description: "Export final bundle" },
    { display: "/exit", description: "Exit the app" },
    { display: "/task-next", description: "Select next research task" },
  ]

  expect(slashOptionMatches("/ex", options).map((option) => option.display)).toEqual([
    "/export",
    "/exit",
    "/next",
    "/task-next",
  ])
  expect(resolveSlashOption("/ex", options)?.display).toBe("/export")
})
