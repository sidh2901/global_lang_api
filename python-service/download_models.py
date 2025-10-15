#!/usr/bin/env python
"""
Utility script for downloading a Hugging Face translation model and converting it
to the CTranslate2 runtime format for low-latency inference.

Example:
    python download_models.py \
        --translation-model Helsinki-NLP/opus-mt-en-es \
        --output-dir models/opus-mt-en-es \
        --quantization int8
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from huggingface_hub import snapshot_download
from rich import print

from app.config import TRANSLATION_MODEL_DIR, TRANSLATION_MODEL_ID


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download and convert translation models for offline inference.")
    parser.add_argument(
        "--translation-model",
        default=TRANSLATION_MODEL_ID,
        help=f"Hugging Face model ID (default: {TRANSLATION_MODEL_ID}).",
    )
    parser.add_argument(
        "--output-dir",
        default=str(TRANSLATION_MODEL_DIR),
        help=f"Directory where the converted CTranslate2 model will be stored (default: {TRANSLATION_MODEL_DIR}).",
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
        help="Optional cache directory for downloaded Hugging Face files.",
    )
    parser.add_argument(
        "--revision",
        default="main",
        help="Model revision to download (default: main).",
    )
    parser.add_argument(
        "--quantization",
        default="int8",
        choices=["float32", "float16", "int8", "int8_float16", "int16"],
        help="CTranslate2 quantization type (default: int8).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite the output directory if it already exists.",
    )
    parser.add_argument(
        "--converter-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="Additional argument passed through to ct2-transformers-converter (may be repeated).",
    )
    return parser.parse_args()


def ensure_converter_cli() -> None:
    if shutil.which("ct2-transformers-converter") is None:
        raise SystemExit(
            "[red]The executable [bold]ct2-transformers-converter[/bold] was not found. "
            "Install CTranslate2 (pip install ctranslate2) and ensure your PATH is updated.[/red]"
        )


def convert_model(
    model_dir: Path,
    output_dir: Path,
    quantization: str,
    force: bool,
    extra_args: list[str],
) -> None:
    cmd = [
        "ct2-transformers-converter",
        "--model",
        str(model_dir),
        "--output_dir",
        str(output_dir),
        "--quantization",
        quantization,
        "--copy_files",
        "tokenizer.json",
        "--copy_files",
        "tokenizer_config.json",
    ]
    if force:
        cmd.append("--force")
    if extra_args:
        cmd.extend(extra_args)

    print(f"[cyan]Converting model with command:[/] {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def main() -> None:
    args = parse_args()
    ensure_converter_cli()

    output_dir = Path(args.output_dir).expanduser().resolve()
    if output_dir.exists() and not args.force:
        print(f"[red]Output directory {output_dir} already exists. Use --force to overwrite.[/red]")
        sys.exit(1)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"[green]Downloading Hugging Face model {args.translation_model} (revision {args.revision})...[/green]")
    download_path = snapshot_download(
        repo_id=args.translation_model,
        revision=args.revision,
        cache_dir=args.cache_dir,
        local_dir=None,
        local_dir_use_symlinks=True,
    )

    download_path = Path(download_path).resolve()
    print(f"[green]Download complete: {download_path}[/green]")

    print(f"[green]Converting to CTranslate2 format in {output_dir} (quantization={args.quantization})...[/green]")
    convert_model(download_path, output_dir, args.quantization, args.force, args.converter_arg)
    print("[bold green]Done![/bold green]")


if __name__ == "__main__":
    main()
