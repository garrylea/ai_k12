// mac_ocr.swift — 用 macOS 自带的 Vision 做本地 OCR（不占 MinerU 额度）
//
// 为什么要自己写而不是直接用 pdftotext：
//   1. 课标 PDF（尤其义务教育 2022 版）是**扫描件**，没有文字层
//   2. 单词表是**双栏排版**，普通 OCR 会左右串行读成一团
// 所以本工具输出**带坐标**的逐条结果（TSV），由调用方按栏重建阅读顺序。
//
// 编译：swiftc -O -o mac_ocr mac_ocr.swift -framework Vision -framework CoreGraphics
// 用法：mac_ocr <pdf路径> <起始页(1基)> <结束页(1基)> [渲染倍率，默认 3.0] [语言，默认 zh-Hans,en-US]
// 输出：TSV，制表符分隔：page \t x \t y \t w \t h \t conf \t text
//       坐标为归一化值（Vision 约定：原点在**左下**）
//
// ⚠️ 语言提示很关键：单词表页几乎全是拉丁字母，若同时给 zh-Hans，Vision 会把一部分拉丁串
// 当中文硬解、输出乱码（实测同一页 clean 图像下 always/and/angry/animal 被识别成
// SABMTE/pue/KiBue/［BuuTuE）。纯英文页必须只给 en-US。

import Foundation
import CoreGraphics
import Vision

let args = CommandLine.arguments
guard args.count >= 4,
      let startPage = Int(args[2]),
      let endPage = Int(args[3]) else {
    FileHandle.standardError.write("用法: mac_ocr <pdf路径> <起始页> <结束页> [倍率] [语言]\n".data(using: .utf8)!)
    exit(2)
}
let pdfPath = args[1]
let scale: CGFloat = args.count >= 5 ? CGFloat(Double(args[4]) ?? 3.0) : 3.0
let languages: [String] = args.count >= 6
    ? args[5].split(separator: ",").map(String.init)
    : ["zh-Hans", "en-US"]

// 用 fileURLWithPath 而不是拼 "file://" 字符串：相对路径、中文名、空格都能正确处理
let url = URL(fileURLWithPath: pdfPath) as CFURL
guard let doc = CGPDFDocument(url) else {
    FileHandle.standardError.write("打不开 PDF: \(pdfPath)\n".data(using: .utf8)!)
    exit(1)
}

let total = doc.numberOfPages
let from = max(1, startPage)
let to = min(total, endPage)

/// 把一页 PDF 渲染成 CGImage。PDF 坐标原点在左下，CGBitmapContext 亦然，故不需翻转。
func render(_ page: CGPDFPage, scale: CGFloat) -> CGImage? {
    let box = page.getBoxRect(.mediaBox)
    let w = Int(box.width * scale)
    let h = Int(box.height * scale)
    guard w > 0, h > 0 else { return nil }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: 0, space: colorSpace,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    // 白底：扫描件本身有底，但保险起见先铺白，避免透明区域被识别成噪声
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    ctx.drawPDFPage(page)
    return ctx.makeImage()
}

let out = FileHandle.standardOutput
func emit(_ s: String) { out.write((s + "\n").data(using: .utf8)!) }

for p in from...to {
    guard let page = doc.page(at: p), let img = render(page, scale: scale) else { continue }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = true
    // 单词表里 `*` / `**` 是分层标记、`（）` 里是美式拼写，别让语言模型当噪声清掉
    request.automaticallyDetectsLanguage = false
    if #available(macOS 13.0, *) { request.revision = VNRecognizeTextRequestRevision3 }

    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    do {
        try handler.perform([request])
    } catch {
        FileHandle.standardError.write("第 \(p) 页识别失败: \(error)\n".data(using: .utf8)!)
        continue
    }

    guard let obs = request.results else { continue }
    for o in obs {
        guard let cand = o.topCandidates(1).first else { continue }
        let bb = o.boundingBox   // 归一化，原点左下
        // 制表符/换行会破坏 TSV，替换为空格
        let text = cand.string.replacingOccurrences(of: "\t", with: " ")
                               .replacingOccurrences(of: "\n", with: " ")
        emit("\(p)\t\(bb.minX)\t\(bb.minY)\t\(bb.width)\t\(bb.height)\t\(cand.confidence)\t\(text)")
    }
}
