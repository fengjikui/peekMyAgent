#!/usr/bin/env python3
"""Build the Chinese Claude Code tool-loop video from real PMA Viewer frames.

The Viewer screenshots are captured at 2048x1056 from the deterministic
``claude-tool-loop`` source. This script adds reviewed, single-purpose callouts
before handing the frames to the shared FFmpeg video builder.
"""

from __future__ import annotations

import importlib.util
import math
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "assets" / "demo" / "source" / "claude-tool-loop" / "recording" / "raw"
REVIEW_DIR = ROOT / "assets" / "demo" / "source" / "claude-tool-loop" / "recording" / "review"
VIDEO_SOURCE_DIR = ROOT / "assets" / "demo" / "source" / "claude-tool-loop" / "video"
CLAUDE = (176, 107, 72)
LABEL_FILL = (53, 37, 30, 242)
WHITE = (250, 247, 244, 255)


@dataclass(frozen=True)
class Annotation:
    source: str
    label: str
    label_box: tuple[int, int, int, int]
    arrow_points: tuple[tuple[int, int], ...]
    focus_box: tuple[int, int, int, int]


ANNOTATIONS = {
    "01-overview": Annotation(
        "02-overview.png",
        "① 一条完整执行链",
        (760, 245, 1120, 305),
        ((760, 275), (690, 275), (690, 182), (645, 182)),
        (268, 162, 650, 201),
    ),
    "02-metadata": Annotation(
        "03-metadata.png",
        "点击 Metadata",
        (1780, 6, 1965, 58),
        ((1780, 58), (1780, 66), (1705, 66), (1705, 75)),
        (1295, 505, 2035, 755),
    ),
    "03-system": Annotation(
        "04-system.png",
        "点击 System",
        (1790, 6, 1965, 58),
        ((1790, 58), (1790, 66), (1437, 66), (1437, 75)),
        (1295, 190, 2035, 350),
    ),
    "04-tools": Annotation(
        "05-tools.png",
        "点击 Tools",
        (1800, 6, 1965, 58),
        ((1800, 58), (1800, 66), (1485, 66), (1485, 75)),
        (1295, 188, 2035, 550),
    ),
    "05-tool-use": Annotation(
        "06-tool-use.png",
        "点击这条 Read 工具调用",
        (805, 625, 1190, 690),
        ((1190, 657), (1218, 657), (1218, 397), (1190, 397)),
        (1295, 205, 2035, 405),
    ),
    "06-tool-result": Annotation(
        "07-tool-result.png",
        "点击下一条工具结果",
        (820, 630, 1190, 695),
        ((1190, 662), (1218, 662), (1218, 489), (1190, 489)),
        (1295, 195, 2035, 355),
    ),
    "07-source-jump": Annotation(
        "08-source-jump.png",
        "点击“来源 #1”回到原始调用",
        (730, 635, 1175, 700),
        ((1175, 667), (1203, 667), (1203, 488), (1210, 488)),
        (1295, 98, 2035, 143),
    ),
    "08-protocol": Annotation(
        "09-protocol.png",
        "点击 协议视图",
        (1790, 6, 1975, 58),
        ((1790, 58), (1790, 66), (1382, 66), (1382, 75)),
        (1295, 452, 2035, 715),
    ),
    "09-raw": Annotation(
        "10-raw-search.png",
        "点击 完整请求",
        (1790, 6, 1975, 58),
        ((1790, 58), (1790, 66), (1328, 66), (1328, 75)),
        (1295, 188, 2035, 1025),
    ),
    "10-final": Annotation(
        "11-final-response.png",
        "点击最终回答的“详情”",
        (790, 640, 1190, 705),
        ((1190, 672), (1218, 672), (1218, 529), (1204, 529)),
        (1295, 220, 2035, 365),
    ),
}


