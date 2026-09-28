import { expect, test } from "bun:test"
import { selectCardBudget } from "../../../src/research/literature/card-budget"
import { card } from "./fixtures"

test("late-page mechanisms survive a budget filled by earlier protocol sentences", () => {
  const protocols = Array.from({ length: 35 }, (_, index) => card({ cardID: `kc_${index.toString(16).padStart(12, "0")}`, cardType: "evaluation_protocol" }))
  const mechanism = card({ cardID: "kc_ffffffffffff", cardType: "model_mechanism", problem: "Long-range temporal dependence",
    mechanism: { mechanismID: "patch", name: "patch encoder", principle: "Encode local patches and aggregate across time", components: ["patch encoder", "aggregation"] },
  })
  const result = selectCardBudget([...protocols, mechanism], 3)
  expect(result.selected).toHaveLength(3)
  expect(result.selected.map((item) => item.cardID)).toContain(mechanism.cardID)
  expect(result.omitted).toHaveLength(33)
})
