"""Training-entry deduplication shared by CLI, mutations and research clients."""
from __future__ import annotations

import functools
import json
import os
from pathlib import Path
import threading

from recipe_identity import ExperimentStore, digest, file_digest, recipe_identity


def training_identity(candidate: dict, *, protocol: dict | None = None):
    import torch
    import prepare_tsf as data
    root = Path(__file__).parent
    files = sorted(p for p in root.rglob("*.py") if "tests" not in p.parts and "__pycache__" not in p.parts)
    runtime = digest({str(p.relative_to(root)): file_digest(p) for p in files})
    recipe = candidate["model_config"]["recipe"]
    input_spec = {**candidate["task"], "target_columns": list(data.ACTIVE_SPEC.target_columns),
                  "past_columns": list(data.PAST_COVARIATE_COLUMNS)}
    if recipe.get("fusion", {}).get("topology_artifact"):
        # canonical identity hashes the external adjacency bytes as well.
        input_spec["topology_sha256"] = file_digest(recipe["fusion"]["topology_artifact"])
    optional_backends = []
    branches = [recipe, recipe.get("composition", {}).get("secondary", {})]
    for branch in branches:
        backbone = branch.get("backbone", {})
        if backbone.get("type") == "mamba" and backbone.get("backend") in {"auto", "cuda_optimized"}:
            from factory.encoders.mamba_scan import select_backend, extension_fingerprint
            selected, reason = select_backend(backbone["backend"], torch.device("cuda" if torch.cuda.is_available() else "cpu"), backbone["d_state"])
            optional_backends.append({"requested": backbone["backend"], "selected": selected, "fallbackReason": reason,
                                      "extension": extension_fingerprint() if selected == "cuda_optimized" else None})
    return recipe_identity(recipe, input_spec=input_spec, experiment={
        "data_digest": {"train": file_digest(data.TRAIN_DATA_PATH), "visible": file_digest(data.VISIBLE_DATA_PATH)},
        "split_protocol": {"preprocess": data.build_preprocess_spec(), "protocol": protocol,
                           "overrides": {k: v for k, v in os.environ.items() if k.startswith("NEO_CAST_") and ("ROWS" in k or "FOLD" in k)}},
        "backend": {"device": "cuda" if torch.cuda.is_available() else "cpu", "torch": str(torch.__version__),
                    "cuda": torch.version.cuda, "device_name": torch.cuda.get_device_name() if torch.cuda.is_available() else "cpu",
                    "threads": torch.get_num_threads(), **({"mamba_scans": optional_backends} if optional_backends else {})},
        "precision": "float32", "runtime_digest": runtime,
        "resolved_training": candidate["train_config"], "resolved_constraints": candidate["constraints"],
    })


def verify_cached_contract(candidate, kwargs, result):
    import torch
    from factory.build_model import build_model
    from execution_contract import load_contract, verify_models, digest
    path = kwargs.get("execution_contract_path") or os.environ.get("NEO_CAST_EXECUTION_CONTRACT")
    if not path:
        return []
    contract = load_contract(path)
    proof = json.loads(Path(kwargs.get("verification_path") or os.environ.get("NEO_CAST_CONTRACT_VERIFICATION") or "").read_text())
    if proof.get("contract_digest") != digest(contract) or proof.get("status") != "verified":
        raise ValueError("Cached reuse still requires current candidate smoke verification")
    checkpoint = torch.load(Path(result["artifact_dir"]) / "model.pt", map_location="cpu", weights_only=False)
    models = []
    for horizon, state in checkpoint["state_dicts"].items():
        model = build_model(checkpoint["candidate"]["model_config"], candidate["task"]["input_len"], int(horizon))
        model.load_state_dict(state)
        models.append(model)
    manifests, mismatches = verify_models(contract, models, kwargs.get("candidate_path") or os.environ.get("NEO_CAST_CONTRACT_CANDIDATE"), candidate)
    for manifest, horizon in zip(manifests, checkpoint["state_dicts"]):
        actual = manifest.get("actual", {})
        if actual.get("backbone") == "mamba":
            # This validates loaded weights on CPU; it does not rerun training
            # on the CPU fallback. Keep the source training backend visible.
            actual["cache_verification_device"] = "cpu"
            source = checkpoint.get("model_manifests", {}).get(horizon, {})
            actual["source_training_backend"] = source.get("backend")
            actual["source_training_backend_provenance"] = source.get("backend_provenance")
    if mismatches:
        raise ValueError(f"Cached contract mismatch: {mismatches}")
    return [*manifests, {"event": "execution_contract_verified", "status": "verified", "candidate_id": contract["candidate_id"],
                         "candidate_spec_sha256": contract["candidate_spec_sha256"], "contract_digest": digest(contract), "manifest": manifests[-1]}]


