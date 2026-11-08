// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import ImageIO
import PDFKit
import UIKit

enum LocalDocuments {
    struct LocatedText: Sendable {
        let text: String
        let box: [Double]
    }

    private static let ocrEngine = Task.detached(priority: .userInitiated) {
        try OCREngine(sessionManager: ORTSessionManager())
    }

    static func imageLocations(_ url: URL) async throws -> [LocatedText] {
        let bitmap = try withAccess(url) { try image(at: url) }
        return try await recognizeLocations(bitmap)
    }
    static func isPDF(_ url: URL) -> Bool { url.pathExtension.lowercased() == "pdf" }

    static func validate(_ urls: [URL]) throws {
        guard (1...10).contains(urls.count) else { throw Issue("一次请选择 1 到 10 张图片或一份 PDF。") }
        guard !urls.contains(where: isPDF) || urls.count == 1 else { throw Issue("请单独导入一份 PDF。") }
    }

    static func pageCount(_ url: URL) -> Int { isPDF(url) ? PDFDocument(url: url)?.pageCount ?? 1 : 1 }

    static func recognize(_ urls: [URL]) async throws -> String {
        try validate(urls)
        if let url = urls.first, isPDF(url) {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            let fileSize = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard fileSize <= 50 * 1024 * 1024 else { throw Issue("预览版支持 50 MB 以内的 PDF。") }
            guard let pdf = PDFDocument(url: url), !pdf.isLocked else { throw Issue("无法打开 PDF，或文件需要密码。") }
            guard (1...20).contains(pdf.pageCount) else { throw Issue("预览版一次最多识别 20 页 PDF。") }
            var sections: [String] = []
            for index in 0..<pdf.pageCount {
                try Task.checkCancellation()
                guard let page = pdf.page(at: index) else { throw Issue("无法读取第 \(index + 1) 页。") }
                var text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if text.isEmpty {
                    let bitmap = try autoreleasepool {
                        let bounds = page.bounds(for: .mediaBox)
                        let factor = 1800 / max(bounds.width, bounds.height, 1)
                        let size = CGSize(width: max(1, bounds.width * factor), height: max(1, bounds.height * factor))
                        guard let image = page.thumbnail(of: size, for: .mediaBox).cgImage else { throw Issue("无法渲染第 \(index + 1) 页。") }
                        return image
                    }
                    text = try await recognizeLocations(bitmap).map(\.text).joined(separator: "\n")
                }
                if !text.isEmpty { sections.append("第 \(index + 1) 页\n\(text)") }
            }
            return sections.joined(separator: "\n\n")
        }
        var sections: [String] = []
        for url in urls {
            try Task.checkCancellation()
            let text = try await imageLocations(url).map(\.text).joined(separator: "\n")
            if !text.isEmpty { sections.append(text) }
        }
        return sections.joined(separator: "\n\n")
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

    private static func recognizeLocations(_ image: CGImage) async throws -> [LocatedText] {
        let engine = try await ocrEngine.value
        let run = try await engine.run(image)
        let width = Double(image.width), height = Double(image.height)
        return run.results.compactMap { line in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            let xs = line.polygon.compactMap { $0.first }
            let ys = line.polygon.compactMap { $0.dropFirst().first }
            guard let left = xs.min(), let right = xs.max(), let top = ys.min(), let bottom = ys.max() else { return nil }
            return LocatedText(text: text, box: [Double(left) / width, Double(top) / height, Double(right) / width, Double(bottom) / height])
        }
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
