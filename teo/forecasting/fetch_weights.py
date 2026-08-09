"""One-time Kronos weights download.

    python -m teo.forecasting.fetch_weights                  # Kronos-mini (4.1M)
    python -m teo.forecasting.fetch_weights --model small    # Kronos-small (24.7M)

Weights land under models/kronos/{model,tokenizer}. After this runs, set

    TEO_KRONOS_LOCAL_DIR=models/kronos

and inference never touches the network again — the adapter loads from those
paths directly.

This is the only step in the whole system that fetches anything one time from a
host other than the market-data feed, and it needs no account, key or signup:
the Hugging Face repositories are public and downloaded anonymously. If you
would rather not run it at all, /forecast keeps working on the baseline
forecaster; you simply do not get the learned model.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Model id → (model repo, tokenizer repo, approximate download size).
VARIANTS: dict[str, tuple[str, str, str]] = {
    "mini": ("NeoQuasar/Kronos-mini", "NeoQuasar/Kronos-Tokenizer-2k", "~20 MB"),
    "small": ("NeoQuasar/Kronos-small", "NeoQuasar/Kronos-Tokenizer-base", "~100 MB"),
    "base": ("NeoQuasar/Kronos-base", "NeoQuasar/Kronos-Tokenizer-base", "~410 MB"),
}

DEFAULT_DIR = Path("models/kronos")


def fetch(variant: str, dest: Path) -> int:
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print(
            "huggingface_hub is not installed. Install the Kronos extra:\n"
            "  pip install -e '.[kronos]'",
            file=sys.stderr,
        )
        return 1

    if variant not in VARIANTS:
        print(
            f"unknown variant {variant!r}; choose one of {', '.join(VARIANTS)}",
            file=sys.stderr,
        )
        return 1

    model_repo, tok_repo, size = VARIANTS[variant]
    print(f"Fetching Kronos-{variant} ({size}) into {dest}/ …")

    try:
        for repo, sub in ((model_repo, "model"), (tok_repo, "tokenizer")):
            target = dest / sub
            target.mkdir(parents=True, exist_ok=True)
            print(f"  {repo} → {target}")
            snapshot_download(
                repo_id=repo,
                local_dir=str(target),
                # Skip the large optional artefacts some repos carry; the config
                # plus safetensors is all the adapter loads.
                ignore_patterns=["*.msgpack", "*.h5", "*.onnx", "*.md"],
            )
    except Exception as e:
        print(f"\ndownload failed: {e}", file=sys.stderr)
        print(
            "Nothing else in the system depends on this — /forecast continues on "
            "the baseline forecaster.",
            file=sys.stderr,
        )
        return 1

    print(
        f"\nDone. Weights are local and no further network access is needed.\n\n"
        f"  export TEO_KRONOS_LOCAL_DIR={dest}\n"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Download Kronos weights for local use")
    p.add_argument(
        "--model",
        default="mini",
        choices=sorted(VARIANTS),
        help="which variant to fetch (default: mini, smallest and CPU-friendly)",
    )
    p.add_argument(
        "--dir",
        default=str(DEFAULT_DIR),
        help=f"destination directory (default: {DEFAULT_DIR})",
    )
    args = p.parse_args(argv)
    return fetch(args.model, Path(args.dir))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