def load_builder():
    path = ROOT / "scripts" / "build-demo-video.py"
    spec = importlib.util.spec_from_file_location("pma_demo_video_builder", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load shared video builder: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def select_annotation_font() -> Path:
    candidates = (
        Path("/System/Library/Fonts/STHeiti Medium.ttc"),
        Path("/System/Library/Fonts/Supplemental/Songti.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise SystemExit("no supported CJK annotation font found")


def centered_text_position(
    draw: ImageDraw.ImageDraw,
    label: str,
    label_font: ImageFont.FreeTypeFont,
    box: tuple[int, int, int, int],
) -> tuple[float, float]:
    bounds = draw.textbbox((0, 0), label, font=label_font)
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    return (
        box[0] + (box[2] - box[0] - width) / 2 - bounds[0],
        box[1] + (box[3] - box[1] - height) / 2 - bounds[1],
    )


def draw_arrow(
    draw: ImageDraw.ImageDraw,
    points: tuple[tuple[int, int], ...],
    color: tuple[int, int, int, int],
) -> None:
    draw.line(points, fill=(255, 255, 255, 220), width=9, joint="curve")
    draw.line(points, fill=color, width=5, joint="curve")
    start_x, start_y = points[-2]
    end_x, end_y = points[-1]
    angle = math.atan2(end_y - start_y, end_x - start_x)
    length = 20
    spread = math.radians(30)
    head = [
        (end_x, end_y),
        (
            end_x - length * math.cos(angle - spread),
            end_y - length * math.sin(angle - spread),
        ),
        (
            end_x - length * math.cos(angle + spread),
            end_y - length * math.sin(angle + spread),
        ),
    ]
    draw.polygon(head, fill=color)


def render_annotation(plan: Annotation, target: Path, font_path: Path) -> None:
    source_path = RAW_DIR / plan.source
    if not source_path.exists():
        raise SystemExit(f"missing captured Viewer frame: {source_path}")
    image = Image.open(source_path).convert("RGBA")
    if image.size != (2048, 1056):
        raise SystemExit(f"unexpected Viewer frame size {image.size}: {source_path}")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    color = CLAUDE + (255,)

    draw.rounded_rectangle(
        plan.focus_box,
        radius=14,
        fill=CLAUDE + (20,),
        outline=(255, 255, 255, 245),
        width=9,
    )
    draw.rounded_rectangle(plan.focus_box, radius=14, outline=color, width=5)
    draw_arrow(draw, plan.arrow_points, color)

    draw.rounded_rectangle(
        plan.label_box,
        radius=18,
        fill=LABEL_FILL,
        outline=(255, 255, 255, 235),
        width=3,
    )
    draw.rounded_rectangle(plan.label_box, radius=18, outline=color, width=2)
    label_font = ImageFont.truetype(str(font_path), size=25)
    draw.text(
        centered_text_position(draw, plan.label, label_font, plan.label_box),
        plan.label,
        font=label_font,
        fill=WHITE,
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.alpha_composite(image, overlay).convert("RGB").save(target, optimize=True)


def prepare_annotated_frames() -> dict[str, str]:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    font_path = select_annotation_font()
    images: dict[str, str] = {}
    for scene_id, plan in ANNOTATIONS.items():
        target = REVIEW_DIR / f"{scene_id}.png"
        render_annotation(plan, target, font_path)
        images[scene_id] = str(target.relative_to(ROOT))
    return images


def configure_builder(builder, images: dict[str, str]) -> None:
    builder.SOURCE_DIR = VIDEO_SOURCE_DIR
    builder.FRAME_DIR = VIDEO_SOURCE_DIR / "frames"
    builder.OUTPUT_BASENAME = "pma-claude-tool-loop.zh-CN"
    builder.VIDEO_TITLE = "用 PMA 看懂 Claude Code：一次工具调用"
    builder.COVER_EYEBROW = "peekMyAgent · Claude Code 机制演示"
    builder.COVER_TITLE = "一次工具调用到底发生了什么？"
    builder.COVER_BODY = "用户 · Claude Code · 远端模型 · tool_use · tool_result"
    builder.COVER_SOURCE_IMAGE = images["01-overview"]
    builder.COVER_LABEL = "从用户请求，追到模型最终回答"
    Scene = builder.Scene
    builder.SCENES = (
        Scene(
            "00-intro",
            "三个角色，完成一次工具调用",
            "用户提出目标；Claude Code 组织请求并在本地执行；远端模型选择下一步。",
            "这支视频只讲清一件事：用户、Claude Code 和远端模型，怎样共同完成一次工具调用。远端模型不会直接读取你的电脑；真正的本地执行发生在 Claude Code 这一侧。",
            13.0,
            accent=CLAUDE,
            card_line="用户目标 → Claude Code 本地执行 ↔ 远端模型选择下一步",
            footer="PMA 记录三者之间每一次结构化往返",
        ),
        Scene(
            "01-overview",
            "先看完整闭环",
            "一个 Turn 内，两次模型请求串起用户目标、Read 调用、工具结果和最终回答。",
            "演示任务很简单：读取 README 第一行并告诉我项目名。PMA 在同一个 Turn 里，把用户目标、第一次模型请求、Read 工具调用、工具结果、第二次请求和最终回答串成一条证据链。",
            16.0,
            images["01-overview"],
            CLAUDE,
        ),
        Scene(
            "02-metadata",
            "第一次请求调用了哪个模型？",
            "点击请求详情中的 Metadata，先核对模型、最大输出和流式参数。",
            "点开第一次请求的详情，再切到 Metadata。这里能核对模型、最大输出、是否流式、传输路径和上行构成。排查 Harness 时，先确认模型和参数没有在中间被改错。",
            14.0,
            images["02-metadata"],
            CLAUDE,
        ),
        Scene(
            "03-system",
            "模型实际收到了哪些 System 指令？",
            "System 区域展示该次请求中的真实字段，而不是根据模型行为反推。",
            "切到 System，可以看到这一次真正发送给模型的固定指令。演示轨迹明确限制为虚构的 demo 文件，不访问凭据、用户文件或网络。这里展示的是捕获证据，不是根据结果猜出来的提示词。",
            15.0,
            images["03-system"],
            CLAUDE,
        ),
        Scene(
            "04-tools",
            "为什么模型会选择 Read？",
            "Claude Code 在请求中声明 Read、Glob、Bash；每个工具都有描述和参数 schema。",
            "Tools 区域给出了这一次模型可以选择的动作。这里同时声明了 Read、Glob 和 Bash，并附带描述与输入 schema。模型并不是预先写死要读文件；在这条 Capture 中，它从已提供的工具里返回了 Read。",
            20.0,
            images["04-tools"],
            CLAUDE,
        ),
        Scene(
            "05-tool-use",
            "模型提出调用，但还没有执行",
            "tool_use 只包含调用 ID、工具名和参数：README.md，从第一行读取一行。",
            "点击时间线里的 Read，右栏出现 tool use。模型返回了调用标识 read hello、工具名和参数：读取 README 点 m d，从第一行开始，只取一行。到这一步，模型只是提出调用，并没有亲自碰本地文件。",
            18.0,
            images["05-tool-use"],
            CLAUDE,
        ),
        Scene(
            "06-tool-result",
            "Claude Code 在本地执行并回传结果",
            "下一次请求中的 tool_result 引用同一 ID，真实输出是 # hello-agent。",
            "Claude Code 接到这个调用后，负责权限检查和本地执行。下一条工具结果显示，返回内容是井号 hello agent，并且引用同一个 read hello 标识。远端模型真正看到文件内容，是在后续请求收到 tool result 的时候。",
            19.0,
            images["06-tool-result"],
            CLAUDE,
        ),
        Scene(
            "07-source-jump",
            "结果晚出现，也能一键追溯来源",
            "点击“来源 #1”，PMA 直接跳回产生 read_hello 的原始 tool_use。",
            "PMA 已经把工具结果和最初调用关联起来。点击来源编号，就会跳回第一次请求的 tool use，并保留返回结果的入口。长会话里，即使结果晚了几轮，也不需要手工搜索调用标识。",
            16.0,
            images["07-source-jump"],
            CLAUDE,
        ),
        Scene(
            "08-protocol",
            "原生 Anthropic Messages 怎样封装这次往返？",
            "输入顺序清楚显示 assistant/tool_use 后接 user/tool_result，最后才有模型回答。",
            "协议视图保留 Anthropic Messages 的原生角色和顺序。先是用户消息，再是 assistant 文本和 tool use；Claude Code 执行后，把 tool result 放进后续 user message 的 content。模型收到这份新请求，才返回最终回答。",
            22.0,
            images["08-protocol"],
            CLAUDE,
        ),
        Scene(
            "09-raw",
            "摘要有疑问，就回到完整请求",
            "Raw Inspector 保留原始 headers、body、模型参数、System、Tools 和脱敏记录。",
            "如果整理后的协议仍不足以解释问题，可以打开完整请求。Raw Inspector 保留原始请求头、body、模型参数、System、工具定义和消息；敏感请求头会显示脱敏原因，而不是把真实值录进素材。",
            19.0,
            images["09-raw"],
            CLAUDE,
        ),
        Scene(
            "10-final",
            "最终回答是否真的有工具证据？",
            "第二次模型 Response 返回“项目名是 hello-agent”，可以沿时间线向前核对依据。",
            "最后点击模型回复的详情。第二次 Response 给出：项目名是 hello agent。现在我们不只看到了答案，还能沿时间线向前核对：它使用了哪一个工具、文件实际返回了什么、结果又怎样进入下一次模型请求。",
            16.0,
            images["10-final"],
            CLAUDE,
        ),
        Scene(
            "11-outro",
            "模型选择，Claude Code 执行，PMA 留下证据",
            "这就是一次完整工具闭环：目标、tool_use、本地执行、tool_result、最终回答。",
            "记住这条边界：模型负责根据结构化上下文选择下一步；Claude Code 负责在本地执行和回传；PMA 让每一步都能回到请求、协议和 Raw 证据。下一支视频，我们再拆解 Skill 是怎样被发现和加载的。",
            14.0,
            accent=CLAUDE,
            card_line="用户目标 → tool_use → 本地执行 → tool_result → 最终回答",
            footer="模型没有越过 Claude Code 直接操作你的电脑",
        ),
    )


def main() -> None:
    prepare_only = "--prepare-only" in sys.argv
    if prepare_only:
        sys.argv.remove("--prepare-only")
    images = prepare_annotated_frames()
    builder = load_builder()
    configure_builder(builder, images)
    if prepare_only:
        font_path = builder.select_font()
        builder.FRAME_DIR.mkdir(parents=True, exist_ok=True)
        builder.render_cover(font_path)
        for scene in builder.SCENES:
            builder.render_scene(scene, builder.FRAME_DIR / f"{scene.scene_id}.png", font_path)
        print(f"annotated frames: {REVIEW_DIR}")
        print(f"composite frames: {builder.FRAME_DIR}")
        return
    builder.build_video(builder.parse_args())


if __name__ == "__main__":
    main()
