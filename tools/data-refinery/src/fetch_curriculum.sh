#!/usr/bin/env bash
# 下载英语课程标准官方原件（教育部官网直链）。
#
# 为什么要有这个脚本（而不是把 PDF 提交进仓库）：
#   1. 义务教育那份 30MB、高中那份含在 38MB 的 zip 里，二进制进 git 不合适
#      （仓库根 .gitignore 已有 `data/`，所以这些文件本来就被忽略）
#   2. 「词库一定要准确」的前提是**来源可追溯**——把官方 URL 固定在代码里，
#      任何人任何时候都能重新下载、核对，而不是依赖某个转手过的文件
#
# ⚠️ 绝对不要改用百度文库/豆丁之类的转载版：实测其中有的副本自带
#    「文档部分内容可能由AI生成」标记，词表会被悄悄改错。
#
# 用法：bash tools/data-refinery/src/fetch_curriculum.sh
set -euo pipefail

OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/curriculum"
mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

UA="Mozilla/5.0"

echo "[1/2] 义务教育英语课程标准（2022年版）"
# 来源：教育部《关于印发义务教育课程方案和课程标准（2022年版）的通知》
#       https://www.moe.gov.cn/srcsite/A26/s8001/202204/t20220420_619921.html
# 注意：这一份是**扫描件**（201 页无文字层），必须 OCR。用 src/mac_ocr.swift。
curl -sSL -A "$UA" -o "义务教育英语课程标准2022.pdf" \
  "http://www.moe.gov.cn/srcsite/A26/s8001/202204/W020220420582349487953.pdf"
echo "      -> $(du -h 义务教育英语课程标准2022.pdf | cut -f1)"

echo "[2/2] 普通高中英语课程标准（2017年版2020年修订）"
# 来源：教育部《关于印发普通高中课程方案和语文等学科课程标准（2017年版2020年修订）的通知》
#       https://www.moe.gov.cn/srcsite/A26/s8001/202006/t20200603_462199.html
# 附件是一个 zip，里面 21 份课标；zip 内文件名是 **GBK** 编码，
# 直接 unzip 会得到乱码，故交给 python 解码后只取英语那一份。
curl -sSL -A "$UA" -o "高中课标2020修订.zip" \
  "http://www.moe.gov.cn/srcsite/A26/s8001/202006/W020200603315372317586.zip"
echo "      -> zip $(du -h 高中课标2020修订.zip | cut -f1)"

python3 - <<'PY'
import zipfile, pathlib, shutil
zp = pathlib.Path("高中课标2020修订.zip")
out = pathlib.Path("高中"); out.mkdir(exist_ok=True)
dest = out / "普通高中英语课程标准2017版2020修订.pdf"
with zipfile.ZipFile(zp) as z:
    for info in z.infolist():
        if info.is_dir():
            continue
        # zip 里文件名是 GBK，被当成 cp437 读进来 → 反解回中文才能匹配「英语」
        try:
            name = info.filename.encode("cp437").decode("gbk")
        except Exception:
            name = info.filename
        if "英语" in name:
            with z.open(info) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)
            print(f"      -> {dest} ({dest.stat().st_size/1024/1024:.1f} MB)")
            break
    else:
        raise SystemExit("zip 里没找到英语课标，检查附件是否变更")
PY

echo
echo "完成。两份原件都在 $OUT_DIR"
echo "下一步：用 src/mac_ocr.swift 抽出附录词汇表（义务教育版是扫描件，必须 OCR）。"
