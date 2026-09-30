"""生成番茄钟应用图标（PNG + SVG）。无第三方依赖。"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
os.makedirs(OUT, exist_ok=True)

try:
    import numpy as np
    HAS_NP = True
except Exception:
    HAS_NP = False

RED = (0xFF, 0x6B, 0x5A)
MINT = (0x6F, 0xC7, 0xB6)
WHITE = (0xFF, 0xFF, 0xFF)


def srgb(c, a):
    return (c[0], c[1], c[2], int(round(a * 255)))


def write_png(path, w, h, buf):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))
    raw = b''.join(b'\x00' + buf[y * w * 4:(y + 1) * w * 4] for y in range(h))
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


# ---------------- 形状判定（归一化坐标 0..1） ----------------

RING_CX, RING_CY = 0.5, 0.565
RING_R = 0.255
RING_SW = 0.072
GAP_HALF = 26.0          # 顶部缺口半角（度）
DOT_R = 0.052
LEAF_CX, LEAF_CY = 0.5, 0.248
LEAF_RX, LEAF_RY = 0.132, 0.052
STEM_W, STEM_TOP, STEM_BOT = 0.030, 0.196, 0.276


def rounded_rect_alpha(x, y, r):
    """圆角方形（边长 1，圆角半径 r）的覆盖度，返回 0..1"""
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    dx, dy = x - cx, y - cy
    d = math.hypot(dx, dy)
    if d <= r:
        return 1.0
    return max(0.0, min(1.0, r - d + 0.5))


def in_ring(x, y):
    d = math.hypot(x - RING_CX, y - RING_CY)
    if abs(d - RING_R) > RING_SW / 2:
        return False
    ang = math.degrees(math.atan2(y - RING_CY, x - RING_CX))
    a = (ang + 90.0) % 360.0          # 0 = 正上方，顺时针
    return not (a < GAP_HALF or a > 360.0 - GAP_HALF)


def in_leaf(x, y):
    if ((x - LEAF_CX) / LEAF_RX) ** 2 + ((y - LEAF_CY) / LEAF_RY) ** 2 <= 1.0:
        return True
    if abs(x - 0.5) <= STEM_W / 2 and STEM_TOP <= y <= STEM_BOT:
        return True
    return False


def color_at(x, y, corner_r, content_scale=1.0):
    """返回 (r,g,b,a) 0..255。背景满幅（maskable）与内容缩放相互独立。"""
    a_bg = rounded_rect_alpha(x, y, corner_r)
    if a_bg <= 0:
        return (0, 0, 0, 0)
    cx = 0.5 + (x - 0.5) / content_scale
    cy = 0.5 + (y - 0.5) / content_scale
    r, g, b = RED
    if in_leaf(cx, cy):
        r, g, b = MINT
    elif in_ring(cx, cy) or math.hypot(cx - RING_CX, cy - RING_CY) <= DOT_R:
        r, g, b = WHITE
    return (r, g, b, int(round(a_bg * 255)))


def render(size, maskable=False, ss=3):
    content_scale = 0.72 if maskable else 1.0
    corner_r = 0.0 if maskable else 0.235
    big = size * ss
    buf = bytearray(big * big * 4)
    inv = 1.0 / big
    for py in range(big):
        y = (py + 0.5) * inv
        row = py * big * 4
        for px in range(big):
            x = (px + 0.5) * inv
            c = color_at(x, y, corner_r, content_scale)
            i = row + px * 4
            buf[i] = c[0]
            buf[i + 1] = c[1]
            buf[i + 2] = c[2]
            buf[i + 3] = c[3]

    if HAS_NP:
        arr = np.frombuffer(bytes(buf), dtype=np.uint8).reshape(big, big, 4).astype(np.float64)
        # 预乘 alpha 后降采样，避免边缘发黑
        a = arr[:, :, 3:4] / 255.0
        arr[:, :, :3] *= a
        k = ss
        arr = arr.reshape(size, k, size, k, 4).mean(axis=(1, 3))
        a2 = arr[:, :, 3:4] / 255.0
        rgb = np.where(a2 > 0, arr[:, :, :3] / np.maximum(a2, 1e-6), 0)
        out = np.concatenate([np.clip(rgb, 0, 255), np.clip(arr[:, :, 3:4], 0, 255)], axis=2)
        return out.astype(np.uint8).tobytes()

    # 纯 Python 降采样
    out = bytearray(size * size * 4)
    k2 = ss * ss
    for oy in range(size):
        for ox in range(size):
            sr = sg = sb = sa = 0
            for dy in range(ss):
                base = ((oy * ss + dy) * big + ox * ss) * 4
                for dx in range(ss):
                    i = base + dx * 4
                    al = buf[i + 3]
                    sr += buf[i] * al
                    sg += buf[i + 1] * al
                    sb += buf[i + 2] * al
                    sa += al
            o = (oy * size + ox) * 4
            if sa:
                out[o] = min(255, sr // sa)
                out[o + 1] = min(255, sg // sa)
                out[o + 2] = min(255, sb // sa)
            out[o + 3] = sa // k2
    return bytes(out)


SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="120" fill="#FF6B5A"/>
  <path d="M256 286.4 A130.6 130.6 0 1 1 199 168.7"
        fill="none" stroke="#FFFFFF" stroke-width="36.8" stroke-linecap="round"
        transform="rotate(0 256 289.3)"/>
  <ellipse cx="256" cy="127" rx="67.6" ry="26.6" fill="#6FC7B6"/>
  <rect x="248.3" y="100.4" width="15.4" height="41" rx="7.7" fill="#6FC7B6"/>
  <circle cx="256" cy="289.3" r="26.6" fill="#FFFFFF"/>
</svg>
'''


def main():
    jobs = [
        ('icon-192.png', 192, False, 4),
        ('icon-512.png', 512, False, 3),
        ('icon-maskable-512.png', 512, True, 3),
        ('icon-1024.png', 1024, False, 2),
        ('tray-16.png', 16, False, 10),
        ('tray-32.png', 32, False, 8),
        ('tray-64.png', 64, False, 6),
    ]
    for name, size, maskable, ss in jobs:
        data = render(size, maskable, ss)
        write_png(os.path.join(OUT, name), size, size, data)
        print('wrote', name, size)
    with open(os.path.join(OUT, 'icon.svg'), 'w', encoding='utf-8') as f:
        f.write(SVG)
    print('wrote icon.svg  (numpy=%s)' % HAS_NP)


if __name__ == '__main__':
    main()
