#!/usr/bin/env python3
"""Rebuild compact Chinese user-guide GIFs from reviewed PMA evidence frames."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
CANVAS = (1024, 576)
SOURCE = ROOT / "assets" / "demo" / "source"
OUTPUT = ROOT / "assets" / "demo"
USER_GUIDE_OUTPUT = OUTPUT / "user-guide"

CODEX_BLUE = "#2563eb"
CODEX_BLUE_FILL = (37, 99, 235, 22)
RESULT_RED = "#d9485f"
RESULT_RED_FILL = (217, 72, 95, 20)
MUTED = "#94a3b8"
MUTED_FILL = (148, 163, 184, 10)
WHITE = "#f8fafc"

FONT_CANDIDATES = (
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
)


@dataclass(frozen=True)
class Focus:
    box: tuple[int, int, int, int]
    color: str
    fill: tuple[int, int, int, int]
    number: str | None = None


def main() -> None:
    USER_GUIDE_OUTPUT.mkdir(parents=True, exist_ok=True)

    navigation_frames = load_review_frames(
        SOURCE / "quickstart" / "recording" / "review-1024",
        ["09a-turn-rail.jpg", "09b-turn-and-request-rails.jpg"],
    )
    save_gif(navigation_frames, OUTPUT / "two-level-navigation.gif", [6500, 7500])

    context_base, context_scale, context_offset = fit_source(
        SOURCE / "user-guide" / "context" / "context-system-diff-raw.png"
    )
    context_frames = [
        annotate(
            context_base,
            [focus_from_source((1200, 668, 1247, 709), context_scale, context_offset,
                               CODEX_BLUE, CODEX_BLUE_FILL, "1")],
        ),
        annotate(
            context_base,
            [
                focus_from_source((1464, 66, 1538, 97), context_scale, context_offset,
                                  CODEX_BLUE, CODEX_BLUE_FILL, "2"),
                focus_from_source((1298, 151, 2037, 314), context_scale, context_offset,
                                  RESULT_RED, RESULT_RED_FILL),
            ],
        ),
    ]
    save_static_pair(context_frames, "context-request-detail.png", "context-system-diff.png")
    save_gif(context_frames, USER_GUIDE_OUTPUT / "context-changes.gif", [6500, 9500])

    delayed_base, delayed_scale, delayed_offset = fit_source(
        SOURCE / "user-guide" / "async-tool" / "async-delayed-result-raw.png"
    )
    delayed_frames = [
        annotate(
            delayed_base,
            [focus_from_source((276, 741, 1247, 777), delayed_scale, delayed_offset,
                               RESULT_RED, RESULT_RED_FILL, "1")],
        ),
        annotate(
            delayed_base,
            [
                focus_from_source((276, 741, 1247, 777), delayed_scale, delayed_offset,
                                  MUTED, MUTED_FILL),
                focus_from_source((1194, 741, 1247, 777), delayed_scale, delayed_offset,
                                  CODEX_BLUE, CODEX_BLUE_FILL, "2"),
            ],
        ),
    ]
    save_static_pair(delayed_frames, "delayed-tool-result-arrives.png", "delayed-tool-result.png")
    save_gif(delayed_frames, USER_GUIDE_OUTPUT / "delayed-tool-result.gif", [7500, 8500])

    subagent_frames = load_review_frames(
        SOURCE / "claude-subagents" / "recording" / "review-1024",
        ["03b-first-branch.jpg", "03c-branches-crossfade.jpg", "03d-second-branch.jpg"],
    )
    subagent_frames[0].save(USER_GUIDE_OUTPUT / "subagent-expand.png", optimize=True)
    subagent_frames[-1].save(USER_GUIDE_OUTPUT / "subagent-board.png", optimize=True)
    save_gif(subagent_frames, USER_GUIDE_OUTPUT / "subagent-collaboration.gif", [6500, 3000, 6500])

    for path in (
        OUTPUT / "two-level-navigation.gif",
        USER_GUIDE_OUTPUT / "context-changes.gif",
        USER_GUIDE_OUTPUT / "delayed-tool-result.gif",
        USER_GUIDE_OUTPUT / "subagent-collaboration.gif",
    ):
        with Image.open(path) as image:
            print(
                f"{path.relative_to(ROOT)}: {image.width}x{image.height}, "
                f"{getattr(image, 'n_frames', 1)} frames, {path.stat().st_size / 1024:.1f} KiB"
            )


def fit_source(path: Path) -> tuple[Image.Image, float, tuple[int, int]]:
    source = Image.open(path).convert("RGB")
    fitted = ImageOps.contain(source, CANVAS, Image.Resampling.LANCZOS)
    background = source.getpixel((source.width - 1, 0))
    canvas = Image.new("RGB", CANVAS, background)
    offset = ((CANVAS[0] - fitted.width) // 2, (CANVAS[1] - fitted.height) // 2)
    canvas.paste(fitted, offset)
    return canvas, fitted.width / source.width, offset


def load_review_frames(root: Path, names: list[str]) -> list[Image.Image]:
    frames = []
    for name in names:
        path = root / name
        image = Image.open(path).convert("RGB")
        if image.size != CANVAS:
            raise SystemExit(f"review frame must be 1024x576: {path} is {image.size}")
        frames.append(image)
    return frames


def focus_from_source(
    box: tuple[int, int, int, int],
    scale: float,
    offset: tuple[int, int],
    color: str,
    fill: tuple[int, int, int, int],
    number: str | None = None,
) -> Focus:
    x1, y1, x2, y2 = box
    ox, oy = offset
    transformed = (
        round(x1 * scale + ox),
        round(y1 * scale + oy),
        round(x2 * scale + ox),
        round(y2 * scale + oy),
    )
    return Focus(transformed, color, fill, number)


def annotate(base: Image.Image, focuses: list[Focus]) -> Image.Image:
    image = base.convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for focus in focuses:
        draw.rounded_rectangle(focus.box, radius=6, fill=focus.fill, outline=focus.color, width=2)
        if focus.number:
            draw_badge(draw, focus.box, focus.number, focus.color)
    return Image.alpha_composite(image, overlay).convert("RGB")


def draw_badge(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    number: str,
    color: str,
) -> None:
    diameter = 28
    x1, y1, x2, _ = box
    cx = min(CANVAS[0] - diameter // 2 - 4, max(diameter // 2 + 4, x2 + 14))
    cy = max(diameter // 2 + 4, y1 - 8)
    bounds = (
        cx - diameter // 2,
        cy - diameter // 2,
        cx + diameter // 2,
        cy + diameter // 2,
    )
    draw.ellipse(bounds, fill=color, outline=WHITE, width=2)
    badge_font = load_font(15)
    text_box = draw.textbbox((0, 0), number, font=badge_font)
    tx = cx - (text_box[0] + text_box[2]) / 2
    ty = cy - (text_box[1] + text_box[3]) / 2
    draw.text((tx, ty), number, fill=WHITE, font=badge_font)


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def save_static_pair(frames: list[Image.Image], first: str, second: str) -> None:
    frames[0].save(USER_GUIDE_OUTPUT / first, optimize=True)
    frames[1].save(USER_GUIDE_OUTPUT / second, optimize=True)


def save_gif(frames: list[Image.Image], path: Path, durations: list[int]) -> None:
    if len(frames) != len(durations):
        raise SystemExit(f"duration count does not match frame count for {path}")
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
