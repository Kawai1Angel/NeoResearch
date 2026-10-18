"""Build an optional wheel from unchanged official Mamba-1 scan sources.

CUDA_HOME must match torch.version.cuda. Install wheel/ninja/packaging in the
build environment first. This does not install or replace PyTorch.
Usage: python scripts/build-mamba-cuda.py bdist_wheel --dist-dir /path/to/wheels
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil

from setuptools import setup
import torch
from torch.utils.cpp_extension import BuildExtension, CUDAExtension

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "py/vendor/mamba_selective_scan"
BUILD = Path(os.environ.get("NEO_CAST_MAMBA_BUILD_ROOT", ROOT / ".neo-cast/runtime/mamba-cuda-build"))
BUILD.mkdir(parents=True, exist_ok=True)
if not (BUILD / "csrc").exists():
    (BUILD / "csrc").symlink_to(SOURCE / "csrc", target_is_directory=True)
shutil.copyfile(SOURCE / "LICENSE", BUILD / "LICENSE")
# Isolate packaging from Neo-Cast's own pyproject metadata/dependencies.
(BUILD / "pyproject.toml").write_text(
    '[build-system]\nrequires = ["setuptools", "wheel"]\nbuild-backend = "setuptools.build_meta"\n'
    '[project]\nname = "neo-cast-mamba-scan"\nversion = "0.1.0"\n')
provenance = json.loads((SOURCE / "PROVENANCE.json").read_text())
for name, expected in provenance["sourceFiles"].items():
    assert hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() == expected, f"Modified upstream source: {name}"
source_digest = hashlib.sha256(json.dumps(provenance["sourceFiles"], sort_keys=True).encode()).hexdigest()
(BUILD / "_neo_cast_mamba_scan_build.py").write_text(
    f"TORCH_VERSION = {str(torch.__version__)!r}\nCUDA_VERSION = {torch.version.cuda!r}\n"
    f"UPSTREAM_TAG = {provenance['tag']!r}\nSOURCE_DIGEST = {source_digest!r}\n")
sources = ["csrc/" + path.name for path in sorted((SOURCE / "csrc").iterdir()) if path.suffix in {".cpp", ".cu"}]
os.chdir(BUILD)
setup(name="neo-cast-mamba-scan", version="0.1.0", py_modules=["_neo_cast_mamba_scan_build"],
      package_dir={"": "."}, options={"build": {"build_lib": str(BUILD / "lib")}},
      ext_modules=[CUDAExtension("_neo_cast_selective_scan_cuda", sources=sources,
          include_dirs=[str(SOURCE / "csrc")],
          extra_compile_args={"cxx": ["-O3", "-std=c++17"],
              "nvcc": ["-O3", "-std=c++17", "--use_fast_math", "--expt-relaxed-constexpr",
                       "--expt-extended-lambda", "-U__CUDA_NO_HALF_OPERATORS__", "-U__CUDA_NO_HALF_CONVERSIONS__",
                       "-U__CUDA_NO_BFLOAT16_OPERATORS__", "-U__CUDA_NO_BFLOAT16_CONVERSIONS__",
                       "-U__CUDA_NO_BFLOAT162_OPERATORS__", "-U__CUDA_NO_BFLOAT162_CONVERSIONS__"]})],
      cmdclass={"build_ext": BuildExtension})
