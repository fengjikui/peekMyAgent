#!/usr/bin/env python3
"""Build Chinese README and user-guide media from Browser-captured Viewer frames."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FRAMES = ROOT / "assets" / "demo" / "source" / "quickstart"
DEFAULT_NAVIGATION_FRAME = ROOT / "assets" / "demo" / "source" / "navigation" / "two-level-navigation-raw.png"
DEFAULT_USER_GUIDE_FRAMES = ROOT / "assets" / "demo" / "source" / "user-guide"
DEFAULT_OUTPUT = ROOT / "assets" / "demo"
FONT_CANDIDATES = (
    Path("/System/Library/Fonts/STHeiti Light.ttc"),
    Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    Path("/System/Library/Fonts/Helvetica.ttc"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
)

ACTION = "#2563eb"
ACTION_FILL = (37, 99, 235, 24)
RESULT = "#f04452"
RESULT_FILL = (240, 68, 82, 22)
INK = "#101828"
WHITE = "#ffffff"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", type=Path, default=DEFAULT_FRAMES)
    parser.add_argument("--navigation-frame", type=Path, default=DEFAULT_NAVIGATION_FRAME)
    parser.add_argument("--user-guide-frames", type=Path, default=DEFAULT_USER_GUIDE_FRAMES)
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
            [
                Callout(
                    "1",
                    "先快速扫一遍完整执行链",
                    (270, 145, 1250, 225),
                    (340, 90),
                    "result",
                    target=(760, 145),
                    controls=((700, 132), (735, 145)),
                )
            ],
        ),
        annotate(
            frames["system"],
            [
                Callout(
                    "2.1",
                    "点“详情”打开证据右栏",
                    (1200, 232, 1248, 273),
                    (930, 276),
                    "action",
                    target=(1212, 273),
                    controls=((1120, 300), (1180, 280)),
                ),
                Callout(
                    "2.2",
                    "选择 System，查看实际指令",
                    (1408, 67, 1462, 96),
                    (1530, 112),
                    "action",
                    target=(1462, 82),
                    controls=((1505, 130), (1480, 82)),
                    result_box=(1293, 178, 2040, 386),
                ),
            ],
        ),
        annotate(
            frames["tool_result"],
            [
                Callout(
                    "3.1",
                    "点击 list_directory 的工具结果",
                    (275, 482, 515, 535),
                    (590, 462),
                    "action",
                    target=(515, 507),
                    controls=((565, 486), (540, 507)),
                ),
                Callout(
                    "3.2",
                    "右栏显示实际回传内容",
                    (1293, 194, 2040, 417),
                    (1515, 431),
                    "result",
                    target=(1660, 417),
                    controls=((1660, 428), (1660, 423)),
                ),
            ],
        ),
        annotate(
            frames["tool_origin"],
            [
                Callout(
                    "4.1",
                    "点击“来源 #1”追溯调用",
                    (1192, 456, 1250, 493),
                    (820, 436),
                    "action",
                    target=(1192, 475),
                    controls=((1090, 459), (1150, 475)),
                ),
                Callout(
                    "4.2",
                    "PMA 跳回原始调用与参数",
                    (1293, 65, 2040, 384),
                    (1500, 397),
                    "result",
                    target=(1645, 384),
                    controls=((1645, 394), (1645, 389)),
                ),
            ],
        ),
        annotate(
            frames["final"],
            [
                Callout(
                    "5.1",
                    "点最终回复的“详情”",
                    (1202, 781, 1250, 820),
                    (865, 763),
                    "action",
                    target=(1202, 800),
                    controls=((1095, 782), (1160, 800)),
                ),
                Callout(
                    "5.2",
                    "右栏核对模型的原始回复",
                    (1293, 227, 2040, 552),
                    (1490, 566),
                    "result",
                    target=(1665, 552),
                    controls=((1665, 563), (1665, 557)),
                ),
            ],
        ),
        annotate(
            frames["protocol"],
            [
                Callout(
                    "6.1",
                    "先打开一次请求的“详情”",
                    (1202, 706, 1250, 744),
                    (850, 687),
                    "action",
                    target=(1202, 725),
                    controls=((1090, 705), (1160, 725)),
                ),
                Callout(
                    "6.2",
                    "点击“协议视图”，查看完整上下行",
                    (1352, 67, 1415, 95),
                    (1500, 104),
                    "action",
                    target=(1415, 81),
                    controls=((1470, 125), (1445, 81)),
                    result_box=(1293, 141, 2040, 1050),
                ),
            ],
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
            [
                Callout(
                    "A",
                    "Turn Rail：先跳到目标轮次",
                    (1254, 150, 1283, 246),
                    (858, 245),
                    "action",
                    target=(1254, 198),
                    controls=((1215, 263), (1240, 220)),
                )
            ],
        ),
        annotate(
            navigation_frame,
            [
                Callout(
                    "B",
                    "Request Rail：再定位轮内请求",
                    (270, 79, 1248, 127),
                    (760, 132),
                    "action",
                    target=(840, 127),
                    controls=((840, 131), (840, 129)),
                )
            ],
        ),
    ]
    annotate(
        navigation_frame,
        [
            Callout(
                "A",
                "Turn Rail：先跳到目标轮次",
                (1254, 150, 1283, 246),
                (858, 245),
                "action",
                target=(1254, 198),
                controls=((1215, 263), (1240, 220)),
            ),
            Callout(
                "B",
                "Request Rail：再定位轮内请求",
                (270, 79, 1248, 127),
                (760, 132),
                "action",
                target=(840, 127),
                controls=((840, 131), (840, 129)),
            ),
        ],
    ).save(annotated_dir / "07-two-level-navigation.png", optimize=True)
    save_gif(navigation_walkthrough, args.output / "two-level-navigation.gif", [6500, 7500])

    build_user_guide_media(args.user_guide_frames, args.output / "user-guide")

    for path in sorted(args.output.glob("*.gif")):
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size / 1024:.1f} KiB")
    for path in sorted(args.output.glob("*.png")):
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size / 1024:.1f} KiB")
    for path in sorted((args.output / "user-guide").glob("*")):
        if path.suffix.lower() in {".gif", ".png"}:
            print(f"{path.relative_to(ROOT)}: {path.stat().st_size / 1024:.1f} KiB")


def build_user_guide_media(source_root: Path, output: Path) -> None:
    paths = {
        "context": source_root / "context" / "context-system-diff-raw.png",
        "async_result": source_root / "async-tool" / "async-delayed-result-raw.png",
        "subagent_collapsed": source_root / "subagent" / "subagent-collapsed-raw.png",
        "subagent_board": source_root / "subagent" / "subagent-board-raw.png",
    }
    missing = [str(path) for path in paths.values() if not path.exists()]
    if missing:
        raise SystemExit("Missing user-guide Browser frame(s):\n" + "\n".join(missing))
    frames = {name: load_image(path) for name, path in paths.items()}
    output.mkdir(parents=True, exist_ok=True)

    context_detail = annotate(
        frames["context"],
        [
            Callout(
                "1.1",
                "打开第 4 次请求的“详情”",
                (1200, 668, 1247, 709),
                (1510, 644),
                "action",
                target=(1247, 689),
                controls=((1435, 664), (1340, 689)),
            )
        ],
    )
    context_diff = annotate(
        frames["context"],
        [
            Callout(
                "1.2",
                "选择 System diff，比较前后指令",
                (1464, 66, 1538, 97),
                (1550, 104),
                "action",
                target=(1538, 81),
                controls=((1544, 99), (1540, 88)),
                result_box=(1298, 151, 2037, 314),
            )
        ],
    )
    context_detail.save(output / "context-request-detail.png", optimize=True)
    context_diff.save(output / "context-system-diff.png", optimize=True)
    save_gif([context_detail, context_diff], output / "context-changes.gif", [6500, 9500])

    delayed_result = annotate(
        frames["async_result"],
        [
            Callout(
                "2.1",
                "后台结果到第 4 次请求才回传",
                (276, 741, 1247, 777),
                (1480, 681),
                "result",
                target=(1120, 741),
                controls=((1400, 654), (1210, 690)),
            )
        ],
    )
    delayed_origin = annotate(
        frames["async_result"],
        [
            Callout(
                "2.1",
                "后台结果到第 4 次请求才回传",
                (276, 741, 1247, 777),
                (1480, 681),
                "result",
                target=(1120, 741),
                controls=((1400, 654), (1210, 690)),
            ),
            Callout(
                "2.2",
                "点击“来源 #1”回到最初调用",
                (1194, 741, 1247, 777),
                (1480, 790),
                "action",
                target=(1247, 759),
                controls=((1400, 808), (1320, 759)),
            ),
        ],
    )
    delayed_result.save(output / "delayed-tool-result-arrives.png", optimize=True)
    delayed_origin.save(output / "delayed-tool-result.png", optimize=True)
    save_gif([delayed_result, delayed_origin], output / "delayed-tool-result.gif", [7500, 8500])

    subagent_action = annotate(
        frames["subagent_collapsed"],
        [
            Callout(
                "3.1",
                "展开 multi-agent 看板",
                (276, 493, 1247, 533),
                (1480, 487),
                "action",
                target=(1247, 513),
                controls=((1410, 505), (1320, 513)),
            )
        ],
    )
    subagent_result = annotate(
        frames["subagent_board"],
        [
            Callout(
                "3.2",
                "选择分支，查看子 Agent 的完整请求链",
                (276, 494, 1247, 1047),
                (1450, 506),
                "result",
                target=(1247, 540),
                controls=((1390, 526), (1320, 540)),
            )
        ],
    )
    subagent_action.save(output / "subagent-expand.png", optimize=True)
    subagent_result.save(output / "subagent-board.png", optimize=True)
    save_gif([subagent_action, subagent_result], output / "subagent-collaboration.gif", [6500, 9500])


class Callout:
    def __init__(
        self,
        number: str,
        label: str,
        box: tuple[int, int, int, int],
        pill: tuple[int, int],
        kind: str = "result",
        target: tuple[int, int] | None = None,
        controls: tuple[tuple[int, int], tuple[int, int]] | None = None,
        result_box: tuple[int, int, int, int] | None = None,
    ):
        self.number = number
        self.label = label
        self.box = box
        self.pill = pill
        self.kind = kind
        self.target = target
        self.controls = controls
        self.result_box = result_box


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
    label_font = font(round(18 * scale), bold=True)
    number_font = font(round(16 * scale), bold=True)
    line_width = round(3 * scale)

    for callout in callouts:
        color, fill = annotation_colors(callout.kind)
        if callout.result_box:
            draw.rounded_rectangle(
                callout.result_box,
                radius=round(9 * scale),
                fill=RESULT_FILL,
                outline=RESULT,
                width=line_width,
            )
        draw.rounded_rectangle(callout.box, radius=round(9 * scale), fill=fill, outline=color, width=line_width)

        label_box = draw.textbbox((0, 0), callout.label, font=label_font)
        label_width = label_box[2] - label_box[0]
        number_box = draw.textbbox((0, 0), callout.number, font=number_font)
        number_width = number_box[2] - number_box[0]
        pill_x, pill_y = callout.pill
        pill_height = round(36 * scale)
        badge_inset = round(5 * scale)
        badge_height = pill_height - badge_inset * 2
        badge_width = max(badge_height, number_width + round(12 * scale))
        badge_left = pill_x + round(7 * scale)
        badge_top = pill_y + badge_inset
        badge_right = badge_left + badge_width
        badge_bottom = badge_top + badge_height
        label_left = badge_right + round(8 * scale)
        pill_width = label_left - pill_x + label_width + round(14 * scale)
        shadow = round(4 * scale)
        draw.rounded_rectangle(
            (pill_x + shadow, pill_y + shadow, pill_x + pill_width + shadow, pill_y + pill_height + shadow),
            radius=round(15 * scale),
            fill=(16, 24, 40, 52),
        )
        draw.rounded_rectangle(
            (pill_x, pill_y, pill_x + pill_width, pill_y + pill_height),
            radius=round(15 * scale),
            fill=INK,
            outline=color,
            width=round(1.5 * scale),
        )
        draw.rounded_rectangle(
            (badge_left, badge_top, badge_right, badge_bottom),
            radius=badge_height // 2,
            fill=color,
        )
        draw_visually_centered_text(
            draw,
            callout.number,
            number_font,
            ((badge_left + badge_right) / 2, (badge_top + badge_bottom) / 2),
            WHITE,
        )
        draw_vertically_centered_text(
            draw,
            callout.label,
            label_font,
            label_left,
            pill_y + pill_height / 2,
            WHITE,
        )

        target = callout.target or closest_box_point(callout.box, (pill_x + pill_width // 2, pill_y + pill_height // 2))
        pill_bounds = (pill_x, pill_y, pill_x + pill_width, pill_y + pill_height)
        start = closest_box_point(pill_bounds, target)
        draw_connector(draw, start, target, color, line_width, scale, callout.controls)

    return Image.alpha_composite(image, overlay).convert("RGB")


def annotation_colors(kind: str) -> tuple[str, tuple[int, int, int, int]]:
    if kind == "action":
        return ACTION, ACTION_FILL
    return RESULT, RESULT_FILL


def draw_visually_centered_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    text_font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    center: tuple[float, float],
    fill: str,
) -> None:
    box = draw.textbbox((0, 0), text, font=text_font)
    x = center[0] - (box[0] + box[2]) / 2
    y = center[1] - (box[1] + box[3]) / 2
    draw.text((x, y), text, fill=fill, font=text_font)


def draw_vertically_centered_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    text_font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    left: float,
    center_y: float,
    fill: str,
) -> None:
    box = draw.textbbox((0, 0), text, font=text_font)
    x = left - box[0]
    y = center_y - (box[1] + box[3]) / 2
    draw.text((x, y), text, fill=fill, font=text_font)


def closest_box_point(box: tuple[int, int, int, int], point: tuple[int, int]) -> tuple[int, int]:
    x1, y1, x2, y2 = box
    px, py = point
    candidates = [
        (max(x1, min(px, x2)), y1),
        (max(x1, min(px, x2)), y2),
        (x1, max(y1, min(py, y2))),
        (x2, max(y1, min(py, y2))),
    ]
    return min(candidates, key=lambda candidate: (candidate[0] - px) ** 2 + (candidate[1] - py) ** 2)


def draw_connector(
    draw: ImageDraw.ImageDraw,
    start: tuple[int, int],
    end: tuple[int, int],
    color: str,
    width: int,
    scale: float,
    controls: tuple[tuple[int, int], tuple[int, int]] | None = None,
) -> None:
    points = bezier_points(start, end, controls=controls)
    draw.line(points, fill=WHITE, width=width + round(4 * scale), joint="curve")
    draw.line(points, fill=color, width=width, joint="curve")
    draw.polygon(arrow_head(points[-2], end, round(12 * scale)), fill=WHITE)
    draw.polygon(arrow_head(points[-2], end, round(9 * scale)), fill=color)


def bezier_points(
    start: tuple[int, int],
    end: tuple[int, int],
    steps: int = 24,
    controls: tuple[tuple[int, int], tuple[int, int]] | None = None,
) -> list[tuple[int, int]]:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    if controls:
        control1, control2 = controls
    elif abs(dx) >= abs(dy):
        control1 = (start[0] + dx * 0.42, start[1])
        control2 = (end[0] - dx * 0.18, end[1])
    else:
        control1 = (start[0], start[1] + dy * 0.42)
        control2 = (end[0], end[1] - dy * 0.18)
    points = []
    for step in range(steps + 1):
        t = step / steps
        inverse = 1 - t
        x = inverse**3 * start[0] + 3 * inverse**2 * t * control1[0] + 3 * inverse * t**2 * control2[0] + t**3 * end[0]
        y = inverse**3 * start[1] + 3 * inverse**2 * t * control1[1] + 3 * inverse * t**2 * control2[1] + t**3 * end[1]
        points.append((round(x), round(y)))
    return points


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
