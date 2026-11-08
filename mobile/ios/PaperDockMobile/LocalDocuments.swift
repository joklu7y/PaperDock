// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import ImageIO
import PDFKit
import UIKit
import Vision

enum LocalDocuments {
    static func isPDF(_ url: URL) -> Bool { url.pathExtension.lowercased() == "pdf" }

    static func validate(_ urls: [URL]) throws {
        guard (1...10).contains(urls.count) else { throw Issue("一次请选择 1 到 10 张图片或一份 PDF。") }
        guard !urls.contains(where: isPDF) || urls.count == 1 else { throw Issue("请单独导入一份 PDF。") }
    }

    static func recognize(_ urls: [URL]) throws -> String {
        try validate(urls)
        if let url = urls.first, isPDF(url) {
            return try withAccess(url) {
                let fileSize = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard fileSize <= 50 * 1024 * 1024 else { throw Issue("预览版支持 50 MB 以内的 PDF。") }
                guard let pdf = PDFDocument(url: url), !pdf.isLocked else { throw Issue("无法打开 PDF，或文件需要密码。") }
                guard (1...20).contains(pdf.pageCount) else { throw Issue("预览版一次最多识别 20 页 PDF。") }
                return try (0..<pdf.pageCount).compactMap { index -> String? in
                    try autoreleasepool {
                        guard let page = pdf.page(at: index) else { throw Issue("无法读取第 \(index + 1) 页。") }
                        let native = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        let text: String
                        if native.isEmpty {
                            let bounds = page.bounds(for: .mediaBox)
                            let factor = 1800 / max(bounds.width, bounds.height, 1)
                            let size = CGSize(width: max(1, bounds.width * factor), height: max(1, bounds.height * factor))
                            guard let image = page.thumbnail(of: size, for: .mediaBox).cgImage else { throw Issue("无法渲染第 \(index + 1) 页。") }
                            text = try recognizeImage(image)
                        } else {
                            text = native
                        }
                        return text.isEmpty ? nil : "第 \(index + 1) 页\n\(text)"
                    }
                }.joined(separator: "\n\n")
            }
        }
        return try urls.compactMap { url -> String? in
            try autoreleasepool {
                let text = try withAccess(url) { try recognizeImage(image(at: url)) }
                return text.isEmpty ? nil : text
            }
        }.joined(separator: "\n\n")
    }

    static func imagesToPDF(_ urls: [URL]) throws -> Data {
        try validate(urls)
        guard !urls.contains(where: isPDF) else { throw Issue("请选择图片。") }
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 595, height: 842))
        var firstError: Error?
        let data = renderer.pdfData { context in
            for url in urls {
                autoreleasepool {
                    do {
                        try withAccess(url) {
                            let bitmap = try image(at: url)
                            let width: CGFloat = 595
                            let height = min(4000, max(1, width * CGFloat(bitmap.height) / CGFloat(bitmap.width)))
                            let page = CGRect(x: 0, y: 0, width: width, height: height)
                            let scale = min(width / CGFloat(bitmap.width), height / CGFloat(bitmap.height))
                            let drawnWidth = CGFloat(bitmap.width) * scale
                            let drawnHeight = CGFloat(bitmap.height) * scale
                            context.beginPage(withBounds: page, pageInfo: [:])
                            context.cgContext.setFillColor(UIColor.white.cgColor)
                            context.cgContext.fill(page)
                            UIImage(cgImage: bitmap).draw(in: CGRect(x: (width - drawnWidth) / 2, y: (height - drawnHeight) / 2, width: drawnWidth, height: drawnHeight))
                        }
                    } catch { firstError = error }
                }
                if firstError != nil { break }
            }
        }
        if let firstError { throw firstError }
        return data
    }

    private static func recognizeImage(_ image: CGImage) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        let supported = try request.supportedRecognitionLanguages()
        let wanted = ["zh-Hans", "en-US"].filter { supported.contains($0) }
        if !wanted.isEmpty { request.recognitionLanguages = wanted }
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    private static func image(at url: URL) throws -> CGImage {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 1800,
        ]
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let result = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw Issue("无法读取所选图片。")
        }
        return result
    }

    private static func withAccess<T>(_ url: URL, _ work: () throws -> T) rethrows -> T {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        return try work()
    }

    private struct Issue: LocalizedError {
        let errorDescription: String?
        init(_ description: String) { errorDescription = description }
    }
}
