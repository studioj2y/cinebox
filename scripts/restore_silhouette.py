"""恢复原版白色剪影(直线化之前的版本)。

源图是 process_logo.py 时期的同一张底图(白底黑色剪影)。
process_logo.py 当时指向的 images/logo-original.png 路径已失效,
实际底图备份在 scripts/_logo-source.png。

输出: images/logo-silhouette.png 覆盖当前直线化版本。
"""
from PIL import Image, ImageFilter

SRC = r"D:/DHZQ/workbuddy/Ideas/movie-mood/scripts/_logo-source.png"
DST = r"D:/DHZQ/workbuddy/Ideas/movie-mood/images/logo-silhouette.png"

img = Image.open(SRC).convert("RGBA")
print("source:", img.size, img.mode)

w, h = img.size
out = Image.new("RGBA", (w, h), (0, 0, 0, 0))

for x in range(w):
    for y in range(h):
        r, g, b, a = img.getpixel((x, y))
        if r > 235 and g > 235 and b > 235:
            continue  # 白底 -> 透明
        brightness = (r + g + b) / 3.0 / 255.0
        alpha = int(min(255, max(0, (1.0 - brightness) * 255 * 1.1)))
        if brightness > 0.5:
            out.putpixel((x, y), (r, g, b, alpha))   # 边缘保留原色做抗锯齿
        else:
            out.putpixel((x, y), (255, 255, 255, alpha))  # 主体纯白

# alpha 通道单独做轻微高斯模糊,消除像素锯齿
r_ch, g_ch, b_ch, a_ch = out.split()
a_blur = a_ch.filter(ImageFilter.GaussianBlur(radius=0.8))
out_smooth = Image.merge("RGBA", (r_ch, g_ch, b_ch, a_blur))

out_smooth.save(DST, optimize=True)
print("restored original white silhouette ->", DST, out_smooth.size)
