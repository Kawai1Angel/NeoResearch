# Encoder mechanism references

These local PyTorch implementations target time-series encoder interfaces, not pretrained language-model compatibility or paper benchmark reproduction.

- Mamba-1 equations and parameterization: https://github.com/state-spaces/mamba/blob/e9594ce1c732d97440f0332fdc43170a2294dbfa/mamba_ssm/modules/mamba_simple.py (Apache-2.0). Local implementation uses an explicit PyTorch scan and exposes recurrent state; no official CUDA kernel is bundled.
- TimesBlock / Inception mechanism: https://github.com/thuml/Time-Series-Library/blob/4e938a1767106324dd753b2a44832bf870a0252e/models/TimesNet.py and `layers/Conv_Blocks.py` (MIT, Copyright 2021 THUML @ Tsinghua University). Local period selection is per sample, not batch-shared. This is an encoder, not native TimesNet forecasting.
- Diagonal SSM uses a stable real diagonal transition and zero-order-hold input discretization. It is not advertised as an implementation of the complete S4/S4D training recipe.
