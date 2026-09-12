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

# 检测器构造有开销，模块级复用（detectAndDecode 无状态）
_qr_detector = cv2.QRCodeDetector()


def is_qr_code(disk_path: Path) -> bool:
    """图片是否为二维码（解码成功且二维码占图面积达标）。

    任何读取/解码异常一律返回 False（保守放过，绝不因质检报错而丢内容）。
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

    if not data or points is None:
        return False
    height, width = img.shape[:2]
    if width == 0 or height == 0:
        return False
    area_ratio = cv2.contourArea(points.astype(np.float32)) / (width * height)
    return area_ratio >= _MIN_QR_AREA_RATIO


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
