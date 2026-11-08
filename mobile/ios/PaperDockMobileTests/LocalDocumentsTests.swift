// SPDX-License-Identifier: AGPL-3.0-only
import PDFKit
import UIKit
import XCTest
import WebKit
@testable import PaperDockMobile

final class LocalDocumentsTests: XCTestCase {
    @MainActor
    func testBundledWorkbenchLoadsInWebView() async throws {
        let controller = WorkbenchController()
        controller.loadViewIfNeeded()
        defer { controller.detach() }
        let view = try XCTUnwrap(controller.view as? WKWebView)
        var loaded = false
        for _ in 0..<20 {
            let ready = try? await view.evaluateJavaScript("!!document.querySelector('.pd-mobile') && document.body.innerText.includes('今天想处理什么文档')") as? Bool
            if ready == true { loaded = true; break }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        XCTAssertTrue(loaded, "The offline PaperDock workbench did not load in WKWebView.")
        let assets = try XCTUnwrap(Bundle.main.resourceURL?.appendingPathComponent("workbench/assets"))
        let wasm = try XCTUnwrap(FileManager.default.contentsOfDirectory(atPath: assets.path).first { $0.hasSuffix(".wasm") })
        let result = try await view.callAsyncJavaScript("const response = await fetch(path); return WebAssembly.validate(await response.arrayBuffer());", arguments: ["path": "./assets/\(wasm)"], in: nil, contentWorld: .page)
        XCTAssertEqual(result as? Bool, true, "The offline PDF engine must be readable inside WKWebView.")
    }

    func testSearchablePDFUsesTextLayer() throws {
        try withFixtureDirectory { directory in
            let pdf = directory.appendingPathComponent("searchable.pdf")
            let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 595, height: 842))
            try renderer.writePDF(to: pdf) { context in
                context.beginPage()
                ("PaperDock searchable 2026" as NSString).draw(at: CGPoint(x: 50, y: 60), withAttributes: [
                    .font: UIFont.systemFont(ofSize: 26),
                ])
            }
            XCTAssertEqual(try LocalDocuments.recognize([pdf]), "第 1 页\nPaperDock searchable 2026")
        }
    }

    func testImageAndScannedPDFRecognition() throws {
        try withFixtureDirectory { directory in
            let photo = directory.appendingPathComponent("printed.png")
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1000, height: 320))
            let image = renderer.image { context in
                UIColor.white.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 1000, height: 320))
                let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 64)]
                ("PaperDock OCR 2026" as NSString).draw(at: CGPoint(x: 55, y: 55), withAttributes: attributes)
                ("本地文字识别测试" as NSString).draw(at: CGPoint(x: 55, y: 150), withAttributes: attributes)
            }
            try XCTUnwrap(image.pngData()).write(to: photo)

            let data = try LocalDocuments.imagesToPDF([photo, photo])
            let pdf = try XCTUnwrap(PDFDocument(data: data))
            XCTAssertEqual(pdf.pageCount, 2)
            XCTAssertTrue(pdf.page(at: 0)?.string?.isEmpty ?? true)
            let scan = directory.appendingPathComponent("scan.pdf")
            try data.write(to: scan)

            let imageText = try LocalDocuments.recognize([photo])
            XCTAssertTrue(imageText.contains("2026"), "Image OCR returned: \(imageText)")
            XCTAssertTrue(imageText.contains("文字"), "Image OCR returned: \(imageText)")
            let scanText = try LocalDocuments.recognize([scan])
            XCTAssertEqual(scanText.components(separatedBy: "2026").count - 1, 2, "Scan OCR returned: \(scanText)")
        }
    }

    private func withFixtureDirectory(_ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory)
    }
}
