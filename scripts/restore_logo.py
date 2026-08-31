"""只做第 1 步：把原图转白色剪影。用来恢复基础图。"""
from PIL import Image, ImageFilter

SRC = r"D:/DHZQ/workbuddy/Ideas/movie-mood/images/_src.png"
DST = r"D:/DHZQ/workbuddy/Ideas/movie-mood/images/logo-silhouette.png"

gray = Image.open(SRC).convert("L")
alpha_im = gray.point(lambda v: 255 - v)
alpha_blur = alpha_im.filter(ImageFilter.GaussianBlur(radius=0.8))
W, H = gray.size
white = Image.new("L", (W, H), 255)
out = Image.merge("RGBA", (white, white, white, alpha_blur))
out.save(DST, optimize=True)
print("restored white silhouette:", out.size)
