import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFile } from "fs/promises"

test("hypothesis evidence migration upgrades existing rows with safe defaults", async () => {
  const db = new Database(":memory:")
  try {
    db.exec("CREATE TABLE research_task (id text PRIMARY KEY)")
    db.exec(await readFile(new URL("../../migration/20260607000000_research_hypothesis/migration.sql", import.meta.url), "utf8"))
    db.exec(`INSERT INTO research_task VALUES ('task_old');
      INSERT INTO research_hypothesis
      (id, task_id, hypo_id, statement, motivation, expected_outcome, suggested_backbones, suggested_preprocessing, priority, risk, testable, time_created, time_updated)
      VALUES ('row_old', 'task_old', 'H1', 'Preserved claim', '[]', 'lower MSE', '[]', '[]', 'high', '', 1, 1, 1)`)
    db.exec(await readFile(new URL("../../migration/20260921000000_research_hypothesis_evidence/migration.sql", import.meta.url), "utf8"))
    db.exec(await readFile(new URL("../../migration/20261007000000_research_hypothesis_mechanisms/migration.sql", import.meta.url), "utf8"))
    expect(db.query("SELECT required_mechanisms FROM research_hypothesis").get()).toEqual({ required_mechanisms: "[]" })
    expect(db.query("SELECT statement, dataset_evidence_paths, literature_evidence, applicability_assumptions, falsification_criteria, evidence_level FROM research_hypothesis").get()).toEqual({
      statement: "Preserved claim", dataset_evidence_paths: "[]", literature_evidence: "[]",
      applicability_assumptions: "[]", falsification_criteria: "[]", evidence_level: "data_only",
    })
  } finally { db.close() }
})
