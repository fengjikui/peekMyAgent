#!/usr/bin/env python3
"""Build the slow README GIF candidate from reviewed storyboard frames."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PLAN = ROOT / "assets" / "demo" / "source" / "quickstart" / "readme-gif.zh-CN.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true", help="Validate the plan, sources, and existing GIF without rewriting it")
    args = parser.parse_args()

    plan_path = args.plan.resolve()
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    validate_plan(plan)

    source_directory = ROOT / plan["source_directory"]
    output = args.output.resolve() if args.output else ROOT / plan["output"]
    resolution = tuple(plan["resolution"])
    fade_ms = plan["fade_ms"]
    fade_steps = plan["fade_steps"]
    colors = plan["colors"]
    subtitle_safe_zone_top = plan.get("subtitle_safe_zone_top")

    source_frames: list[Image.Image] = []
    for shot in plan["shots"]:
        path = source_directory / shot["frame"]
        if not path.is_file():
            raise SystemExit(f"Missing reviewed frame: {path}")
        with Image.open(path) as image:
            frame = image.convert("RGB")
        if frame.size != resolution:
            raise SystemExit(
                f"Reviewed frame must be {resolution[0]}x{resolution[1]}, "
                f"found {frame.width}x{frame.height}: {path}"
            )
        source_frames.append(frame)

    expected_duration_ms = sum(shot["hold_ms"] for shot in plan["shots"])
    expected_frame_count = len(plan["shots"]) + (len(plan["shots"]) - 1) * fade_steps
    if args.check:
        verify_output(
            output,
            resolution,
            expected_duration_ms,
            plan["max_bytes"],
            expected_frame_count,
        )
        print(
            f"checked {output.relative_to(ROOT)}: {expected_frame_count} frames, "
            f"{expected_duration_ms / 1000:.1f}s, {output.stat().st_size / 1024 / 1024:.2f} MiB"
        )
        return

    gif_frames: list[Image.Image] = []
    durations: list[int] = []
    for index, (shot, frame) in enumerate(zip(plan["shots"], source_frames)):
        is_last = index == len(source_frames) - 1
        static_duration = shot["hold_ms"] if is_last else shot["hold_ms"] - fade_ms
        gif_frames.append(quantize(frame, colors))
        durations.append(static_duration)
        if is_last:
            continue

        next_frame = source_frames[index + 1]
        step_duration = fade_ms // fade_steps
        for step in range(1, fade_steps + 1):
            alpha = step / (fade_steps + 1)
            blended = Image.blend(frame, next_frame, alpha)
            if subtitle_safe_zone_top is not None:
                subtitle_source = frame if alpha < 0.5 else next_frame
                subtitle_box = (
                    0,
                    subtitle_safe_zone_top,
                    resolution[0],
                    resolution[1],
                )
                blended.paste(subtitle_source.crop(subtitle_box), subtitle_box)
            gif_frames.append(quantize(blended, colors))
            durations.append(step_duration)

    output.parent.mkdir(parents=True, exist_ok=True)
    gif_frames[0].save(
        output,
        save_all=True,
        append_images=gif_frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )

    verify_output(output, resolution, expected_duration_ms, plan["max_bytes"], expected_frame_count)
    print(
        f"{output.relative_to(ROOT)}: {len(gif_frames)} frames, "
        f"{sum(durations) / 1000:.1f}s, {output.stat().st_size / 1024 / 1024:.2f} MiB"
    )


def validate_plan(plan: dict) -> None:
    if plan.get("schema_version") != 1:
        raise SystemExit("GIF plan schema_version must be 1")
    if not isinstance(plan.get("source_directory"), str) or not plan["source_directory"]:
        raise SystemExit("GIF plan needs source_directory")
    if not isinstance(plan.get("output"), str) or not plan["output"].endswith(".gif"):
        raise SystemExit("GIF plan output must be a .gif path")
    resolution = plan.get("resolution")
    if not isinstance(resolution, list) or len(resolution) != 2 or not all(isinstance(value, int) and value > 0 for value in resolution):
        raise SystemExit("GIF plan resolution must contain two positive integers")
    if not isinstance(plan.get("shots"), list) or len(plan["shots"]) < 2:
        raise SystemExit("GIF plan needs at least two shots")
    fade_ms = plan.get("fade_ms")
    fade_steps = plan.get("fade_steps")
    if not isinstance(fade_ms, int) or fade_ms < 0:
        raise SystemExit("GIF plan fade_ms must be a non-negative integer")
    if not isinstance(fade_steps, int) or fade_steps < 1:
        raise SystemExit("GIF plan fade_steps must be a positive integer")
    if fade_ms % fade_steps != 0:
        raise SystemExit("GIF plan fade_ms must divide evenly across fade_steps")
    if not isinstance(plan.get("colors"), int) or not 32 <= plan["colors"] <= 256:
        raise SystemExit("GIF plan colors must be between 32 and 256")
    if not isinstance(plan.get("max_bytes"), int) or plan["max_bytes"] <= 0:
        raise SystemExit("GIF plan max_bytes must be positive")
    subtitle_safe_zone_top = plan.get("subtitle_safe_zone_top")
    if subtitle_safe_zone_top is not None and (
        not isinstance(subtitle_safe_zone_top, int)
        or not 0 <= subtitle_safe_zone_top < resolution[1]
    ):
        raise SystemExit("GIF plan subtitle_safe_zone_top must be inside the output height")

    seen = set()
    for index, shot in enumerate(plan["shots"]):
        if not isinstance(shot.get("frame"), str) or not shot["frame"].lower().endswith((".jpg", ".jpeg", ".png")):
            raise SystemExit(f"GIF shot {index} needs a reviewed image frame")
        if shot["frame"] in seen:
            raise SystemExit(f"GIF plan duplicates frame: {shot['frame']}")
        seen.add(shot["frame"])
        if not isinstance(shot.get("hold_ms"), int) or shot["hold_ms"] < 2500:
            raise SystemExit(f"GIF shot {index} must remain readable for at least 2500ms")
        if shot["hold_ms"] <= fade_ms:
            raise SystemExit(f"GIF shot {index} hold_ms must exceed fade_ms")
        if not isinstance(shot.get("purpose"), str) or len(shot["purpose"].strip()) < 8:
            raise SystemExit(f"GIF shot {index} needs a concrete teaching purpose")


def quantize(image: Image.Image, colors: int) -> Image.Image:
    return image.quantize(
        colors=colors,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.NONE,
    )


def verify_output(
    output: Path,
    resolution: tuple[int, int],
    expected_duration_ms: int,
    max_bytes: int,
    expected_frame_count: int,
) -> None:
    if not output.is_file():
        raise SystemExit(f"GIF output was not created: {output}")
    if output.stat().st_size > max_bytes:
        raise SystemExit(
            f"GIF exceeds {max_bytes / 1024 / 1024:.1f} MiB gate: "
            f"{output.stat().st_size / 1024 / 1024:.2f} MiB"
        )

    with Image.open(output) as image:
        if image.size != resolution:
            raise SystemExit(f"GIF output dimensions changed unexpectedly: {image.size}")
        durations = []
        frame_count = 0
        try:
            while True:
                durations.append(image.info.get("duration", 0))
                frame_count += 1
                image.seek(image.tell() + 1)
        except EOFError:
            pass
    if frame_count != expected_frame_count:
        raise SystemExit(
            f"GIF frame count must remain {expected_frame_count}, found {frame_count}"
        )
    if abs(sum(durations) - expected_duration_ms) > 100:
        raise SystemExit(
            f"GIF duration must remain {expected_duration_ms}ms, found {sum(durations)}ms"
        )


if __name__ == "__main__":
    main()
