"""Vendored Kronos model architecture.

Source:  https://github.com/shiyu-coder/Kronos  (model/kronos.py, model/module.py)
License: MIT — Copyright (c) 2025 ShiYu. Full text in LICENSE beside this file.

WHY VENDORED rather than installed from PyPI
--------------------------------------------
The upstream architecture is also published as `kronos-model-arch`, but that
distribution hard-pins its transitive dependencies — `matplotlib==3.9.3`,
`einops==0.8.1`, `huggingface_hub==0.33.1`, `tqdm==4.67.1`, `safetensors==0.6.2`.
Those pins come from the research repo's plotting and training examples, not
from the model code: the two files here import only

    torch, numpy, pandas, einops, tqdm, huggingface_hub

and matplotlib is never touched. Installing the package would drag a pinned
plotting stack into a trading service and fight anything else in the
environment for versions.

Vendoring 53 KB of MIT-licensed source avoids all of that and makes the
inference path fully inspectable. Everything under this directory is upstream
code; the ONLY modification is `from model.module import *` → `from .module
import *` in kronos.py, so the copy resolves under its own package name.

UPDATING
--------
Re-copy model/kronos.py and model/module.py from upstream and re-apply that one
import rewrite. `teo/forecasting/kronos.py` prefers an installed `model`
package if one is present, so an external install still takes precedence.
"""

from .kronos import Kronos, KronosPredictor, KronosTokenizer

__all__ = ["Kronos", "KronosPredictor", "KronosTokenizer"]
