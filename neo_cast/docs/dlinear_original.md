# Direct original DLinear configuration

Use `recipe_schema_v3` with `representation.latent_dim` equal to the forecast
horizon and `prediction_head.type="identity"`. The identity head has no weights
or bias. With `backbone.type="dlinear"`, this makes the seasonal and trend
linear layers map history directly to the horizon and sum their forecasts.

For a 168-step history and 24-step forecast:

```json
{
  "representation": {"layout": "channel_latent", "readout": "none", "latent_dim": 24},
  "composition": {"type": "single"},
  "preprocessing": {"actions": [{"type": "none"}]},
  "embedding": {"type": "none"},
  "backbone": {"type": "dlinear", "kernel_size": 25, "individual": false, "bias": true},
  "fusion": {"type": "temporal", "channel_mode": "independent"},
  "prediction_head": {"type": "identity", "output_distribution": "point"}
}
```

The full executable example is
[`recipe_dlinear_original.example.json`](../py/schemas/recipe_dlinear_original.example.json).
Validate it from `neo_cast/` with:

```bash
node ./bin/neo-cast.js validate recipe py/schemas/recipe_dlinear_original.example.json
```

The shared configuration has `2 * (168 * 24 + 24) = 8,112` trainable parameters.
It uses boundary replication before a 25-point moving average and ordinary
`nn.Linear` initialization, matching the
[original implementation](https://github.com/cure-lab/LTSF-Linear/blob/main/models/DLinear.py).
`individual=true` selects separate trend/seasonal projections per channel.
The dataset's training-only StandardScaler is independent of model preprocessing.

The identity head requires an explicit width equal to every requested horizon,
including secondary branches. A fixed-width recipe cannot cover unequal horizons
such as `[24,48]`; use separate configurations. Recipe v2 retains its existing
heads. A `linear` head continues to produce the previous latent-to-horizon model.

This architecture change requires a newly trained checkpoint. Existing latent
DLinear checkpoints have different parameter shapes and do not become original
DLinear by changing their configuration after training.
