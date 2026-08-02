#!/usr/bin/env python3

"""Build a labelled contact sheet from deterministic demo review frames."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="directory containing review PNG/JPEG frames")
    parser.add_argument("output", type=Path, help="output JPEG or PNG path")
    parser.add_argument("--columns", type=int, default=5)
    parser.add_argument("--thumbnail-width", type=int, default=360)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.columns < 1 or args.thumbnail_width < 80:
        raise SystemExit("columns must be positive and thumbnail width must be at least 80 pixels")

    frames = sorted(
        path
        for path in args.directory.iterdir()
        if path.is_file()
        and path.suffix.lower() in {".jpg", ".jpeg", ".png"}
        and not path.name.startswith("contact-sheet.")
    )
    if not frames:
        raise SystemExit(f"no review frames found in {args.directory}")

    with Image.open(frames[0]) as first:
        aspect = first.width / first.height
    thumbnail_height = round(args.thumbnail_width / aspect)
    label_height = 24
    gutter = 12
    margin = 24
    rows = math.ceil(len(frames) / args.columns)
    cell_height = thumbnail_height + label_height
    canvas_width = margin * 2 + args.columns * args.thumbnail_width + (args.columns - 1) * gutter
    canvas_height = margin * 2 + rows * cell_height + (rows - 1) * gutter
    canvas = Image.new("RGB", (canvas_width, canvas_height), "#f7f4ef")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=13)

    for index, frame_path in enumerate(frames):
        row, column = divmod(index, args.columns)
        x = margin + column * (args.thumbnail_width + gutter)
        y = margin + row * (cell_height + gutter)
        with Image.open(frame_path) as source:
            frame = ImageOps.fit(
                source.convert("RGB"),
                (args.thumbnail_width, thumbnail_height),
                method=Image.Resampling.LANCZOS,
            )
        canvas.paste(frame, (x, y))
        draw.text((x, y + thumbnail_height + 5), frame_path.stem, fill="#2f2925", font=font)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.suffix.lower() in {".jpg", ".jpeg"}:
        canvas.save(args.output, format="JPEG", quality=88, optimize=True)
    else:
        canvas.save(args.output, format="PNG", optimize=True)
    print(f"wrote {len(frames)} frames: {args.output} ({canvas_width}x{canvas_height})")


if __name__ == "__main__":
    main()
