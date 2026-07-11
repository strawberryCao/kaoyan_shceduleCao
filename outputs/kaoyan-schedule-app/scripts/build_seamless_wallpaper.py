"""Build a crisp, camera-locked, mathematically seamless Dunhuang wallpaper loop.

The background never moves. Only several softly feathered silk regions receive
very small periodic offsets. Frame 0 and the virtual frame after the last frame
have identical phase, so native video looping has no reset jump.
"""

from __future__ import annotations

import argparse
import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--poster", required=True)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--seconds", type=int, default=10)
    return parser.parse_args()


def make_mask(size: tuple[int, int], polygons: list[list[tuple[float, float]]], blur: int) -> Image.Image:
    width, height = size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for polygon in polygons:
        draw.polygon([(round(x * width), round(y * height)) for x, y in polygon], fill=255)
    return mask.filter(ImageFilter.GaussianBlur(blur))


def shifted(image: Image.Image, dx: float, dy: float) -> Image.Image:
    return image.transform(
        image.size,
        Image.Transform.AFFINE,
        (1, 0, -dx, 0, 1, -dy),
        resample=Image.Resampling.BICUBIC,
    )


def main() -> None:
    args = parse_args()
    output = Path(args.output)
    poster = Path(args.poster)
    output.parent.mkdir(parents=True, exist_ok=True)
    poster.parent.mkdir(parents=True, exist_ok=True)

    source = Image.open(args.image).convert("RGB")
    target_ratio = args.width / args.height
    source_ratio = source.width / source.height
    if source_ratio > target_ratio:
        crop_width = round(source.height * target_ratio)
        left = (source.width - crop_width) // 2
        source = source.crop((left, 0, left + crop_width, source.height))
    elif source_ratio < target_ratio:
        crop_height = round(source.width / target_ratio)
        top = (source.height - crop_height) // 2
        source = source.crop((0, top, source.width, top + crop_height))

    base = source.resize((args.width, args.height), Image.Resampling.LANCZOS)
    base.save(poster, format="PNG", optimize=True)

    # Normalized masks follow the large silk groups in the selected source art.
    # Their broad feathering prevents a hard edge or any elliptical glow patch.
    upper_mask = make_mask(
        base.size,
        [[(0.50, 0.00), (1.00, 0.00), (1.00, 0.58), (0.78, 0.62), (0.58, 0.42)]],
        42,
    )
    lower_mask = make_mask(
        base.size,
        [[(0.00, 0.66), (0.32, 0.70), (0.58, 0.61), (0.86, 0.69), (1.00, 0.56), (1.00, 1.00), (0.00, 1.00)]],
        46,
    )
    middle_mask = make_mask(
        base.size,
        [[(0.48, 0.25), (0.78, 0.18), (0.91, 0.37), (0.77, 0.57), (0.53, 0.52)]],
        34,
    )

    frame_count = args.fps * args.seconds
    command = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{args.width}x{args.height}", "-r", str(args.fps), "-i", "-",
        "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
        "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-g", str(args.fps * 2),
        str(output),
    ]

    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame_number in range(frame_count):
            phase = math.tau * frame_number / frame_count
            frame = base.copy()

            upper = shifted(base, 3.2 * math.sin(phase), 1.8 * math.sin(phase + 0.65))
            frame.paste(upper, (0, 0), upper_mask)

            middle = shifted(base, 2.2 * math.sin(phase + 1.8), 1.4 * math.sin(phase + 2.25))
            frame.paste(middle, (0, 0), middle_mask)

            lower = shifted(base, -2.8 * math.sin(phase + 0.9), 1.6 * math.sin(phase + 1.35))
            frame.paste(lower, (0, 0), lower_mask)

            process.stdin.write(frame.tobytes())
    finally:
        process.stdin.close()

    if process.wait() != 0:
        raise SystemExit("ffmpeg failed while encoding the seamless wallpaper")


if __name__ == "__main__":
    main()