def deduplicate_training(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        candidate = kwargs["candidate"]
        protocol = kwargs.pop("identity_protocol", None)
        # Smoke always re-verifies this candidate's execution contract.
        if kwargs["smoke"] or candidate["model_family"] != "recipe_factory":
            return function(*args, **kwargs)
        identity = training_identity(candidate, protocol=protocol)
        store_path = os.environ.get("NEO_CAST_EXPERIMENT_STORE") or str(Path(kwargs["artifact_root"]) / "experiment_identity.sqlite")
        store = ExperimentStore(store_path)
        key = identity["experiment_id"]
        claim = store.claim(key)
        emit = lambda event, **payload: print(json.dumps({"event": event, **payload}), flush=True)
        emit("experiment_identity", architecture_id=identity["architecture_id"], experiment_id=key)
        if claim["status"] == "completed":
            result = claim["result"]
            for event in verify_cached_contract(candidate, kwargs, result):
                print(json.dumps(event), flush=True)
            emit("experiment_reused", experiment_id=key, source_run_id=result["run_id"], independent_evidence=False)
            emit("cv_eval_done" if result.get("cv_metrics") else "eval_done", **result["metrics"], **result.get("cv_metrics", {}))
            emit("artifact_ready", artifact_dir=result["artifact_dir"], run_id=result["run_id"], reused=True)
            emit("done", status="success", reused=True)
            return 0
        if claim["status"] == "running":
            emit("experiment_duplicate_running", experiment_id=key, independent_evidence=False)
            emit("done", status="duplicate_running")
            return 6
        stop = threading.Event()
        errors = []

        def heartbeat():
            while not stop.wait(20):
                try:
                    store.heartbeat(key, claim["owner"])
                except Exception as exc:
                    errors.append(exc)
                    return

        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()
        artifact = []
        try:
            code = function(*args, **kwargs, experiment_identity={k: identity[k] for k in ("architecture_id", "experiment_id", "normalization_revision")},
                            artifact_callback=lambda path: artifact.append(path))
            if errors:
                raise errors[0]
            if code == 0 and artifact:
                path = artifact[-1].resolve()
                files = {str(path / name): file_digest(path / name) for name in
                         ("model.pt", "resolved_candidate.json", "preprocess.json", "training_summary.json", "val_metrics.json")}
                summary = json.loads((path / "resolved_candidate.json").read_text())
                result = {"files": files, "artifact_dir": str(path), "run_id": path.name.removeprefix("run_"),
                          "source_candidate_id": summary["candidate_id"], "metrics": json.loads((path / "val_metrics.json").read_text())}
                if protocol is not None and (path / "cv_metrics.json").exists():
                    cv = json.loads((path / "cv_metrics.json").read_text())
                    result["cv_metrics"] = {k: v for k, v in cv.items() if k.startswith("cv_")}
                    result["cv_metrics"]["cv_protocol_id"] = cv["protocol"]["protocol_id"]
                    files[str(path / "cv_metrics.json")] = file_digest(path / "cv_metrics.json")
                store.finish(key, claim["owner"], result=result)
            else:
                store.finish(key, claim["owner"], error=f"training_exit_{code}")
            return code
        except BaseException as exc:
            try:
                store.finish(key, claim["owner"], error=f"{type(exc).__name__}: {exc}")
            except RuntimeError:
                pass  # A newer lease owner must not be overwritten; retain original failure.
            raise
        finally:
            stop.set()
            thread.join(timeout=2)
    return wrapped
