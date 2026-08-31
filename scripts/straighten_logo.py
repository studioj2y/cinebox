"""安全直线化：只处理右侧身体的 y=100..240 行（去掉胸/腰曲线），
头部、左臂、髋部/裙摆一律不动。"""
from PIL import Image

DST = r"D:/DHZQ/workbuddy/Ideas/movie-mood/images/logo-silhouette.png"
im = Image.open(DST).convert("RGBA")
W, H = im.size
A = bytearray(im.split()[3].tobytes())
r_ch, g_ch, b_ch, _ = im.split()


def right_at(y):
    s = y * W
    for x in range(W - 1, -1, -1):
        if A[s + x] > 128:
            return x
    return -1


# 硬编码安全范围：肩部(100) 到 腰下方(240)
body_top = 100
body_bottom = 240
top_x = right_at(body_top)
bot_x = right_at(body_bottom)
print(f"body_top={body_top} top_x={top_x}  body_bottom={body_bottom} bot_x={bot_x}")

if top_x < 0 or bot_x < 0:
    raise SystemExit("right_at 失败，未找到边缘")

# 直线化
for y in range(body_top, body_bottom + 1):
    cur = right_at(y)
    if cur < 0:
        continue
    t = (y - body_top) / (body_bottom - body_top)
    tgt = int(round(top_x * (1 - t) + bot_x * t))
    if cur > tgt:
        for x in range(tgt + 1, cur + 1):
            if 0 <= x < W:
                A[y * W + x] = 0
        if 0 <= tgt < W:
            A[y * W + tgt] = 140
    elif cur < tgt:
        for x in range(cur + 1, tgt + 1):
            if 0 <= x < W:
                A[y * W + x] = 255
        if 0 <= cur + 1 < W:
            A[y * W + cur + 1] = 140

new_a = Image.frombytes("L", (W, H), bytes(A))
out = Image.merge("RGBA", (r_ch, g_ch, b_ch, new_a))
out.save(DST, optimize=True)

# 预览到深色底
bg = Image.new("RGBA", (W, H), (26, 10, 46, 255))
Image.alpha_composite(bg, out).convert("RGB").save(r"D:/DHZQ/workbuddy/Ideas/movie-mood/images/preview-LOGO.png")
print("straightened + preview saved")
