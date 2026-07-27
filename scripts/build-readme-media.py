#!/usr/bin/env python3
"""Build annotated README media from Browser-captured Viewer frames."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FRAMES = ROOT / "tmp" / "readme-media-frames"
DEFAULT_OUTPUT = ROOT / "assets" / "demo"
FONT_CANDIDATES = (
    Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    Path("/System/Library/Fonts/Helvetica.ttc"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
)

ACCENT = "#ff4d5a"
ACCENT_FILL = (255, 77, 90, 28)
INK = "#101828"
BLUE = "#2563eb"
WHITE = "#ffffff"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", type=Path, default=DEFAULT_FRAMES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    frames = load_frames(args.frames)

    frames["protocol"].save(args.output / "dashboard-overview.png", optimize=True)

    annotated_overview = annotate(
        frames["protocol"],
        [
            Callout("1", "Session / project", (8, 72, 246, 214), (22, 18)),
            Callout("2", "Tool loop", (270, 112, 752, 176), (330, 18)),
            Callout("3", "Protocol evidence", (802, 2, 1276, 718), (900, 18)),
            Callout("4", "Qualified namespace leaves", (806, 434, 1268, 603), (836, 382)),
        ],
    )
    annotated_overview.save(args.output / "dashboard-overview-annotated.png", optimize=True)

    overview_tour = [
        annotate(frames["protocol"], [Callout("1", "Pick a real trace", (8, 72, 246, 214), (22, 18))]),
        annotate(frames["protocol"], [Callout("2", "Follow user → tool → result → answer", (270, 112, 752, 176), (290, 18))]),
        annotate(frames["protocol_wide"], [Callout("3", "Preserve provider wire order", (774, 2, 1276, 718), (808, 18))]),
        annotate(frames["protocol_wide"], [Callout("4", "Namespace → callable leaves", (780, 415, 1268, 608), (830, 362))]),
        annotate(frames["lazy_image"], [Callout("5", "Load large payloads only on demand", (790, 292, 1268, 455), (806, 235))]),
    ]
    save_gif(overview_tour, args.output / "dashboard-overview-tour.gif", [2800, 3200, 3400, 3800, 3800])

    protocol_walkthrough = [
        annotate(frames["protocol"], [Callout("1", "Open Protocol for captured wire evidence", (824, 54, 900, 90), (456, 18))]),
        annotate(frames["protocol_wide"], [Callout("2", "Declared and added tools stay in order", (780, 255, 1268, 503), (814, 195))]),
        annotate(frames["protocol_wide"], [Callout("3", "Containers are structure, not tools", (780, 415, 1268, 608), (816, 357))]),
        annotate(frames["tools_wide"], [Callout("4", "Inspect leaf schemas and parameters", (774, 174, 1268, 705), (820, 116))]),
    ]
    protocol_poster = protocol_walkthrough[2]
    protocol_poster.save(args.output / "chat-upstream-context.png", optimize=True)
    save_gif(protocol_walkthrough, args.output / "chat-upstream-context.gif", [2800, 3400, 3800, 3800])

    lazy_walkthrough = [
        annotate(frames["protocol"], [Callout("1", "Tool calls and results stay linked", (270, 112, 752, 620), (290, 18))]),
        annotate(frames["lazy_tool"], [Callout("2", "Large result → type • size • hash", (790, 315, 1268, 492), (800, 255))]),
        annotate(frames["loaded_tool"], [Callout("3", "Open only when the detail matters", (792, 330, 1268, 716), (818, 272))]),
        annotate(frames["lazy_image"], [Callout("4", "Images also stay local until opened", (790, 292, 1268, 455), (810, 235))]),
    ]
    lazy_poster = lazy_walkthrough[1]
    lazy_poster.save(args.output / "tool-call-loop.png", optimize=True)
    save_gif(lazy_walkthrough, args.output / "tool-call-loop.gif", [2800, 3400, 3800, 3800])

    for path in sorted(args.output.glob("*.gif")):
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size / 1024:.1f} KiB")
    for path in sorted(args.output.glob("*.png")):
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size / 1024:.1f} KiB")


class Callout:
    def __init__(self, number: str, label: str, box: tuple[int, int, int, int], pill: tuple[int, int]):
        self.number = number
        self.label = label
        self.box = box
        self.pill = pill


def load_frames(root: Path) -> dict[str, Image.Image]:
    paths = {
        "protocol": root / "protocol-raw.png",
        "protocol_wide": root / "protocol-wide-raw.png",
        "tools_wide": root / "tools-wide-raw.png",
        "lazy_tool": root / "lazy-tool-result-focused-raw.png",
        "loaded_tool": root / "lazy-tool-result-loaded-raw.png",
        "lazy_image": root / "lazy-image-placeholder-open-raw.png",
    }
    missing = [str(path) for path in paths.values() if not path.exists()]
    if missing:
        raise SystemExit("Missing Browser frame(s):\n" + "\n".join(missing))
    return {name: Image.open(path).convert("RGB") for name, path in paths.items()}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = list(FONT_CANDIDATES)
    if bold:
        candidates.insert(0, Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"))
        candidates.insert(1, Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def annotate(base: Image.Image, callouts: list[Callout]) -> Image.Image:
    image = base.convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    label_font = font(21, bold=True)
    number_font = font(20, bold=True)

    for callout in callouts:
        x1, y1, x2, y2 = callout.box
        draw.rounded_rectangle(callout.box, radius=10, fill=ACCENT_FILL, outline=ACCENT, width=4)

        text_box = draw.textbbox((0, 0), callout.label, font=label_font)
        text_width = text_box[2] - text_box[0]
        pill_x, pill_y = callout.pill
        pill_width = text_width + 64
        pill_height = 40
        draw.rounded_rectangle(
            (pill_x, pill_y, pill_x + pill_width, pill_y + pill_height),
            radius=18,
            fill=INK,
            outline=WHITE,
            width=2,
        )
        draw.ellipse((pill_x + 7, pill_y + 6, pill_x + 35, pill_y + 34), fill=BLUE)
        number_box = draw.textbbox((0, 0), callout.number, font=number_font)
        number_width = number_box[2] - number_box[0]
        draw.text((pill_x + 21 - number_width / 2, pill_y + 7), callout.number, fill=WHITE, font=number_font)
        draw.text((pill_x + 44, pill_y + 8), callout.label, fill=WHITE, font=label_font)

        start = (pill_x + min(pill_width - 18, max(18, pill_width // 2)), pill_y + pill_height)
        target = ((x1 + x2) // 2, y1)
        draw.line((start, target), fill=ACCENT, width=4)
        draw.polygon(arrow_head(start, target, 11), fill=ACCENT)

    return Image.alpha_composite(image, overlay).convert("RGB")


def arrow_head(start: tuple[int, int], end: tuple[int, int], size: int) -> list[tuple[float, float]]:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = max(1.0, (dx * dx + dy * dy) ** 0.5)
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    return [
        end,
        (end[0] - ux * size + px * size * 0.55, end[1] - uy * size + py * size * 0.55),
        (end[0] - ux * size - px * size * 0.55, end[1] - uy * size - py * size * 0.55),
    ]


def save_gif(frames: list[Image.Image], path: Path, durations: list[int]) -> None:
    palette_frames = [frame.convert("P", palette=Image.Palette.ADAPTIVE, colors=128) for frame in frames]
    palette_frames[0].save(
        path,
        save_all=True,
        append_images=palette_frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )


if __name__ == "__main__":
    main()
