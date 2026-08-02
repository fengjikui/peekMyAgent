#!/usr/bin/env python3
"""Build the Chinese PMA product-tour draft from public deterministic media.

The output is intentionally editor-neutral: MP4, M4A, SRT, cover art and a
JSON timeline can be imported into ChatCut, CapCut or another NLE for a second
editing pass. The default narration uses the macOS Tingting system voice so the
first cut remains reproducible without credentials or network services.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "assets" / "demo" / "video"
SOURCE_DIR = ROOT / "assets" / "demo" / "source" / "video"
FRAME_DIR = SOURCE_DIR / "frames"
OUTPUT_BASENAME = "pma-core-tour.zh-CN"
VIDEO_TITLE = "peekMyAgent 中文核心能力演示"
COVER_EYEBROW = "peekMyAgent · 中文产品演示"
COVER_TITLE = "看见 Agent 真正发送给模型的内容"
COVER_BODY = "请求 · System · 工具结果 · 原生协议 · 上下文变化 · 子 Agent"
COVER_SOURCE_IMAGE = "assets/demo/quickstart/01-trace.png"
COVER_LABEL = "从一次最小会话，追到每一层真实证据"
SHOW_UI_CAPTION_PANEL = True
EMBED_SUBTITLE_TRACK = True
DISPLAY_SUBTITLE_REPLACEMENTS: dict[str, str] = {}

WIDTH = 1920
HEIGHT = 1080
FPS = 30
FONT_CANDIDATES = (
    Path("/System/Library/Fonts/STHeiti Medium.ttc"),
    Path("/System/Library/Fonts/Supplemental/Songti.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
)

NAVY = (8, 17, 31)
NAVY_2 = (14, 30, 51)
PANEL = (17, 33, 54)
WHITE = (247, 250, 252)
MUTED = (171, 188, 207)
BLUE = (55, 111, 246)
RED = (244, 76, 93)
GREEN = (50, 190, 133)


@dataclass(frozen=True)
class Scene:
    scene_id: str
    title: str
    caption: str
    narration: str
    min_duration: float
    image: str | None = None
    accent: tuple[int, int, int] = BLUE
    card_line: str | None = None
    footer: str | None = None
    subtitle_segments: tuple[str, ...] | None = None


SCENES = (
    Scene(
        "00-intro",
        "普通日志看不到 Agent 真正发送了什么",
        "PMA 把每次模型请求、工具交换和上下文变化放回同一条证据链。",
        "如果一个 Agent 完成了任务，普通日志往往只能告诉你它运行过。PMA 要回答的是：模型到底收到了什么，又为什么做出下一步。",
        8.0,
        accent=BLUE,
    ),
    Scene(
        "01-trace",
        "先从一次完整执行链开始",
        "用户请求、三次模型请求、两次工具调用与最终回答，一屏串起来。",
        "这是一次最小会话。用户只要求查看目录、读取 README，再给一句话结论。PMA 把用户请求、三次模型请求、两次工具调用、工具结果和最终回答放进同一条时间线。",
        14.0,
        "assets/demo/quickstart/01-trace.png",
    ),
    Scene(
        "02-system",
        "模型实际收到了哪些 System 指令？",
        "点击请求详情，再选择 System；这里展示的是捕获证据，不是终端摘要。",
        "点开任意请求的详情，选择 System，就能检查模型实际收到的系统指令。它和终端中看到的摘要不是一回事。",
        11.0,
        "assets/demo/quickstart/02-system.png",
    ),
    Scene(
        "03-tool-result",
        "工具真的返回了什么？",
        "PMA 将工具结果关联到调用，并展开真实回传内容。",
        "工具执行后，PMA 会把回传内容关联到对应调用。这里能看到 list directory 真正返回了哪些文件，而不是只知道工具成功了。",
        12.0,
        "assets/demo/quickstart/03-tool-result.png",
    ),
    Scene(
        "04-tool-origin",
        "从结果跳回最初调用",
        "点击“来源编号”，直接核对原始工具名、调用编号和参数。",
        "结果即使晚了几轮，也可以点击来源编号，直接跳回原始工具调用和参数。长会话里不需要人工翻找。",
        11.0,
        "assets/demo/quickstart/04-tool-origin.png",
    ),
    Scene(
        "05-final-answer",
        "最终回答是否真的基于工具证据？",
        "右栏保留模型原始回复，便于区分证据驱动与自行猜测。",
        "最终回答旁的详情会展示模型原始回复。这样可以核对结论究竟来自工具证据，还是模型自己猜出来的。",
        11.0,
        "assets/demo/quickstart/05-final-answer.png",
    ),
    Scene(
        "06-protocol",
        "摘要不够时，回到原生协议",
        "协议视图保留 OpenAI Responses 或 Anthropic Messages 的上下行顺序。",
        "如果摘要仍然不够，协议视图保留 OpenAI Responses 或 Anthropic Messages 的原生上下行顺序。开发 Harness 时，可以检查指令、工具定义、历史消息、模型参数和回复。",
        15.0,
        "assets/demo/quickstart/06-protocol.png",
        RED,
    ),
    Scene(
        "07-context-diff",
        "相邻请求的固定上下文哪里变了？",
        "System diff 标出新增与删除；完整事实仍应回到 System 原文和 Raw。",
        "相邻请求的 System diff 会明确标出新增和删除的固定指令。它适合判断 Harness 是否改写了上下文，但不能凭一次变化就声称发生了压缩。",
        13.0,
        "assets/demo/user-guide/context-system-diff.png",
        RED,
    ),
    Scene(
        "08-delayed-result",
        "异步结果晚到几轮，仍然能追溯",
        "第 4 次请求收到后台结果，PMA 仍把它连回第 1 次请求的调用。",
        "异步工具的结果可能到第四次请求才返回。PMA 仍然根据调用标识建立来源关系，让迟到结果和最初调用彼此可达。",
        13.0,
        "assets/demo/user-guide/delayed-tool-result.png",
        RED,
    ),
    Scene(
        "09-subagent",
        "子 Agent 不再只是一个黑盒名称",
        "父级启动、子分支请求、工具结果与回流状态都能继续展开。",
        "Claude Code 等 Harness 启动子 Agent 时，多 Agent 看板会把父级启动、子分支内部请求、工具结果和回流放在一起。每个分支仍可继续查看完整证据。",
        14.0,
        "assets/demo/user-guide/subagent-board.png",
        (176, 107, 72),
    ),
    Scene(
        "10-outro",
        "用一次非敏感测试会话开始",
        "先完成五分钟快速上手，再逐步检查协议、上下文和多 Agent。",
        "这只是 PMA 的第一条中文演示。接下来你可以从五分钟快速上手开始，用一个非敏感测试目录观察自己的 Agent。",
        9.0,
        accent=GREEN,
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voice", default="Tingting", help="macOS say voice")
    parser.add_argument("--rate", type=int, default=185, help="macOS say rate")
    parser.add_argument(
        "--no-voice",
        action="store_true",
        help="generate a silent cut with the same timing",
    )
    parser.add_argument(
        "--keep-scene-clips",
        action="store_true",
        help="preserve individual MP4 scene clips under source/video/clips",
    )
    return parser.parse_args()


def run(command: list[str]) -> None:
    subprocess.run(command, cwd=ROOT, check=True)


def output(command: list[str]) -> str:
    return subprocess.check_output(command, cwd=ROOT, text=True).strip()


def require_tools(no_voice: bool) -> None:
    required = ["ffmpeg", "ffprobe"]
    if not no_voice:
        required.append("say")
    missing = [name for name in required if shutil.which(name) is None]
    if missing:
        raise SystemExit(f"missing required tools: {', '.join(missing)}")


def select_font() -> Path:
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            return candidate
    raise SystemExit("no supported CJK font found")


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size=size)


def rounded_panel(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    fill: tuple[int, int, int] | tuple[int, int, int, int],
    outline: tuple[int, int, int] | None = None,
    width: int = 1,
    radius: int = 18,
) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def wrap_text(draw: ImageDraw.ImageDraw, text: str, text_font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for char in text:
        candidate = current + char
        if current and draw.textbbox((0, 0), candidate, font=text_font)[2] > max_width:
            lines.append(current)
            current = char
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def draw_centered_lines(
    draw: ImageDraw.ImageDraw,
    lines: list[str],
    text_font: ImageFont.FreeTypeFont,
    box: tuple[int, int, int, int],
    fill: tuple[int, int, int],
    spacing: int,
) -> None:
    line_height = text_font.getbbox("国Agent")[3] - text_font.getbbox("国Agent")[1]
    total = len(lines) * line_height + max(0, len(lines) - 1) * spacing
    y = box[1] + (box[3] - box[1] - total) / 2
    for line in lines:
        bounds = draw.textbbox((0, 0), line, font=text_font)
        x = box[0] + (box[2] - box[0] - (bounds[2] - bounds[0])) / 2
        draw.text((x, y), line, font=text_font, fill=fill)
        y += line_height + spacing


def gradient_background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), NAVY)
    pixels = image.load()
    for y in range(HEIGHT):
        ratio = y / max(1, HEIGHT - 1)
        for x in range(WIDTH):
            glow = max(0.0, 1.0 - (((x - 1450) / 900) ** 2 + ((y - 220) / 650) ** 2))
            pixels[x, y] = (
                int(NAVY[0] * (1 - ratio) + NAVY_2[0] * ratio + 10 * glow),
                int(NAVY[1] * (1 - ratio) + NAVY_2[1] * ratio + 19 * glow),
                int(NAVY[2] * (1 - ratio) + NAVY_2[2] * ratio + 33 * glow),
            )
    return image


def render_title_scene(scene: Scene, font_path: Path) -> Image.Image:
    image = gradient_background()
    draw = ImageDraw.Draw(image)
    logo_font = font(font_path, 44)
    headline_font = font(font_path, 70)
    body_font = font(font_path, 34)
    pill_font = font(font_path, 28)

    rounded_panel(draw, (110, 88, 178, 156), (247, 250, 252), radius=18)
    p_bounds = draw.textbbox((0, 0), "p", font=logo_font)
    draw.text(
        (144 - (p_bounds[2] - p_bounds[0]) / 2, 122 - (p_bounds[3] - p_bounds[1]) / 2 - p_bounds[1]),
        "p",
        font=logo_font,
        fill=NAVY,
    )
    draw.text((202, 92), "peekMyAgent", font=logo_font, fill=WHITE)
    draw.text((202, 142), "本地优先的 Agent 请求观察工作台", font=pill_font, fill=MUTED)

    headline_lines = wrap_text(draw, scene.title, headline_font, 1540)
    draw_centered_lines(draw, headline_lines, headline_font, (160, 265, 1760, 510), WHITE, 24)

    caption_lines = wrap_text(draw, scene.caption, body_font, 1450)
    draw_centered_lines(draw, caption_lines, body_font, (210, 520, 1710, 670), MUTED, 16)

    if scene.card_line:
        rounded_panel(draw, (270, 730, 1650, 865), PANEL, scene.accent, 2, 24)
        card_font = font(font_path, 34)
        card_lines = wrap_text(draw, scene.card_line, card_font, 1260)
        draw_centered_lines(draw, card_lines[:2], card_font, (315, 750, 1605, 845), WHITE, 12)
        if scene.footer:
            footer_lines = wrap_text(draw, scene.footer, pill_font, 1450)
            draw_centered_lines(draw, footer_lines[:2], pill_font, (220, 895, 1700, 970), MUTED, 10)
        draw.text((110, 1010), "Claude Code 机制演示 · v0.1", font=pill_font, fill=scene.accent)
    elif scene.scene_id == "00-intro":
        pills = ("请求与上下文", "工具调用与结果", "原始协议", "子 Agent")
        widths = [draw.textbbox((0, 0), item, font=pill_font)[2] + 76 for item in pills]
        total = sum(widths) + 30 * (len(pills) - 1)
        x = (WIDTH - total) / 2
        for label, pill_width in zip(pills, widths):
            rounded_panel(draw, (int(x), 760, int(x + pill_width), 832), PANEL, scene.accent, 2, 36)
            bounds = draw.textbbox((0, 0), label, font=pill_font)
            draw.text(
                (x + (pill_width - (bounds[2] - bounds[0])) / 2, 778),
                label,
                font=pill_font,
                fill=WHITE,
            )
            x += pill_width + 30
        draw.text((110, 982), "中文版产品演示 · v0.1", font=pill_font, fill=scene.accent)
    else:
        rounded_panel(draw, (420, 740, 1500, 858), PANEL, scene.accent, 2, 22)
        command_font = font(font_path, 38)
        command = "pma codex"
        bounds = draw.textbbox((0, 0), command, font=command_font)
        draw.text(((WIDTH - (bounds[2] - bounds[0])) / 2, 776), command, font=command_font, fill=WHITE)
        note = "完全权限参数只用于隔离、受信任的测试环境"
        note_bounds = draw.textbbox((0, 0), note, font=pill_font)
        draw.text(((WIDTH - (note_bounds[2] - note_bounds[0])) / 2, 890), note, font=pill_font, fill=MUTED)
        draw.text((110, 982), "文档：docs/quick-start.zh-CN.md", font=pill_font, fill=scene.accent)
    return image


def render_ui_scene(scene: Scene, font_path: Path) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), NAVY)
    draw = ImageDraw.Draw(image)
    title_font = font(font_path, 32)
    badge_font = font(font_path, 25)
    caption_font = font(font_path, 27)

    badge = str(int(scene.scene_id[:2]))
    rounded_panel(draw, (40, 10, 98, 56), scene.accent, radius=14)
    badge_bounds = draw.textbbox((0, 0), badge, font=badge_font)
    draw.text(
        (69 - (badge_bounds[2] - badge_bounds[0]) / 2, 18),
        badge,
        font=badge_font,
        fill=WHITE,
    )
    draw.text((118, 13), scene.title, font=title_font, fill=WHITE)

    source_path = ROOT / str(scene.image)
    if not source_path.exists():
        raise SystemExit(f"missing source image: {source_path}")
    source = Image.open(source_path).convert("RGB")
    screenshot = source.resize((1840, 949), Image.Resampling.LANCZOS)

    shadow = Image.new("RGBA", (1864, 973), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle((12, 12, 1852, 961), radius=14, fill=(0, 0, 0, 115))
    shadow = shadow.filter(ImageFilter.GaussianBlur(9))
    image.paste(shadow, (28, 48), shadow)
    image.paste(screenshot, (40, 58))
    draw.rounded_rectangle((39, 57, 1880, 1008), radius=10, outline=(70, 91, 117), width=2)

    if not SHOW_UI_CAPTION_PANEL:
        return image

    caption_box = (75, 933, 1845, 1063)
    overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    overlay_draw.rounded_rectangle(caption_box, radius=22, fill=(8, 17, 31, 238), outline=scene.accent + (255,), width=2)
    image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(image)
    caption_lines = wrap_text(draw, scene.caption, caption_font, caption_box[2] - caption_box[0] - 80)
    draw_centered_lines(draw, caption_lines[:2], caption_font, caption_box, WHITE, 10)
    return image


def render_scene(scene: Scene, target: Path, font_path: Path) -> None:
    image = render_ui_scene(scene, font_path) if scene.image else render_title_scene(scene, font_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, optimize=True)


def render_cover(font_path: Path) -> None:
    background = gradient_background()
    draw = ImageDraw.Draw(background)
    eyebrow_font = font(font_path, 30)
    title_font = font(font_path, 72)
    body_font = font(font_path, 32)
    pill_font = font(font_path, 26)

    draw.text((105, 80), COVER_EYEBROW, font=eyebrow_font, fill=BLUE)
    title_lines = [COVER_TITLE]
    draw_centered_lines(draw, title_lines, title_font, (100, 150, 1820, 300), WHITE, 12)
    body = COVER_BODY
    body_bounds = draw.textbbox((0, 0), body, font=body_font)
    draw.text(((WIDTH - (body_bounds[2] - body_bounds[0])) / 2, 320), body, font=body_font, fill=MUTED)

    source = Image.open(ROOT / COVER_SOURCE_IMAGE).convert("RGB")
    shot = source.resize((1520, 784), Image.Resampling.LANCZOS)
    shot = shot.crop((0, 0, 1520, 600))
    panel = (200, 415, 1720, 1015)
    draw.rounded_rectangle((188, 403, 1732, 1027), radius=26, fill=(0, 0, 0), outline=(61, 82, 110), width=2)
    background.paste(shot, (200, 415))
    overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    odraw.rounded_rectangle((260, 910, 1660, 1000), radius=20, fill=(8, 17, 31, 238), outline=BLUE + (255,), width=2)
    label = COVER_LABEL
    bounds = odraw.textbbox((0, 0), label, font=pill_font)
    odraw.text(((WIDTH - (bounds[2] - bounds[0])) / 2, 936), label, font=pill_font, fill=WHITE + (255,))
    background = Image.alpha_composite(background.convert("RGBA"), overlay).convert("RGB")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    background.save(OUTPUT_DIR / f"{OUTPUT_BASENAME}-cover.png", optimize=True)


def timestamp(seconds: float, separator: str = ",") -> str:
    milliseconds = int(round(seconds * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    secs, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02}{separator}{milliseconds:03}"


def subtitle_reading_weight(text: str) -> float:
    """Estimate relative spoken duration for mixed Chinese and English copy."""
    cjk_count = len(re.findall(r"[\u3400-\u9fff]", text))
    latin_tokens = re.findall(r"[A-Za-z0-9_.-]+", text)
    latin_weight = sum(max(1.5, len(token) / 3.5) for token in latin_tokens)
    strong_pauses = sum(text.count(mark) for mark in "。！？；")
    light_pauses = sum(text.count(mark) for mark in "，、：")
    return max(1.0, cjk_count + latin_weight + strong_pauses * 1.8 + light_pauses * 0.8)


def subtitle_visual_width(text: str) -> float:
    """Return an approximate width measured in full-width Chinese characters."""
    terminal_cells = sum(
        2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1
        for char in text
    )
    return terminal_cells / 2


def subtitle_cues(scene: Scene, start: float, end: float) -> list[tuple[float, float, str]]:
    """Distribute concise subtitle segments across a scene without changing its duration."""
    segments = scene.subtitle_segments or (scene.narration,)
    if not segments or any(not segment.strip() for segment in segments):
        raise SystemExit(f"subtitle verification failed: empty segment in {scene.scene_id}")
    if scene.subtitle_segments and any(subtitle_visual_width(segment) > 32 for segment in segments):
        raise SystemExit(f"subtitle verification failed: overlong segment in {scene.scene_id}")
    weights = [subtitle_reading_weight(segment) for segment in segments]
    total_weight = sum(weights)
    duration = end - start
    cues: list[tuple[float, float, str]] = []
    elapsed_weight = 0.0
    for index, (segment, weight) in enumerate(zip(segments, weights, strict=True)):
        cue_start = start + duration * elapsed_weight / total_weight
        elapsed_weight += weight
        cue_end = end if index == len(segments) - 1 else start + duration * elapsed_weight / total_weight
        cues.append((cue_start, cue_end, segment))
    if scene.subtitle_segments and any(cue_end - cue_start < 2 for cue_start, cue_end, _ in cues):
        raise SystemExit(f"subtitle verification failed: cue shorter than two seconds in {scene.scene_id}")
    return cues


def display_subtitle_text(text: str) -> str:
    for spoken, displayed in DISPLAY_SUBTITLE_REPLACEMENTS.items():
        text = text.replace(spoken, displayed)
    return text


def probe_duration(path: Path) -> float:
    return float(
        output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(path),
            ]
        )
    )


def create_voice(scene: Scene, target: Path, voice: str, rate: int, no_voice: bool) -> float:
    if no_voice:
        return scene.min_duration
    run(["say", "-v", voice, "-r", str(rate), "-o", str(target), scene.narration])
    return max(scene.min_duration, probe_duration(target) + 1.4)


def create_scene_clip(frame: Path, audio: Path, target: Path, duration: float, no_voice: bool) -> None:
    fade_out = max(0.0, duration - 0.35)
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-loop",
        "1",
        "-framerate",
        str(FPS),
        "-i",
        str(frame),
    ]
    if no_voice:
        command += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    else:
        command += ["-i", str(audio)]
    command += [
        "-vf",
        f"fade=t=in:st=0:d=0.35,fade=t=out:st={fade_out:.3f}:d=0.35,format=yuv420p",
        "-af",
        f"adelay=500|500,apad=pad_dur={duration:.3f},afade=t=in:st=0.5:d=0.25,afade=t=out:st={max(0.0, duration - 0.45):.3f}:d=0.35",
        "-t",
        f"{duration:.3f}",
        "-r",
        str(FPS),
        "-ar",
        "48000",
        "-ac",
        "2",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "19",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(target),
    ]
    run(command)


def verify_outputs(final_video: Path, srt_path: Path, timeline_path: Path, expected_duration: float) -> None:
    metadata = json.loads(
        output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=codec_name,codec_type,width,height,r_frame_rate",
                "-of",
                "json",
                str(final_video),
            ]
        )
    )
    streams = metadata["streams"]
    video = next((stream for stream in streams if stream["codec_type"] == "video"), None)
    audio = next((stream for stream in streams if stream["codec_type"] == "audio"), None)
    subtitles = next((stream for stream in streams if stream["codec_type"] == "subtitle"), None)
    if not video or (video.get("width"), video.get("height")) != (WIDTH, HEIGHT):
        raise SystemExit("video verification failed: expected 1920x1080 video stream")
    if video.get("r_frame_rate") != f"{FPS}/1":
        raise SystemExit("video verification failed: expected 30 fps")
    if not audio or audio.get("codec_name") != "aac":
        raise SystemExit("video verification failed: expected AAC audio")
    if EMBED_SUBTITLE_TRACK and (not subtitles or subtitles.get("codec_name") != "mov_text"):
        raise SystemExit("video verification failed: expected mov_text subtitles")
    if not EMBED_SUBTITLE_TRACK and subtitles:
        raise SystemExit("video verification failed: clean master unexpectedly contains subtitles")
    actual_duration = float(metadata["format"]["duration"])
    if abs(actual_duration - expected_duration) > 0.2:
        raise SystemExit(
            f"video verification failed: duration {actual_duration:.3f}s != timeline {expected_duration:.3f}s"
        )
    srt_blocks = [block for block in srt_path.read_text(encoding="utf-8").strip().split("\n\n") if block]
    timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
    expected_subtitles = sum(len(scene.subtitle_segments or (scene.narration,)) for scene in SCENES)
    if len(srt_blocks) != expected_subtitles or len(timeline["scenes"]) != len(SCENES):
        raise SystemExit("video verification failed: scene and subtitle counts differ")
    if any(
        scene["duration_seconds"] < 11
        for scene in timeline["scenes"]
        if scene["source_image"] is not None
    ):
        raise SystemExit("video verification failed: a UI scene is shorter than 11 seconds")


def build_video(args: argparse.Namespace) -> None:
    require_tools(args.no_voice)
    font_path = select_font()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    FRAME_DIR.mkdir(parents=True, exist_ok=True)
    render_cover(font_path)

    timeline: list[dict[str, object]] = []
    srt_blocks: list[str] = []
    voice_srt_blocks: list[str] = []
    subtitle_index = 1
    cursor = 0.0

    with tempfile.TemporaryDirectory(prefix="pma-demo-video-") as temp_name:
        temp_dir = Path(temp_name)
        clip_paths: list[Path] = []
        for scene in SCENES:
            frame_path = FRAME_DIR / f"{scene.scene_id}.png"
            render_scene(scene, frame_path, font_path)
            audio_path = temp_dir / f"{scene.scene_id}.aiff"
            duration = create_voice(scene, audio_path, args.voice, args.rate, args.no_voice)
            clip_path = temp_dir / f"{scene.scene_id}.mp4"
            create_scene_clip(frame_path, audio_path, clip_path, duration, args.no_voice)
            clip_paths.append(clip_path)

            start = cursor
            end = cursor + duration
            scene_subtitle_cues = subtitle_cues(scene, start, end)
            for cue_start, cue_end, cue_text in scene_subtitle_cues:
                display_text = display_subtitle_text(cue_text)
                srt_blocks.append(
                    f"{subtitle_index}\n{timestamp(cue_start)} --> {timestamp(cue_end)}\n{display_text}\n"
                )
                voice_srt_blocks.append(
                    f"{subtitle_index}\n{timestamp(cue_start)} --> {timestamp(cue_end)}\n{cue_text}\n"
                )
                subtitle_index += 1
            timeline.append(
                {
                    "id": scene.scene_id,
                    "title": scene.title,
                    "start_seconds": round(start, 3),
                    "end_seconds": round(end, 3),
                    "duration_seconds": round(duration, 3),
                    "source_image": scene.image,
                    "composite_frame": str(frame_path.relative_to(ROOT)),
                    "caption": scene.caption,
                    "narration": scene.narration,
                    "subtitle_cues": [
                        display_subtitle_text(cue_text) for _, _, cue_text in scene_subtitle_cues
                    ],
                    "voice_subtitle_cues": [cue_text for _, _, cue_text in scene_subtitle_cues],
                    "transition": "0.35s fade through black",
                }
            )
            cursor = end

        concat_path = temp_dir / "concat.txt"
        concat_path.write_text(
            "".join(f"file '{path.as_posix()}'\n" for path in clip_paths),
            encoding="utf-8",
        )
        base_video = temp_dir / f"{OUTPUT_BASENAME}-base.mp4"
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_path),
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                str(base_video),
            ]
        )

        srt_path = OUTPUT_DIR / f"{OUTPUT_BASENAME}.srt"
        srt_path.write_text("\n".join(srt_blocks), encoding="utf-8")
        voice_srt_path = OUTPUT_DIR / f"{OUTPUT_BASENAME}-voice.srt"
        voice_srt_path.write_text("\n".join(voice_srt_blocks), encoding="utf-8")
        final_video = OUTPUT_DIR / f"{OUTPUT_BASENAME}.mp4"
        mux_command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(base_video),
        ]
        if EMBED_SUBTITLE_TRACK:
            mux_command += ["-i", str(srt_path)]
        mux_command += [
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
        ]
        if EMBED_SUBTITLE_TRACK:
            mux_command += ["-map", "1:0"]
        mux_command += [
            "-c:v",
            "copy",
            "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=7",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ar",
            "48000",
        ]
        if EMBED_SUBTITLE_TRACK:
            mux_command += [
                "-c:s",
                "mov_text",
                "-metadata:s:s:0",
                "language=zho",
                "-metadata:s:s:0",
                "title=中文（简体）",
            ]
        mux_command += ["-movflags", "+faststart", str(final_video)]
        run(mux_command)
        voice_path = OUTPUT_DIR / f"{OUTPUT_BASENAME}-voice.m4a"
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(final_video),
                "-vn",
                "-c:a",
                "copy",
                str(voice_path),
            ]
        )

        if args.keep_scene_clips:
            clips_dir = SOURCE_DIR / "clips"
            clips_dir.mkdir(parents=True, exist_ok=True)
            for clip in clip_paths:
                shutil.copy2(clip, clips_dir / clip.name)

    timeline_path = SOURCE_DIR / "timeline.zh-CN.json"
    timeline_path.write_text(
        json.dumps(
            {
                "version": 1,
                "title": VIDEO_TITLE,
                "resolution": [WIDTH, HEIGHT],
                "fps": FPS,
                "duration_seconds": round(cursor, 3),
                "voice": None if args.no_voice else {"name": args.voice, "rate": args.rate},
                "music": None,
                "scenes": timeline,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    verify_outputs(
        OUTPUT_DIR / f"{OUTPUT_BASENAME}.mp4",
        OUTPUT_DIR / f"{OUTPUT_BASENAME}.srt",
        timeline_path,
        cursor,
    )

    print(f"video: {OUTPUT_DIR / f'{OUTPUT_BASENAME}.mp4'}")
    print(f"subtitles: {OUTPUT_DIR / f'{OUTPUT_BASENAME}.srt'}")
    print(f"voice subtitles: {OUTPUT_DIR / f'{OUTPUT_BASENAME}-voice.srt'}")
    print(f"voice: {OUTPUT_DIR / f'{OUTPUT_BASENAME}-voice.m4a'}")
    print(f"cover: {OUTPUT_DIR / f'{OUTPUT_BASENAME}-cover.png'}")
    print(f"timeline: {timeline_path}")
    print(f"duration: {cursor:.3f}s")


if __name__ == "__main__":
    build_video(parse_args())
