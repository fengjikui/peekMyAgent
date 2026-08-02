#!/usr/bin/env python3
"""Generate reproducible Xiaomi MiMo TTS voice auditions from a JSON recipe."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auditions", type=Path, required=True, help="voice audition recipe JSON")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("tmp/mimo-tts-samples"),
        help="ignored local directory for generated WAV files",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        help="optional local .env containing MIMO_API_KEY; never copied into outputs",
    )
    parser.add_argument(
        "--base-url",
        help="override MIMO_BASE_URL (defaults to the China Token Plan OpenAI endpoint)",
    )
    parser.add_argument(
        "--sample",
        action="append",
        default=[],
        help="generate only the named sample id; may be repeated",
    )
    parser.add_argument("--force", action="store_true", help="replace an existing local WAV")
    parser.add_argument("--dry-run", action="store_true", help="validate and list calls without sending them")
    return parser.parse_args()


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            continue
        values[name] = value.strip().strip("\"'")
    return values


def credentials(args: argparse.Namespace) -> tuple[str, str]:
    local_values: dict[str, str] = {}
    env_file = args.env_file
    default_local = ROOT / ".env.mimo.local"
    if env_file is None and default_local.is_file():
        env_file = default_local
    if env_file:
        if not env_file.is_file():
            raise SystemExit(f"MiMo env file does not exist: {env_file}")
        local_values = read_env_file(env_file)
    api_key = os.environ.get("MIMO_API_KEY", "").strip() or local_values.get(
        "MIMO_API_KEY", ""
    ).strip()
    if not api_key:
        raise SystemExit("MIMO_API_KEY is missing; pass --env-file or set the environment variable")
    base_url = (
        args.base_url
        or os.environ.get("MIMO_BASE_URL", "").strip()
        or local_values.get("MIMO_BASE_URL", "").strip()
        or DEFAULT_BASE_URL
    )
    return api_key, base_url.rstrip("/")


def load_recipe(path: Path) -> tuple[str, list[dict[str, object]]]:
    source = json.loads(path.read_text(encoding="utf-8"))
    if source.get("schema_version") != 1:
        raise SystemExit("voice audition recipe must use schema_version 1")
    sample_text = str(source.get("sample_text", "")).strip()
    samples = source.get("samples")
    if not sample_text or not isinstance(samples, list) or not samples:
        raise SystemExit("voice audition recipe needs sample_text and at least one sample")
    seen: set[str] = set()
    validated: list[dict[str, object]] = []
    for item in samples:
        if not isinstance(item, dict):
            raise SystemExit("every voice audition sample must be an object")
        sample_id = str(item.get("id", ""))
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", sample_id) or sample_id in seen:
            raise SystemExit(f"invalid or duplicate sample id: {sample_id!r}")
        if not str(item.get("model", "")).startswith("mimo-v2.5-tts"):
            raise SystemExit(f"unsupported TTS model in sample {sample_id}")
        if not isinstance(item.get("direction"), str) or not item["direction"].strip():
            raise SystemExit(f"sample {sample_id} needs a direction")
        if "sample_text" in item and (
            not isinstance(item["sample_text"], str) or not item["sample_text"].strip()
        ):
            raise SystemExit(f"sample {sample_id} has an invalid sample_text override")
        seen.add(sample_id)
        validated.append(item)
    return sample_text, validated


def request_body(sample: dict[str, object], sample_text: str) -> dict[str, object]:
    audio: dict[str, object] = {"format": "wav"}
    voice = str(sample.get("voice", "")).strip()
    if voice:
        audio["voice"] = voice
    spoken_text = str(sample.get("sample_text", sample_text)).strip()
    return {
        "model": sample["model"],
        "messages": [
            {"role": "user", "content": sample["direction"]},
            {"role": "assistant", "content": spoken_text},
        ],
        "audio": audio,
    }


def send_tts(api_key: str, base_url: str, body: dict[str, object]) -> bytes:
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"api-key": api_key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:800]
        detail = detail.replace(api_key, "<redacted>")
        raise SystemExit(f"MiMo TTS returned HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"MiMo TTS request failed: {error.reason}") from error
    try:
        encoded = payload["choices"][0]["message"]["audio"]["data"]
        audio = base64.b64decode(encoded, validate=True)
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise SystemExit("MiMo TTS response did not contain valid base64 audio") from error
    if not audio.startswith(b"RIFF"):
        raise SystemExit("MiMo TTS response was not a WAV file")
    return audio


def main() -> int:
    args = parse_args()
    sample_text, samples = load_recipe(args.auditions)
    requested = set(args.sample)
    known = {str(sample["id"]) for sample in samples}
    unknown = requested - known
    if unknown:
        raise SystemExit(f"unknown sample ids: {', '.join(sorted(unknown))}")
    selected = [sample for sample in samples if not requested or sample["id"] in requested]
    if args.dry_run:
        for sample in selected:
            print(f"{sample['id']}: {sample['model']} / {sample.get('voice', 'voice design')}")
        return 0

    api_key, base_url = credentials(args)
    output_dir = args.output_dir if args.output_dir.is_absolute() else ROOT / args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    for sample in selected:
        target = output_dir / f"{sample['id']}.wav"
        display_target = target.relative_to(ROOT) if target.is_relative_to(ROOT) else target
        if target.exists() and not args.force:
            print(f"skip {display_target} (already exists)")
            continue
        print(f"generate {sample['id']} ({sample.get('voice', 'voice design')})", flush=True)
        audio = send_tts(api_key, base_url, request_body(sample, sample_text))
        temporary = target.with_suffix(".wav.tmp")
        temporary.write_bytes(audio)
        temporary.replace(target)
        print(f"wrote {display_target} ({len(audio)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
