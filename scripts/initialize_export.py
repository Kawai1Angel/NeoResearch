"""Relocate only operational paths; never rewrite signed cards or experiment facts."""
from pathlib import Path
import json
import os
import sqlite3


def relocate(value, root):
    if isinstance(value, dict):
        return {key: relocate(item, root) for key, item in value.items()}
    if isinstance(value, list):
        return [relocate(item, root) for item in value]
    if isinstance(value, str):
        for marker in ("/neo_cast/.neo-cast/", "/.neo-research/", "/dataset/"):
            if value.startswith(("/", "file:///")) and marker in value:
                relative = marker.lstrip("/") + value.split(marker, 1)[1]
                return ("file://" if value.startswith("file://") else "") + str(root / relative)
    return value


def initialize(root):
    manifest = root / "exports/manifest.json"
    if not manifest.exists():
        raise SystemExit("This command requires an exported bundle (exports/manifest.json).")
    state = root / "exports/relocation.json"
    if state.exists() and json.loads(state.read_text()).get("root") == str(root):
        return
    kb = root / "neo_cast/.neo-cast/literature-knowledge/knowledge.db"
    with sqlite3.connect(kb) as db:
        for row in db.execute("SELECT document_id,source_path,normalized_json_path FROM kb_document").fetchall():
            db.execute("UPDATE kb_document SET source_path=?,normalized_json_path=? WHERE document_id=?",
                       (relocate(row[1], root), relocate(row[2], root), row[0]))
    catalog = root / "neo_cast/.neo-cast/literature-source/catalog"
    for file in [*catalog.glob("*.jsonl"), *catalog.glob("*.json"),
                 root / "neo_cast/.neo-cast/literature-source/source_manifest.json"]:
        if not file.exists():
            continue
        if file.suffix == ".jsonl":
            text = "".join(json.dumps(relocate(json.loads(line), root), ensure_ascii=False) + "\n"
                           for line in file.read_text().splitlines() if line.strip())
        else:
            text = json.dumps(relocate(json.loads(file.read_text()), root), ensure_ascii=False, indent=2) + "\n"
        temporary = file.with_suffix(file.suffix + ".relocate.tmp")
        temporary.write_text(text)
        os.replace(temporary, file)
    # The historical research database and JSONL remain immutable. This separate
    # locator maps their original artifact URIs to the current bundle directory.
    rows = [json.loads(line) for line in (root / "exports/artifact-index.jsonl").read_text().splitlines() if line]
    locator = [{**row, "localPath": str(root / row["relativePath"]) if row.get("relativePath") else None} for row in rows]
    (root / "exports/artifact-locations.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in locator))
    state.write_text(json.dumps({"root": str(root)}, indent=2) + "\n")


if __name__ == "__main__":
    initialize(Path(__file__).resolve().parents[1])
