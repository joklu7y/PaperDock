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
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            previousKeyWindow?.makeKey()
            controller.detach()
        }
        let view = try XCTUnwrap(controller.view as? WKWebView)
        view.configuration.userContentController.addUserScript(WKUserScript(source: """
        window.paperDockTestErrors = [];
        window.addEventListener('error', event => window.paperDockTestErrors.push(event.message || event.target?.src || 'Resource error'), true);
        window.addEventListener('unhandledrejection', event => window.paperDockTestErrors.push(String(event.reason)));
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        view.load(URLRequest(url: try XCTUnwrap(URL(string: "paperdock://workbench/index.html"))))
        var loaded = false
        for _ in 0..<60 {
            let ready = try? await view.evaluateJavaScript("document.querySelector('.pd-mobile .pd-home h2')?.textContent === '文档工具'") as? Bool
            if ready == true { loaded = true; break }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        if !loaded {
            let state = try? await view.evaluateJavaScript("JSON.stringify({url:location.href,state:document.readyState,errors:window.paperDockTestErrors,body:document.body?.innerText.slice(0,100)})")
            XCTFail("The offline PaperDock workbench did not load in WKWebView. State: \(state ?? "unavailable")")
            return
        }
        let assets = try XCTUnwrap(Bundle.main.resourceURL?.appendingPathComponent("workbench/assets"))
        let wasm = try XCTUnwrap(FileManager.default.contentsOfDirectory(atPath: assets.path).first { $0.hasSuffix(".wasm") })
        let result = try await view.callAsyncJavaScript("const response = await fetch(path); return WebAssembly.validate(await response.arrayBuffer());", arguments: ["path": "./assets/\(wasm)"], in: nil, contentWorld: .page)
        XCTAssertEqual(result as? Bool, true, "The offline PDF engine must be readable inside WKWebView.")

        let sampleText = "PaperDock iPhone 2026"
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 360, height: 480)).pdfData { context in
            context.beginPage()
            (sampleText as NSString).draw(at: CGPoint(x: 30, y: 45), withAttributes: [
                .font: UIFont.systemFont(ofSize: 20),
            ])
        }
        let review = try await view.callAsyncJavaScript("""
        const waitFor = async (find, label) => {
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const found = find();
                if (found) return found;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error(label + ': ' + (document.querySelector('.pd-notice-stack')?.innerText || 'no status'));
        };
        const buttons = Array.from(document.querySelectorAll('.pd-bottom-nav button'));
        if (buttons.length !== 3 || buttons[0].getAttribute('aria-current') !== 'page' || !buttons[0].getClientRects().length) {
            throw new Error('The phone navigation bar must be visible with Tools selected');
        }
        const icons = await document.fonts.load('24px "PaperDock Material Symbols"', 'apps');
        if (!icons.some(font => font.status === 'loaded')) throw new Error('The bundled Material Symbols did not load');

        const button = label => Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim().endsWith(label));
        const fits = () => document.documentElement.scrollWidth <= document.documentElement.clientWidth;
        buttons[1].click();
        const input = await waitFor(() => document.querySelector('input[accept*=".tiff"]'), 'OCR file picker');
        const files = new DataTransfer();
        const bytes = Uint8Array.from(atob(source), character => character.charCodeAt(0));
        files.items.add(new File([bytes], 'workbench-' + 'a'.repeat(96) + '.pdf', { type: 'application/pdf' }));
        input.files = files.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const start = await waitFor(() => button('开始识别')?.disabled === false && button('开始识别'), 'OCR start button');
        const initialScale = visualViewport.scale;
        if (!fits()) throw new Error('Long filenames must fit before recognition');
        start.click();
        const field = () => document.querySelector('textarea[aria-label="识别结果"]');
        await waitFor(() => field()?.value.includes(expected), 'Native PDF recognition');
        if (!fits() || visualViewport.scale !== initialScale) throw new Error('OCR must not widen or zoom the viewport');
        if (!document.querySelector('.pd-ocr-reminder')?.textContent.includes('识别可能有误，请仔细甄别')) {
            throw new Error('Missing review reminder');
        }

        button('查看原件').click();
        await waitFor(() => document.querySelector('.pd-ocr-original img')?.naturalWidth, 'Original PDF preview');
        button('校对文字').click();
        await waitFor(() => field()?.value.includes(expected), 'Review text restored');
        button('导出结果').click();
        const sheet = await waitFor(() => document.querySelector('.pd-sheet[open]'), 'Export sheet');
        const formats = Array.from(sheet.querySelectorAll('.pd-sheet-option'), option => option.lastElementChild.textContent.trim());
        return formats.join(',') === '.docx,.xlsx,.txt';
        """, arguments: ["source": pdf.base64EncodedString(), "expected": sampleText], in: nil, contentWorld: .page)
        XCTAssertEqual(review as? Bool, true, "The iPhone workbench must offer all three export formats.")
    }

    func testSearchablePDFUsesTextLayer() async throws {
        try await withFixtureDirectory { directory in
            let pdf = directory.appendingPathComponent("searchable.pdf")
            let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 595, height: 842))
            try renderer.writePDF(to: pdf) { context in
                context.beginPage()
                ("PaperDock searchable 2026" as NSString).draw(at: CGPoint(x: 50, y: 60), withAttributes: [
                    .font: UIFont.systemFont(ofSize: 26),
                ])
            }
            let text = try await LocalDocuments.recognize([pdf])
            XCTAssertEqual(text, "第 1 页\nPaperDock searchable 2026")
        }
    }

    func testImageAndScannedPDFRecognition() async throws {
        XCTAssertEqual(try ModelConfig.detection().name, "PP-OCRv6_small_det")
        XCTAssertEqual(try ModelConfig.recognition().name, "PP-OCRv6_small_rec")
        try await withFixtureDirectory { directory in
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

            let lines = try await LocalDocuments.imageLocations(photo)
            let imageText = lines.map(\.text).joined(separator: "\n")
            XCTAssertTrue(imageText.contains("2026"), "Image OCR returned: \(imageText)")
            XCTAssertTrue(imageText.contains("文字"), "Image OCR returned: \(imageText)")
            XCTAssertTrue(lines.allSatisfy { $0.box.count == 4 && $0.box.allSatisfy { (0...1).contains($0) } })
            let scanText = try await LocalDocuments.recognize([scan])
            XCTAssertEqual(scanText.components(separatedBy: "2026").count - 1, 2, "Scan OCR returned: \(scanText)")
        }
    }

    private func withFixtureDirectory(_ body: (URL) async throws -> Void) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        try await body(directory)
    }
}
