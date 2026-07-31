#!/usr/bin/env python3
"""Build the Chinese quick-start media from Browser-captured Viewer frames."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FRAMES = ROOT / "assets" / "demo" / "source" / "quickstart"
DEFAULT_NAVIGATION_FRAME = ROOT / "assets" / "demo" / "source" / "navigation" / "two-level-navigation-raw.png"
DEFAULT_OUTPUT = ROOT / "assets" / "demo"
FONT_CANDIDATES = (
    Path("/System/Library/Fonts/STHeiti Light.ttc"),
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
    parser.add_argument("--navigation-frame", type=Path, default=DEFAULT_NAVIGATION_FRAME)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    frames = load_frames(args.frames)
    navigation_frame = load_image(args.navigation_frame)
    annotated_dir = args.output / "quickstart"
    annotated_dir.mkdir(parents=True, exist_ok=True)

    frames["overview"].save(args.output / "quickstart-overview.png", optimize=True)

    walkthrough = [
        annotate(
            frames["overview"],
            [Callout("1", "先看完整执行链", (270, 145, 1250, 225), (340, 90))],
        ),
        annotate(
            frames["system"],
            [Callout("2", "查看模型实际收到的系统指令", (1292, 180, 2040, 385), (1370, 118))],
        ),
        annotate(
            frames["tool_result"],
            [Callout("3", "工具结果进入下一次模型请求", (1292, 184, 2040, 425), (1360, 120))],
        ),
        annotate(
            frames["tool_origin"],
            [Callout("4", "一键回到产生结果的工具调用", (1292, 66, 2040, 382), (1370, 398))],
        ),
        annotate(
            frames["final"],
            [Callout("5", "最终回答可以沿证据链复查", (1292, 300, 2040, 550), (1370, 575))],
        ),
        annotate(
            frames["protocol"],
            [Callout("6", "按原生协议核对完整上下行", (1292, 142, 2040, 1050), (1370, 88))],
        ),
    ]
    scene_names = ("trace", "system", "tool-result", "tool-origin", "final-answer", "protocol")
    for index, (scene_name, frame) in enumerate(zip(scene_names, walkthrough), start=1):
        frame.save(annotated_dir / f"{index:02d}-{scene_name}.png", optimize=True)

    walkthrough[0].save(args.output / "quickstart-overview-annotated.png", optimize=True)
    save_gif(
        walkthrough,
        args.output / "quickstart-tool-loop.gif",
        [5200, 6500, 7500, 7500, 6500, 9500],
    )

    navigation_walkthrough = [
        annotate(
            navigation_frame,
            [Callout("A", "Turn Rail：先跳到目标轮次", (1254, 150, 1283, 246), (825, 245))],
        ),
        annotate(
            navigation_frame,
            [Callout("B", "Request Rail：再定位轮内请求", (270, 79, 1248, 127), (510, 18))],
        ),
    ]
    annotate(
        navigation_frame,
        [
            Callout("A", "Turn Rail：先跳到目标轮次", (1254, 150, 1283, 246), (825, 245)),
            Callout("B", "Request Rail：再定位轮内请求", (270, 79, 1248, 127), (510, 18)),
        ],
    ).save(annotated_dir / "07-two-level-navigation.png", optimize=True)
    save_gif(navigation_walkthrough, args.output / "two-level-navigation.gif", [6500, 7500])

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
        "overview": root / "quickstart-overview-raw.png",
        "system": root / "quickstart-system-raw.png",
        "tool_result": root / "quickstart-tool-result-raw.png",
        "tool_origin": root / "quickstart-tool-origin-raw.png",
        "final": root / "quickstart-final-raw.png",
        "protocol": root / "quickstart-protocol-raw.png",
    }
    missing = [str(path) for path in paths.values() if not path.exists()]
    if missing:
        raise SystemExit("Missing Browser frame(s):\n" + "\n".join(missing))
    return {name: Image.open(path).convert("RGB") for name, path in paths.items()}


def load_image(path: Path) -> Image.Image:
    if not path.exists():
        raise SystemExit(f"Missing Browser frame: {path}")
    return Image.open(path).convert("RGB")


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = list(FONT_CANDIDATES)
    if bold:
        candidates.insert(1, Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"))
        candidates.insert(2, Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def annotate(base: Image.Image, callouts: list[Callout]) -> Image.Image:
    image = base.convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    scale = max(1.0, image.width / 1536)
    label_font = font(round(22 * scale), bold=True)
    number_font = font(round(20 * scale), bold=True)
    line_width = round(4 * scale)

    for callout in callouts:
        x1, y1, x2, y2 = callout.box
        draw.rounded_rectangle(callout.box, radius=round(10 * scale), fill=ACCENT_FILL, outline=ACCENT, width=line_width)

        text_box = draw.textbbox((0, 0), callout.label, font=label_font)
        text_width = text_box[2] - text_box[0]
        pill_x, pill_y = callout.pill
        pill_width = text_width + round(64 * scale)
        pill_height = round(40 * scale)
        draw.rounded_rectangle(
            (pill_x, pill_y, pill_x + pill_width, pill_y + pill_height),
            radius=round(18 * scale),
            fill=INK,
            outline=WHITE,
            width=round(2 * scale),
        )
        circle_left = pill_x + round(7 * scale)
        circle_top = pill_y + round(6 * scale)
        circle_right = pill_x + round(35 * scale)
        circle_bottom = pill_y + round(34 * scale)
        draw.ellipse((circle_left, circle_top, circle_right, circle_bottom), fill=BLUE)
        number_box = draw.textbbox((0, 0), callout.number, font=number_font)
        number_width = number_box[2] - number_box[0]
        draw.text((pill_x + round(21 * scale) - number_width / 2, pill_y + round(7 * scale)), callout.number, fill=WHITE, font=number_font)
        draw.text((pill_x + round(44 * scale), pill_y + round(8 * scale)), callout.label, fill=WHITE, font=label_font)

        margin = round(18 * scale)
        start = (pill_x + min(pill_width - margin, max(margin, pill_width // 2)), pill_y + pill_height)
        target = ((x1 + x2) // 2, y1)
        draw.line((start, target), fill=ACCENT, width=line_width)
        draw.polygon(arrow_head(start, target, round(11 * scale)), fill=ACCENT)

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
