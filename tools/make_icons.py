"""アイコン (icons/icon-180.png / 192 / 512) を作る。標準ライブラリだけで PNG を書く。

    python tools/make_icons.py

図柄: 濃紺の地に、QR の位置合わせマーク 3 つと、右下にチェック印。
"""
import os
import struct
import zlib

BG = (18, 22, 28)
FG = (238, 242, 246)
ACCENT = (59, 130, 246)

# 21 x 21 のマス目 (1 = 白)。位置合わせマーク 3 つ + まばらな点 + 右下は空けてチェック印を重ねる
GRID = 21


def finder(cells, r0, c0):
    for r in range(7):
        for c in range(7):
            edge = r in (0, 6) or c in (0, 6)
            core = 2 <= r <= 4 and 2 <= c <= 4
            if edge or core:
                cells.add((r0 + r, c0 + c))


def build_cells():
    cells = set()
    finder(cells, 0, 0)
    finder(cells, 0, GRID - 7)
    finder(cells, GRID - 7, 0)
    # 決め打ちの点 (乱数は使わない = 何度作っても同じ絵)
    for r in range(GRID):
        for c in range(GRID):
            in_finder = (r < 8 and c < 8) or (r < 8 and c >= GRID - 8) or (r >= GRID - 8 and c < 8)
            in_check = r >= 11 and c >= 11
            if in_finder or in_check:
                continue
            if (r * 7 + c * 13 + (r * c) % 5) % 3 == 0:
                cells.add((r, c))
    return cells


def render(size):
    cells = build_cells()
    margin = size * 0.14
    cell = (size - margin * 2) / GRID
    px = [[BG] * size for _ in range(size)]
    for (r, c) in cells:
        y0, y1 = int(margin + r * cell), int(margin + (r + 1) * cell)
        x0, x1 = int(margin + c * cell), int(margin + (c + 1) * cell)
        for y in range(y0, y1):
            row = px[y]
            for x in range(x0, x1):
                row[x] = FG

    # チェック印 (右下の 10 x 10 マスの領域に、太い折れ線)
    def seg(ax, ay, bx, by, width):
        steps = int(max(abs(bx - ax), abs(by - ay)) * 2) + 1
        half = width / 2
        for i in range(steps + 1):
            t = i / steps
            cx, cy = ax + (bx - ax) * t, ay + (by - ay) * t
            for y in range(int(cy - half), int(cy + half) + 1):
                if 0 <= y < size:
                    for x in range(int(cx - half), int(cx + half) + 1):
                        if 0 <= x < size and (x - cx) ** 2 + (y - cy) ** 2 <= half * half:
                            px[y][x] = ACCENT

    ox, oy = margin + 11.5 * cell, margin + 11.5 * cell
    w = 9 * cell
    seg(ox + 0.05 * w, oy + 0.55 * w, ox + 0.38 * w, oy + 0.88 * w, cell * 1.9)
    seg(ox + 0.38 * w, oy + 0.88 * w, ox + 0.98 * w, oy + 0.12 * w, cell * 1.9)
    return px


def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for row in px:
        raw.append(0)
        for (r, g, b) in row:
            raw += bytes((r, g, b))

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    os.makedirs(out, exist_ok=True)
    for size in (180, 192, 512):
        path = os.path.join(out, 'icon-%d.png' % size)
        write_png(path, render(size))
        print('wrote', os.path.normpath(path))


if __name__ == '__main__':
    main()
