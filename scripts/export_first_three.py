#!/usr/bin/env python3
"""Export code, completed ETTh1/NP/PJM results and reusable shared libraries.

Uses SQLite online backups, copies available artifacts without changing the
live experiment, and records missing historical files instead of inventing them.
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import urllib.parse

TASKS = {
    "ETTh1": "rtsk_145b4df5f001pR33ilpdvVADfh",
    "NP": "rtsk_14896680e001oG813AX9x0QbJG",
    "PJM": "rtsk_14a376dd50014Mqo3yiCh8FBNr",
}
SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".turbo", "dist", ".vscode", ".claude"}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def readonly(path):
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    return db


def backup(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    with readonly(source) as src, sqlite3.connect(target) as dst:
        src.backup(dst, pages=256, sleep=0.01)
        assert dst.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def copy_tree(source, target):
    if not source.exists():
        return
    if source.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        return
    for directory, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not (Path(directory) / d).is_symlink()]
        for name in files:
            file = Path(directory) / name
            if file.is_symlink() or name.endswith(("-wal", "-shm", ".pyc", ".pyo")):
                continue
            if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
                continue
            destination = target / file.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if name.endswith((".db", ".sqlite", ".sqlite3")):
                try:
                    backup(file, destination)
                    continue
                except sqlite3.DatabaseError:
                    pass
            shutil.copy2(file, destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New bundle directory, outside the source checkout")
    parser.add_argument("--experience-db", type=Path, default=Path.home() / ".neo-research/experience.db")
    parser.add_argument("--archive", action="store_true", help="Also create a gzip level-1 tar archive")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    out = args.output.expanduser().resolve()
    if out == root or root in out.parents:
        raise SystemExit("Output must be outside the source checkout")
    if out.exists():
        raise SystemExit("Output already exists; choose a new directory")
    out.mkdir(parents=True)
    started = now()
    print(started, "Snapshotting completed tasks and shared libraries", flush=True)
    db = readonly(root / ".neo-research/runtime/xdg/data/neo-research/opencode-local.db")
    db.execute("BEGIN")
    ids = list(TASKS.values())
    marks = ",".join("?" for _ in ids)
    tasks = [dict(row) for row in db.execute(f"SELECT * FROM research_task WHERE id IN ({marks})", ids)]
    if len(tasks) != 3 or any(row["status"] != "completed" for row in tasks):
        raise SystemExit("All selected tasks must exist and be completed")
    exports = out / "exports"
    (exports / "results").mkdir(parents=True)
    result_db = sqlite3.connect(exports / "results/research.sqlite")
    tables = {}
    for schema in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'research_%'").fetchall():
        table = schema["name"]
        columns = [row["name"] for row in db.execute(f'PRAGMA table_info("{table}")')]
        if "task_id" not in columns and table != "research_task":
            continue
        key = "id" if table == "research_task" else "task_id"
        rows = [dict(row) for row in db.execute(f'SELECT * FROM "{table}" WHERE "{key}" IN ({marks})', ids)]
        tables[table] = rows
        result_db.execute(schema["sql"])
        if rows:
            result_db.executemany(f'INSERT INTO "{table}" VALUES ({",".join("?" for _ in columns)})',
                                  [tuple(row[column] for column in columns) for row in rows])
        jsonl(exports / "results" / (table + ".jsonl"), rows)
    result_db.commit()
    assert result_db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    result_db.close()
    db.rollback()
    db.close()
    backup(args.experience_db, out / ".neo-research/experience.db")
    backup(root / "neo_cast/.neo-cast/literature-knowledge/knowledge.db", out / "neo_cast/.neo-cast/literature-knowledge/knowledge.db")

    print(now(), "Copying current code, data, source papers and retained artifacts", flush=True)
    for child in root.iterdir():
        if child.name in SKIP_DIRS | {".neo-research", ".neo-cast", "dataset", "opencode.json"} or child.name.startswith(".env"):
            continue
        if child.name == "neo_cast":
            for entry in child.iterdir():
                if entry.name == ".neo-cast" or entry.name in SKIP_DIRS or entry.is_symlink():
                    continue
                copy_tree(entry, out / child.name / entry.name)
        else:
            copy_tree(child, out / child.name)
    # Provider wiring is useful; authentication is supplied by the receiving user.
    config = json.loads((root / "opencode.json").read_text())
    for provider in config.get("provider", {}).values():
        options = provider.get("options", {})
        for key in list(options):
            if any(term in key.lower() for term in ("apikey", "token", "password", "secret")):
                options[key] = "{env:DEEPSEEK_API_KEY}" if key == "apiKey" else ""
    dump(out / "opencode.json", config)
    for dataset in TASKS:
        copy_tree(root / "dataset" / (dataset + ".csv"), out / "dataset" / (dataset + ".csv"))
    runtime = Path("neo_cast/.neo-cast")
    # The DB has already been backed up consistently. Keep its source contexts,
    # immutable extraction/review revisions, PDFs and catalog next to it.
    for part in ["documents", "principle-runs", "runs"]:
        rel = runtime / "literature-knowledge" / part
        copy_tree(root / rel, out / rel)
    for part in ["literature-source", "literature-reruns"]:
        copy_tree(root / runtime / part, out / runtime / part)
    copy_tree(root / runtime / "literature-retrieval/preview-cache", out / runtime / "literature-retrieval/preview-cache")
    for base in (root / ".neo-research").iterdir():
        if base.name in {"runtime", "agent-control"} or not base.is_dir():
            continue
        for tid in ids:
            copy_tree(base / tid, out / ".neo-research" / base.name / tid)

    artifact_index, missing = [], []
    retrieval_dirs = set()
    for row in tables["research_artifact"]:
        parsed = urllib.parse.urlparse(row["uri"])
        source = Path(urllib.parse.unquote(parsed.path)) if parsed.scheme == "file" else None
        relative = source.relative_to(root) if source is not None and source.is_relative_to(root) else None
        entry = {"id": row["id"], "taskID": row["task_id"], "runID": row["run_id"], "kind": row["kind"],
                 "originalURI": row["uri"], "relativePath": str(relative) if relative else None,
                 "available": bool(source and source.exists())}
        artifact_index.append(entry)
        if not entry["available"]:
            missing.append(entry)
        elif relative is not None:
            if "literature-retrieval/runs" in str(relative):
                retrieval_dirs.add(Path(*relative.parts[:relative.parts.index("runs") + 2]))
            if not (out / relative).exists():
                copy_tree(source, out / relative)
    for rel in retrieval_dirs:
        copy_tree(root / rel, out / rel)
    jsonl(exports / "artifact-index.jsonl", artifact_index)
    dump(exports / "missing-artifacts.json", missing)

    with readonly(out / ".neo-research/experience.db") as experience:
        counts = {}
        for row in experience.execute("SELECT name FROM sqlite_master WHERE type='table'"):
            table = row[0]
            rows = [dict(item) for item in experience.execute(f'SELECT * FROM "{table}"')]
            jsonl(exports / "experience" / (table + ".jsonl"), rows)
            counts[table] = len(rows)
        scoped = []
        for row in experience.execute(f"SELECT e.*,o.thread_id,t.organization_json AS thread_organization_json,c.status AS curation_status FROM research_experience e LEFT JOIN research_experience_organization o ON o.experience_id=e.id LEFT JOIN research_experience_thread t ON t.thread_id=o.thread_id LEFT JOIN research_experience_curation c ON c.experience_id=e.id WHERE e.task_id IN ({marks})", ids):
            value = dict(row)
            for key in ["memory_json", "thread_organization_json"]:
                if value.get(key): value[key] = json.loads(value[key])
            scoped.append(value)
        jsonl(exports / "experience/first_three_structured.jsonl", scoped)
        curation = dict(experience.execute("SELECT coalesce(status,'unreviewed'),count(*) FROM research_experience_curation GROUP BY status").fetchall())
    with readonly(out / runtime / "literature-knowledge/knowledge.db") as knowledge:
        cards = [json.loads(row[0]) for row in knowledge.execute("SELECT card_json FROM kb_principle WHERE active=1 ORDER BY knowledge_id")]
        jsonl(out / runtime / "literature-knowledge/exports/knowledge_cards_v2.jsonl", cards)
        kb_counts = {row[0]: knowledge.execute(f'SELECT count(*) FROM "{row[0]}"').fetchone()[0]
                     for row in knowledge.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}

    labels = {value: key for key, value in TASKS.items()}
    candidates = {row["id"]: row for row in tables["research_candidate"]}
    runs = []
    for row in tables["research_run"]:
        metrics = json.loads(row["metrics"] or "{}")
        resource = json.loads(row["resource_usage"] or "{}")
        candidate = candidates.get(row["candidate_id"], {})
        spec = json.loads(candidate.get("candidate_spec", "{}"))
        runs.append({"dataset": labels[row["task_id"]], "run_id": row["id"], "candidate_id": row["candidate_id"],
                     "stage": row["stage"], "status": row["status"], "backbone": spec.get("backbone", {}).get("type"),
                     "independent_evidence": resource.get("independentEvidence", True), "duplicate_experiment": resource.get("duplicateExperiment", False),
                     "duration_seconds": ((row["time_finished"] - row["time_started"]) / 1000) if row["time_finished"] and row["time_started"] else None,
                     "metrics_json": row["metrics"], "error": row["error"], **metrics})
    columns = list(dict.fromkeys(key for row in runs for key in row))
    with (exports / "results/all_runs.csv").open("w", newline="", encoding="utf-8-sig") as output:
        writer = csv.DictWriter(output, fieldnames=columns);writer.writeheader();writer.writerows(runs)
    summary = []
    for name, tid in TASKS.items():
        cycle = next(row for row in tables["research_cycle"] if row["task_id"] == tid)
        task_runs = [row for row in runs if row["dataset"] == name]
        full = [row for row in task_runs if row["stage"] == "full" and row["status"] == "succeeded" and row["independent_evidence"] and not row["duplicate_experiment"]]
        best = min((row for row in full if "cv_avg_mse" in row), key=lambda row: row["cv_avg_mse"])
        test = next(row for row in task_runs if row["stage"] == "ref_test" and row["status"] == "succeeded")
        summary.append({"dataset": name, "task_id": tid, "iterations": cycle["iterations"], "independent_full_runs": len(full),
                        "all_run_records": len(task_runs), "best_cv_mse": best["cv_avg_mse"], "best_cv_mae": best.get("cv_avg_mae"),
                        "test_mse": test.get("ref_test_avg_mse"), "test_mae": test.get("ref_test_avg_mae"), "best_run_id": best["run_id"]})
    dump(exports / "results/summary.json", summary)
    with (exports / "results/summary.csv").open("w", newline="", encoding="utf-8-sig") as output:
        writer = csv.DictWriter(output, fieldnames=list(summary[0]));writer.writeheader();writer.writerows(summary)
    dump(exports / "manifest.json", {"schemaVersion": "neoresearch_reusable_export.v1", "snapshotStartedAt": started,
         "snapshotFinishedAt": now(), "sourceRoot": str(root), "tasks": TASKS, "results": summary,
         "researchTableCounts": {key: len(value) for key, value in tables.items()},
         "experience": {"rawCount": counts["research_experience"], "firstThreeCount": len(scoped), "tableCounts": counts, "curation": curation},
         "knowledge": {"activeCards": len(cards), "tableCounts": kb_counts, "pdfFiles": len(list((out / runtime / "literature-source/pdfs").glob("*.pdf")))},
         "artifacts": {"references": len(artifact_index), "missing": len(missing), "missingByKind": dict(collections.Counter(row["kind"] for row in missing))},
         "excluded": ["provider credentials", "environment files", "dependency installations and virtualenv", "live runtime/chat database", "mopex task results"],
         "historicalPaths": "Immutable evidence preserves original paths; initialize_export.py creates a separate artifact locator and relocates operational source catalog paths."})
    readme = '''# 前三个数据集可复用导出包

此目录包含导出时的 NeoResearch-zero 源码，ETTh1、NP、PJM 的全部运行记录、候选、指标、训练曲线、报告、保留的权重/导出模型，以及共享经验和文献知识完整快照。共享库保留此前所有数据集和项目的积累，不仅限于本次三个任务；三任务经验另见 `exports/experience/first_three_structured.jsonl`。导出是快照，原实验继续运行。

## 快速查看

- `exports/results/summary.csv`：三个数据集的 CV、测试集 MSE/MAE。
- `exports/results/all_runs.csv`：包含成功、失败、重复、冒烟及测试阶段的全部运行指标。
- `exports/results/research.sqlite` 和同目录 JSONL：三个已完成任务的研究记录；用于离线查询，不用作新副本的运行数据库。
- `exports/experience/`：原始经验、组织关系、三层结构、整理决定和演化历史；实际可召回条数以读取器验证为准。
- `.neo-research/experience.db`：新任务直接复用的完整共享经验库。
- `neo_cast/.neo-cast/literature-knowledge/`：知识库、卡片、原文切块和修订/审查记录。
- `neo_cast/.neo-cast/literature-source/`：原始 PDF 和文献目录。
- `exports/artifact-index.jsonl`：全部产物索引；`exports/missing-artifacts.json`：原环境已清理的历史文件，不存在于导出包。

## 在新位置使用

需要 Bun、Node.js、Python；依赖和密钥按新机器配置。源码与库已在同一目录，无须导入用户级全局经验库。

```bash
python3 scripts/initialize_export.py
cd opencode && bun install --frozen-lockfile && cd ..
cd neo_cast && npm ci && node bin/neo-cast.js init-runtime && cd ..
bash scripts/reuse_export.sh research experiences --path
bash scripts/reuse_export.sh research experiences --domain tsf --limit 5
bun scripts/verify_export.ts
bash scripts/reuse_export.sh
```

`reuse_export.sh` 默认使用包内经验库、包内文献库、独立的新运行数据库和四折并行；不带参数时启动界面，新任务按现有 CLI 流程运行。需要调用模型时自行配置 provider API key；导出不包含原环境密钥。知识的来源校验和经验召回规则与源码保持一致，卡片、经验事实和封印未重写。

原文引用中的历史绝对路径保留原样以保护可追溯性。初始化会生成 `exports/artifact-locations.jsonl` 作为当前目录下的产物导航；不会重写历史任务数据库，也不会自动恢复历史会话。直接复用知识和经验不依赖原任务数据库或原项目路径。

Mamba CUDA 扩展需在新机器按 `neo_cast/README.md` 构建；`auto` 后端会根据运行环境选择。参考后端及 CPU 路径可用。运行 `python3 scripts/export_first_three.py --output /absolute/new-directory --archive` 可再次导出这三个固定任务（需要原研究运行数据库）。
'''
    (out / "EXPORT_README.md").write_text(readme)
    for name in ["reuse_export.sh", "export_first_three.py"]:
        (out / "scripts" / name).chmod(0o755)
    print(now(), "Bundle created", str(out), flush=True)
    if args.archive:
        archive = out.with_name(out.name + ".tar.gz")
        subprocess.run(["tar", "-I", "gzip -1", "-cf", str(archive), "-C", str(out.parent), out.name], check=True)
        dump(archive.with_name(archive.name + ".sha256.json"), {"file": archive.name, "sha256": sha(archive), "bytes": archive.stat().st_size})
        print(now(), "Archive created", str(archive), archive.stat().st_size, flush=True)


if __name__ == "__main__":
    main()
