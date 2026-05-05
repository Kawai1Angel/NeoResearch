##  Result release standard：结果发布要有 manifest

ResultPublisher Agent 最终发布的不是一份报告，而是一个完整研究交付包。建议每次发布都生成 `artifact_manifest.json`，记录所有产物。

例如：

```
{
  "task_id": "tsf_energy_001",
  "best_model": "model/checkpoint.pt",
  "model_code": "model/model.py",
  "config": "experiments/run_006/config.yaml",
  "metrics": "experiments/run_006/metrics.csv",
  "report": "release/final_report.md",
  "reproducibility": {
    "seed": 42,
    "dataset_version": "v1",
    "environment": "requirements.txt"
  }
}
```

这会让 NeoResearch 的输出真正可交付、可复现、可审计。