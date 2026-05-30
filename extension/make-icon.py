"""Render the Bob Tasks extension icon (128x128 PNG) with Pillow.

A purple rounded-square badge holding a white task-card (one checked row +
two pending rows) with a yellow auto-dispatch lightning bolt in the corner —
"queued tasks, auto-sent". Supersampled 4x then downscaled for clean edges.
"""
from PIL import Image, ImageDraw

S = 128
SS = 4  # supersample factor
W = S * SS

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

def px(v):
    return int(round(v * SS))

# vertical gradient backdrop (indigo -> violet), clipped to a rounded square
grad = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
top = (99, 102, 241)     # #6366F1
bot = (124, 58, 237)     # #7C3AED
for y in range(W):
    t = y / (W - 1)
    r = int(top[0] + (bot[0] - top[0]) * t)
    g = int(top[1] + (bot[1] - top[1]) * t)
    b = int(top[2] + (bot[2] - top[2]) * t)
    gd.line([(0, y), (W, y)], fill=(r, g, b, 255))

mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=px(28), fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)

# task card (with a soft offset shadow behind it)
d.rounded_rectangle([px(25), px(27), px(91), px(111)], radius=px(12), fill=(0, 0, 0, 40))
d.rounded_rectangle([px(24), px(22), px(90), px(106)], radius=px(12), fill=(255, 255, 255, 255))

GREEN = (34, 197, 94, 255)
GREY = (203, 213, 225, 255)
LGREY = (226, 232, 240, 255)

# row 1 — checked
d.rounded_rectangle([px(34), px(36), px(47), px(49)], radius=px(3.5), fill=GREEN)
d.line([(px(37), px(42.8)), (px(39.6), px(45.4)), (px(43.8), px(40.6))],
       fill=(255, 255, 255, 255), width=px(2.4), joint="curve")
d.rounded_rectangle([px(52), px(39), px(82), px(46)], radius=px(3.5), fill=GREY)

# row 2 — pending (empty checkbox)
d.rounded_rectangle([px(34.8), px(58.8), px(46.2), px(70.2)], radius=px(3),
                    outline=GREY, width=px(2))
d.rounded_rectangle([px(52), px(61), px(86), px(68)], radius=px(3.5), fill=LGREY)

# row 3 — pending
d.rounded_rectangle([px(34.8), px(80.8), px(46.2), px(92.2)], radius=px(3),
                    outline=GREY, width=px(2))
d.rounded_rectangle([px(52), px(83), px(74), px(90)], radius=px(3.5), fill=LGREY)

# auto-dispatch lightning badge (bottom-right)
cx, cy, rad = px(97), px(97), px(21)
d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=(251, 191, 36, 255),
          outline=(255, 255, 255, 255), width=px(3))
bolt = [(px(100), px(84)), (px(88), px(100)), (px(95), px(100)),
        (px(92), px(112)), (px(106), px(94)), (px(99), px(94))]
d.polygon(bolt, fill=(255, 255, 255, 255))

out = img.resize((S, S), Image.LANCZOS)
out.save("icon.png")
print("wrote icon.png", out.size, out.mode)
