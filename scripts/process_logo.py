"""把白底黑色剪影图处理成白色剪影+透明背景+边缘反走样。"""
from PIL import Image, ImageFilter

src = r"D:/DHZQ/workbuddy/Ideas/movie-mood/images/logo-original.png"
dst = r"D:/DHZQ/workbuddy/Ideas/movie-mood/images/logo-silhouette.png"

img = Image.open(src).convert("RGBA")
print("原图尺寸:", img.size, "模式:", img.mode)

w, h = img.size
out = Image.new("RGBA", (w, h), (0, 0, 0, 0))

# 白底透明，主体变纯白；边缘灰度做 alpha 渐变（反走样）
for x in range(w):
    for y in range(h):
        r, g, b, a = img.getpixel((x, y))
        if r > 235 and g > 235 and b > 235:
            continue  # 背景透明
        brightness = (r + g + b) / 3.0 / 255.0
        alpha = int(min(255, max(0, (1.0 - brightness) * 255 * 1.1)))
        if brightness > 0.5:
            # 边缘灰带：保留原色做平滑过渡
            out.putpixel((x, y), (r, g, b, alpha))
        else:
            # 主体纯白剪影
            out.putpixel((x, y), (255, 255, 255, alpha))

# alpha 通道单独做轻微高斯模糊，消除像素锯齿（这是产生锯齿的主因）
r_ch, g_ch, b_ch, a_ch = out.split()
a_blur = a_ch.filter(ImageFilter.GaussianBlur(radius=0.8))
out_smooth = Image.merge("RGBA", (r_ch, g_ch, b_ch, a_blur))

out_smooth.save(dst)
print("输出:", out_smooth.size, "->", dst)