"""Build lightweight README GIFs from capture-readme.mjs frames.

Run: python3 -m pip install pillow
     python3 tools/build-readme-gifs.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "docs" / "media"
FRAMES = MEDIA / "frames"


def make_gif(name, shots, height):
    frames = []
    for filename, caption in shots:
        with Image.open(FRAMES / filename) as source:
            screenshot = source.convert("RGB").crop((0, 0, 1440, height))
        screenshot = screenshot.resize((960, round(height * 2 / 3)), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (960, screenshot.height + 38), "#243c2c")
        canvas.paste(screenshot, (0, 38))
        draw = ImageDraw.Draw(canvas)
        draw.text((16, 11), caption, fill="white", font=ImageFont.load_default(size=17))
        frames.append(canvas.quantize(colors=96, method=Image.Quantize.FASTOCTREE))
    frames[0].save(MEDIA / name, save_all=True, append_images=frames[1:], duration=[1400] * len(frames),
                   loop=0, disposal=2, optimize=True)


make_gif("timeline-views.gif", [
    ("timeline-01.png", "01  Plan work across time"),
    ("timeline-02.png", "02  Check the calendar"),
    ("timeline-03.png", "03  See work by status"),
    ("timeline-04.png", "04  Scan the full list"),
], 620)
make_gif("devops-card.gif", [
    ("devops-01.png", "01  See the whole delivery board"),
    ("devops-02.png", "02  Open a card for details and checklists"),
    ("devops-03.png", "03  Return to the board"),
], 900)
print("Built docs/media/timeline-views.gif and devops-card.gif")
