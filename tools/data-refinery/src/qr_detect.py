"""二维码图片判定与剔除：试卷切题前把二维码图片从文本里去掉。

判定规则：``cv2.QRCodeDetector`` 解码成功 **且** 二维码多边形占图面积 ≥
``_MIN_QR_AREA_RATIO`` 才视为二维码。面积护栏用于区分两种情况：

- 独立二维码小图（真实语料实测占图 0.86–0.93）→ 丢弃；
- 真实配图角落里恰好有一个二维码（实测占图 0.014）→ 保留整张图。

调用时机：试卷路径 ``question_extract.extract_questions_file`` 的答案合并之后、
``split_page`` 切题之前（教材卡路径走 ``image_scan`` 的小图标规则，不走本模块）。
"""

from pathlib import Path

import cv2
import numpy as np

from image_scan import _IMAGE_REF_RE, _resolve_disk_path

# 二维码占图面积比下限：真实语料 0.86+，带 quiet zone 的合成二维码 0.61，
# 而「大图角落贴二维码」仅 0.014 —— 0.3 与误删场景有 20 倍以上安全间隔。
_MIN_QR_AREA_RATIO = 0.3

# 带 logo 水印的二维码（公众号码中间盖一块「北京中考」绿标）opencv 的
# detectAndDecode 完全解不出（detect 也返回 None），只能靠形态兜底。
# 实测这批：126-176 正方、Otsu 后黑占比 0.44-0.47、Canny 边缘密度 0.19-0.29；
# 真实配图黑占比 0.05-0.06、边缘 0.07、宽高比 1.3-2.7。四条同时满足才判，
# 且尺寸上限 400 保证「大图角落贴码」不会命中。
_QR_FALLBACK_MAX_SIDE = 400
_QR_FALLBACK_MIN_SIDE = 60
_QR_FALLBACK_BLACK = (0.35, 0.62)
_QR_FALLBACK_EDGE = 0.15
_QR_FALLBACK_ASPECT = (0.85, 1.18)

# 检测器构造有开销，模块级复用（detectAndDecode 无状态）
_qr_detector = cv2.QRCodeDetector()


def _looks_like_qr(img) -> bool:
    """解码失败时的形态兜底：小尺寸、近正方、黑白各半、边缘密集。

    只看统计特征，不依赖可解码性。阈值与真实配图有 5 倍以上间隔，
    宁可漏判（留下二维码）也不误删配图。
    """
    height, width = img.shape[:2]
    if not (_QR_FALLBACK_MIN_SIDE <= min(height, width)
            and max(height, width) <= _QR_FALLBACK_MAX_SIDE):
        return False
    if not (_QR_FALLBACK_ASPECT[0] <= width / height <= _QR_FALLBACK_ASPECT[1]):
        return False
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    black = float((binary == 0).mean())
    if not (_QR_FALLBACK_BLACK[0] <= black <= _QR_FALLBACK_BLACK[1]):
        return False
    return float((cv2.Canny(gray, 100, 200) > 0).mean()) >= _QR_FALLBACK_EDGE


def is_qr_code(disk_path: Path) -> bool:
    """图片是否为二维码（解码成功且占图面积达标，或形态高度疑似）。

    任何读取/解码异常一律返回 False（保守放过，绝不因质检报错而丢内容）。
    带 logo 水印的码解不出，走 `_looks_like_qr` 的形态兜底。
    """
    try:
        buf = np.fromfile(str(disk_path), dtype=np.uint8)
        if buf.size == 0:
            return False
        # 用 imdecode 而非 imread：中文路径（output/md/数学/...）在个别平台会读不到
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if img is None:
            return False
        data, points, _ = _qr_detector.detectAndDecode(img)
    except Exception:
        return False

    if data and points is not None:
        height, width = img.shape[:2]
        if width == 0 or height == 0:
            return False
        area_ratio = cv2.contourArea(points.astype(np.float32)) / (width * height)
        return area_ratio >= _MIN_QR_AREA_RATIO
    return _looks_like_qr(img)


def strip_qr_images(text: str, md_images_dir: Path) -> str:
    """删除 ``text`` 中二维码图片引用；无命中则原样返回（保证幂等）。

    镜像 ``image_scan.scan_page`` 的两遍式做法：先收集命中二维码的 ref，再逐行处理。
    二维码独占一行时整行删掉；行内还有正文时只摘掉引用本身、保留正文
    （绝不因为删图而丢题干文字）。
    """
    if not text:
        return text

    dropped: set[str] = set()
    for m in _IMAGE_REF_RE.finditer(text):
        ref = m.group(2)
        if ref in dropped:
            continue
        disk_path = _resolve_disk_path(ref, md_images_dir)
        if disk_path is not None and is_qr_code(disk_path):
            dropped.add(ref)
    if not dropped:
        return text

    kept_lines: list[str] = []
    for line in text.split("\n"):
        if not any(m.group(2) in dropped for m in _IMAGE_REF_RE.finditer(line)):
            kept_lines.append(line)
            continue
        remainder = _IMAGE_REF_RE.sub(
            lambda m: "" if m.group(2) in dropped else m.group(0), line
        ).strip()
        if remainder:  # 整行只剩二维码引用时不进 kept，等价于删行
            kept_lines.append(remainder)
    return "\n".join(kept_lines).strip()
