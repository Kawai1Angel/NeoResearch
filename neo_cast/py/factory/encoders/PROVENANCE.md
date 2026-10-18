# Encoder mechanism references

These local PyTorch implementations target time-series encoder interfaces, not pretrained language-model compatibility or paper benchmark reproduction.

- Mamba-1 equations and parameterization: https://github.com/state-spaces/mamba/blob/e9594ce1c732d97440f0332fdc43170a2294dbfa/mamba_ssm/modules/mamba_simple.py (Apache-2.0). The reference path uses an explicit PyTorch scan and exposes recurrent state. Optional accelerated forward uses the unchanged official selective-scan CUDA/C++ sources from v2.3.2.post1, bundled with license/hashes under py/vendor/mamba_selective_scan. The local autograd adapter follows the pinned upstream forward/backward ABI and avoids unrelated Mamba-2/3 dependencies.
- TimesBlock / Inception mechanism: https://github.com/thuml/Time-Series-Library/blob/4e938a1767106324dd753b2a44832bf870a0252e/models/TimesNet.py and `layers/Conv_Blocks.py` (MIT, Copyright 2021 THUML @ Tsinghua University). Local period selection is per sample, not batch-shared. This is an encoder, not native TimesNet forecasting.
- Diagonal SSM uses a stable real diagonal transition and zero-order-hold input discretization. It is not advertised as an implementation of the complete S4/S4D training recipe.

Execution optimizations preserve these local mechanisms and parameter keys:

- Diagonal SSM's zero-state `forward` evaluates its same ZOH recurrence using a causal FFT convolution. `forward_state` retains the explicit recurrence and streaming-state interface. Floating-point summation order differs; checkpoints load without conversion, but training is not bitwise identical.
- TimesBlock groups sample/period arms with equal periods for batched convolution, then restores the original sample/rank ordering and weights. Period selection remains per sample (including tied-spectrum ordering and repeated periods), not the official batch-shared selection. Convolution batches never exceed the input batch size.
- Neither change adds recipe hyperparameters, changes readout, or reproduces the full S4D/TimesNet architecture. Runtime source fingerprints distinguish evaluations performed before and after this optimization; keep their execution provenance.

Mamba backend policy: `torch_reference` stays explicit; `auto` selects the official CUDA scan for supported CUDA/state sizes and reports any reference fallback; `cuda_optimized` fails clearly when CUDA, its verified extension, or d_state<=256 support is unavailable. `forward_state` remains the streaming reference. The regular forward preserves all parameters, projections, convolution, delta/B/C equations, gate and readout. Binary/source provenance and actual backend enter execution manifests and experiment identities.
