#!/usr/bin/env python3
"""Combine a clean demo picture master, narration and readable burned subtitles."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
FONT_CANDIDATES = (
    Path("/System/Library/Fonts/STHeiti Medium.ttc"),
    Path("/System/Library/Fonts/PingFang.ttc"),
    Path("/System/Library/Fonts/Supplemental/Songti.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
)


@dataclass(frozen=True)
class Cue:
    index: int
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class SubtitleLayout:
    center_x: int
    max_width: int
    bottom_margin: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--picture", type=Path, required=True, help="clean MP4 picture master")
    parser.add_argument("--audio", type=Path, required=True, help="narration audio exported by the editor")
    parser.add_argument("--subtitles", type=Path, required=True, help="UTF-8 SRT subtitles")
    parser.add_argument("--output", type=Path, required=True, help="subtitled MP4 output")
    parser.add_argument("--layout", type=Path, help="optional per-cue subtitle layout JSON")
    parser.add_argument("--font", type=Path, help="override the subtitle font")
    parser.add_argument("--font-size", type=int, default=42)
    parser.add_argument("--bottom-margin", type=int, default=42)
    parser.add_argument("--max-width", type=int, default=1560)
    return parser.parse_args()


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=capture,
    )


def require_tools() -> None:
    missing = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    if missing:
        raise SystemExit(f"missing required tools: {', '.join(missing)}")


def select_font(requested: Path | None) -> Path:
    if requested:
        if requested.exists():
            return requested
        raise SystemExit(f"subtitle font does not exist: {requested}")
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            return candidate
    raise SystemExit("no supported subtitle font found")


def timestamp_seconds(value: str) -> float:
    match = re.fullmatch(r"(\d+):(\d+):(\d+)[,.](\d+)", value.strip())
    if not match:
        raise SystemExit(f"invalid SRT timestamp: {value}")
    hours, minutes, seconds, milliseconds = map(int, match.groups())
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000


def parse_srt(path: Path) -> list[Cue]:
    blocks = re.split(r"\n\s*\n", path.read_text(encoding="utf-8-sig").strip())
    cues: list[Cue] = []
    for block in blocks:
        lines = block.splitlines()
        if len(lines) < 3 or " --> " not in lines[1]:
            raise SystemExit(f"invalid SRT block: {block[:80]}")
        start_text, end_text = lines[1].split(" --> ", 1)
        text = "\n".join(line.strip() for line in lines[2:] if line.strip())
        cue = Cue(int(lines[0]), timestamp_seconds(start_text), timestamp_seconds(end_text), text)
        if cue.end <= cue.start or not cue.text:
            raise SystemExit(f"invalid SRT cue: {block[:80]}")
        cues.append(cue)
    return cues


def subtitle_layouts(
    path: Path | None,
    cues: list[Cue],
    width: int,
    max_width: int,
    bottom_margin: int,
) -> dict[int, SubtitleLayout]:
    default = SubtitleLayout(width // 2, max_width, bottom_margin)
    layouts = {cue.index: default for cue in cues}
    if not path:
        return layouts
    source = json.loads(path.read_text(encoding="utf-8"))
    default_source = source.get("default", {})
    default = SubtitleLayout(
        int(default_source.get("center_x", default.center_x)),
        int(default_source.get("max_width", default.max_width)),
        int(default_source.get("bottom_margin", default.bottom_margin)),
    )
    layouts = {cue.index: default for cue in cues}
    for item in source.get("ranges", []):
        layout = SubtitleLayout(
            int(item.get("center_x", default.center_x)),
            int(item.get("max_width", default.max_width)),
            int(item.get("bottom_margin", default.bottom_margin)),
        )
        for cue_index in range(int(item["start_cue"]), int(item["end_cue"]) + 1):
            if cue_index in layouts:
                layouts[cue_index] = layout
    return layouts


def probe_picture(path: Path) -> tuple[int, int, float]:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture=True,
    )
    metadata = json.loads(result.stdout)
    stream = metadata["streams"][0]
    return int(stream["width"]), int(stream["height"]), float(metadata["format"]["duration"])


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_width: int) -> str:
    lines: list[str] = []
    for paragraph in text.splitlines():
        current = ""
        for char in paragraph:
            candidate = current + char
            width = draw.textbbox((0, 0), candidate, font=font, stroke_width=4)[2]
            if current and width > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
        if current:
            lines.append(current)
    if len(lines) > 2:
        raise SystemExit(f"subtitle needs more than two lines: {text}")
    return "\n".join(lines)


def render_overlay(
    cue: Cue,
    target: Path,
    width: int,
    height: int,
    font: ImageFont.FreeTypeFont,
    layout: SubtitleLayout,
) -> None:
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    text = wrap_text(draw, cue.text, font, layout.max_width)
    spacing = max(8, font.size // 5)
    bounds = draw.multiline_textbbox(
        (0, 0),
        text,
        font=font,
        spacing=spacing,
        align="center",
        stroke_width=4,
    )
    text_width = bounds[2] - bounds[0]
    text_height = bounds[3] - bounds[1]
    x = layout.center_x - text_width / 2 - bounds[0]
    y = height - layout.bottom_margin - text_height - bounds[1]
    draw.multiline_text(
        (x + 2, y + 3),
        text,
        font=font,
        fill=(0, 0, 0, 180),
        spacing=spacing,
        align="center",
        stroke_width=5,
        stroke_fill=(0, 0, 0, 150),
    )
    draw.multiline_text(
        (x, y),
        text,
        font=font,
        fill=(255, 255, 255, 255),
        spacing=spacing,
        align="center",
        stroke_width=3,
        stroke_fill=(0, 0, 0, 235),
    )
    image.save(target, optimize=True)


def analyze_loudness(audio: Path) -> dict[str, str]:
    result = run(
        [
            "ffmpeg",
            "-hide_banner",
            "-i",
            str(audio),
            "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json",
            "-f",
            "null",
            "-",
        ],
        capture=True,
    )
    matches = re.findall(r"\{\s*\"input_i\".*?\}", result.stderr, flags=re.DOTALL)
    if not matches:
        raise SystemExit("could not read loudness measurements")
    return json.loads(matches[-1])


def loudness_filter(measurement: dict[str, str]) -> str:
    return (
        "loudnorm=I=-16:TP=-1.5:LRA=7:linear=true:"
        f"measured_I={measurement['input_i']}:"
        f"measured_LRA={measurement['input_lra']}:"
        f"measured_TP={measurement['input_tp']}:"
        f"measured_thresh={measurement['input_thresh']}:"
        f"offset={measurement['target_offset']}"
    )


def compose(args: argparse.Namespace) -> None:
    require_tools()
    width, height, duration = probe_picture(args.picture)
    if (width, height) != (1920, 1080):
        raise SystemExit(f"expected a 1920x1080 picture master, got {width}x{height}")
    cues = parse_srt(args.subtitles)
    if cues[-1].end > duration + 0.2:
        raise SystemExit("subtitle timeline extends beyond the picture master")
    font = ImageFont.truetype(str(select_font(args.font)), size=args.font_size)
    layouts = subtitle_layouts(
        args.layout,
        cues,
        width,
        args.max_width,
        args.bottom_margin,
    )
    measurement = analyze_loudness(args.audio)
    args.output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="pma-subtitle-overlays-") as temp_name:
        temp_dir = Path(temp_name)
        overlays: list[Path] = []
        for index, cue in enumerate(cues, start=1):
            target = temp_dir / f"{index:03}.png"
            render_overlay(
                cue,
                target,
                width,
                height,
                font,
                layouts[cue.index],
            )
            overlays.append(target)

        concat_path = temp_dir / "subtitle-overlays.ffconcat"
        concat_lines = ["ffconcat version 1.0"]
        for index, (cue, overlay) in enumerate(zip(cues, overlays, strict=True)):
            next_start = cues[index + 1].start if index + 1 < len(cues) else cue.end
            cue_duration = max(0.02, next_start - cue.start)
            concat_lines += [f"file '{overlay.as_posix()}'", f"duration {cue_duration:.3f}"]
        concat_lines.append(f"file '{overlays[-1].as_posix()}'")
        concat_path.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")

        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(args.picture),
            "-i",
            str(args.audio),
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_path),
        ]

        command += [
            "-filter_complex",
            "[0:v][2:v]overlay=0:0:eof_action=pass:shortest=1[vout]",
            "-map",
            "[vout]",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "19",
            "-pix_fmt",
            "yuv420p",
            "-af",
            loudness_filter(measurement),
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-t",
            f"{duration:.3f}",
            "-movflags",
            "+faststart",
            str(args.output),
        ]
        run(command)

    print(f"video: {args.output}")
    print(f"subtitles: {len(cues)} burned cues")
    print(f"duration: {duration:.3f}s")


def main() -> None:
    compose(parse_args())


if __name__ == "__main__":
    main()
