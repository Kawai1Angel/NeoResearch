"""Thin autograd adapter for the pinned official Mamba-1 CUDA scan.

SelectiveScanFn follows state-spaces/mamba v2.3.2.post1
mamba_ssm/ops/selective_scan_interface.py (Apache-2.0, Tri Dao/Albert Gu).
Only the real, variable-B/C, pre-softplus-delta interface used here is exposed.
The unchanged upstream CUDA/C++ sources and license live in py/vendor.
"""
from __future__ import annotations

from functools import lru_cache
import hashlib
import importlib
from pathlib import Path

import torch

BACKENDS = frozenset({"auto", "torch_reference", "cuda_optimized"})
UPSTREAM_TAG = "v2.3.2.post1"
SOURCE_DIGEST = "4aeecd6372d8eeb105f88caa3fdd20259dd1542d53d92c5039a673759aef24cb"


@lru_cache(maxsize=1)
def extension_status():
    try:
        metadata = importlib.import_module("_neo_cast_mamba_scan_build")
        if metadata.UPSTREAM_TAG != UPSTREAM_TAG or metadata.SOURCE_DIGEST != SOURCE_DIGEST:
            raise ImportError("Mamba scan source/ABI differs from the verified pinned implementation; rebuild it")
        if metadata.TORCH_VERSION != str(torch.__version__) or metadata.CUDA_VERSION != torch.version.cuda:
            raise ImportError("Mamba scan was built for a different PyTorch/CUDA runtime; rebuild it")
        extension = importlib.import_module("_neo_cast_selective_scan_cuda")
        if not callable(getattr(extension, "fwd", None)) or not callable(getattr(extension, "bwd", None)):
            raise ImportError("Mamba scan extension does not expose the official fwd/bwd ABI")
        return extension, None
    except (ImportError, OSError) as error:
        return None, str(error)


def select_backend(requested: str, device: torch.device, state_dim: int):
    if requested not in BACKENDS:
        raise ValueError(f"UNSUPPORTED_BACKEND: {requested}")
    if requested == "torch_reference":
        return "torch_reference", "explicit_reference_request"
    reason = ("cpu_device" if device.type != "cuda" else
              "CUDA selective scan requires d_state<=256" if state_dim > 256 else None)
    if reason is None:
        extension, reason = extension_status()
        if extension is not None:
            return "cuda_optimized", None
    if requested == "cuda_optimized":
        raise RuntimeError("MAMBA_CUDA_UNAVAILABLE: " + str(reason))
    return "torch_reference", reason


@lru_cache(maxsize=1)
def extension_fingerprint():
    extension, reason = extension_status()
    if extension is None:
        return {"available": False, "reason": reason}
    metadata = importlib.import_module("_neo_cast_mamba_scan_build")
    return {"available": True, "upstream": metadata.UPSTREAM_TAG,
            "sourceDigest": metadata.SOURCE_DIGEST, "torch": metadata.TORCH_VERSION,
            "cuda": metadata.CUDA_VERSION,
            "binarySHA256": hashlib.sha256(Path(extension.__file__).read_bytes()).hexdigest()}


class _SelectiveScan(torch.autograd.Function):
    @staticmethod
    def forward(ctx, u, delta, a, b, c, d, z):
        extension, reason = extension_status()
        if extension is None:
            raise RuntimeError("MAMBA_CUDA_UNAVAILABLE: " + str(reason))
        u, delta = u.contiguous(), delta.contiguous()
        b, c = b.unsqueeze(1).contiguous(), c.unsqueeze(1).contiguous()
        d = d.contiguous()
        z = z.contiguous() if z is not None else None
        out, intermediates, *rest = extension.fwd(u, delta, a, b, c, d, z, None, False)
        ctx.has_z = z is not None
        ctx.save_for_backward(u, delta, a, b, c, d, z, intermediates, out if ctx.has_z else None)
        return rest[0] if ctx.has_z else out

    @staticmethod
    def backward(ctx, dout):
        u, delta, a, b, c, d, z, intermediates, out = ctx.saved_tensors
        extension, _ = extension_status()
        du, ddelta, da, db, dc, dd, _, *rest = extension.bwd(
            u, delta, a, b, c, d, z, None, dout.contiguous(), intermediates, out,
            None, False, False,
        )
        return du, ddelta, da, db.squeeze(1), dc.squeeze(1), dd, rest[0] if ctx.has_z else None


def selective_scan(u, delta, a, b, c, d, z=None):
    """Official fused scan; delta already includes projection bias and softplus."""
    return _SelectiveScan.apply(u, delta, a, b, c, d, z)
