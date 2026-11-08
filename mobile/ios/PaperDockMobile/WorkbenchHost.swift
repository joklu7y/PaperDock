// SPDX-License-Identifier: AGPL-3.0-only
import AVFoundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

struct WorkbenchHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WorkbenchController { WorkbenchController() }
    func updateUIViewController(_ controller: WorkbenchController, context: Context) {}
    static func dismantleUIViewController(_ controller: WorkbenchController, coordinator: ()) { controller.detach() }
}

final class WorkbenchController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler, UIDocumentPickerDelegate, UIDocumentInteractionControllerDelegate {
    private struct Saved: Codable {
        let id: String
        let name: String
        let bookmark: Data
        let fallback: String
    }

    private enum Pick {
        case screenshot(String)
        case save(String, URL)
    }

    private var web: WKWebView!
    private var pick: Pick?
    private var preview: UIDocumentInteractionController?
    private var previewAccess: URL?
    private var videoExporter: AVAssetExportSession?
    private var preparingVideo = false
    private var videoCancelled = false

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(WorkbenchAssets(), forURLScheme: "paperdock")
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(self, name: "paperdock")
        configuration.userContentController.addUserScript(WKUserScript(source: """
        if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => {
          const bytes = crypto.getRandomValues(new Uint8Array(16));
          bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
          const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
          return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
        }});
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        view = web
        web.load(URLRequest(url: URL(string: "paperdock://workbench/index.html")!))
    }

    func detach() { web?.configuration.userContentController.removeScriptMessageHandler(forName: "paperdock") }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        decisionHandler(url?.scheme == "paperdock" && url?.host == "workbench" ? .allow : .cancel)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let raw = message.body as? String,
              let fields = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any],
              let id = fields["id"] as? String, UUID(uuidString: id) != nil,
              let action = fields["action"] as? String else { return }
        switch action {
        case "ocr":
            guard let name = fields["name"] as? String, let encoded = fields["data"] as? String else { return fail(id, "无法读取文件。") }
            let locations = fields["locations"] as? Bool ?? false
            Task { @MainActor in
                do {
                    let result = try await Task.detached(priority: .userInitiated) { () -> (String, Int, [LocalDocuments.LocatedText]?) in
                        let local = try Self.temporaryFile(name: name, encoded: encoded)
                        defer { try? FileManager.default.removeItem(at: local.deletingLastPathComponent()) }
                        if locations && !LocalDocuments.isPDF(local) {
                            let lines = try await LocalDocuments.imageLocations(local)
                            return (lines.map(\.text).joined(separator: "\n"), 1, lines)
                        }
                        let text = try await LocalDocuments.recognize([local])
                        let pages = LocalDocuments.pageCount(local)
                        return (text, pages, nil)
                    }.value
                    var value: [String: Any] = ["text": result.0, "pages": result.1]
                    if let lines = result.2 { value["locations"] = lines.map { ["text": $0.text, "box": $0.box] } }
                    reply(id, value: value)
                } catch { fail(id, error.localizedDescription) }
            }
        case "list":
            reply(id, value: saved().map { ["id": $0.id, "name": $0.name, "path": $0.name, "status": "已保存"] })
        case "open":
            guard let recordId = fields["record"] as? String, let record = saved().first(where: { $0.id == recordId }) else { return fail(id, "找不到保存记录。") }
            do { try open(record, share: fields["share"] as? Bool ?? false); reply(id, value: [:]) }
            catch { fail(id, error.localizedDescription) }
        case "save":
            guard pick == nil, let name = fields["name"] as? String, let encoded = fields["data"] as? String else { return fail(id, "请先完成当前保存。") }
            do {
                let file = try Self.temporaryFile(name: name, encoded: encoded)
                pick = .save(id, file)
                let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
                picker.delegate = self
                present(picker, animated: true)
            } catch { fail(id, error.localizedDescription) }
        case "screenshot":
            guard pick == nil else { return fail(id, "请先关闭当前文件选择器。") }
            pick = .screenshot(id)
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.image], asCopy: true)
            picker.delegate = self
            present(picker, animated: true)
        case "video":
            guard !preparingVideo, let name = fields["name"] as? String, let encoded = fields["data"] as? String else { return fail(id, "请先完成当前视频优化。") }
            preparingVideo = true
            videoCancelled = false
            Task { @MainActor in
                defer { preparingVideo = false; videoExporter = nil }
                do { reply(id, value: try await encodeWallpaper(name: name, encoded: encoded, low: fields["low"] as? Bool ?? false)) }
                catch { fail(id, error.localizedDescription) }
            }
        case "video-status":
            reply(id, value: ["state": "optimizing", "progress": Int((videoExporter?.progress ?? 0) * 100)])
        case "video-cancel":
            videoCancelled = true
            videoExporter?.cancelExport()
            reply(id, value: [:])
        default: fail(id, "不支持的手机操作。")
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let active = pick else { return }
        guard let url = urls.first else { documentPickerWasCancelled(controller); return }
        pick = nil
        switch active {
        case let .screenshot(id):
            do {
                let bytes = try Data(contentsOf: url)
                guard bytes.count <= 25 * 1024 * 1024 else { return fail(id, "截图文件过大。") }
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/png"
                reply(id, value: ["data": bytes.base64EncodedString(), "type": mime])
            } catch { fail(id, error.localizedDescription) }
        case let .save(id, file):
            defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            do {
                let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
                let record = Saved(id: UUID().uuidString, name: url.lastPathComponent, bookmark: bookmark, fallback: url.absoluteString)
                let records = [record] + Array(saved().prefix(199))
                UserDefaults.standard.set(try JSONEncoder().encode(records), forKey: "PaperDockDownloads")
                reply(id, value: ["path": record.name, "record_id": record.id])
            } catch { reply(id, value: ["path": url.lastPathComponent, "warning": "文件已保存，下载记录暂时无法写入。"]) }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        defer { pick = nil }
        switch pick {
        case let .screenshot(id): reply(id, value: NSNull())
        case let .save(id, file):
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            reply(id, value: ["cancelled": true])
        case nil: break
        }
    }

    private func saved() -> [Saved] {
        guard let bytes = UserDefaults.standard.data(forKey: "PaperDockDownloads") else { return [] }
        return (try? JSONDecoder().decode([Saved].self, from: bytes)) ?? []
    }

    private func encodeWallpaper(name: String, encoded: String, low: Bool) async throws -> [String: Any] {
        let input = try await Task.detached(priority: .userInitiated) { try Self.temporaryFile(name: name, encoded: encoded) }.value
        defer { try? FileManager.default.removeItem(at: input.deletingLastPathComponent()) }
        let asset = AVURLAsset(url: input)
        let duration = try await asset.load(.duration)
        let sourceTracks = try await asset.loadTracks(withMediaType: .video)
        guard duration.seconds.isFinite, duration.seconds > 0, duration.seconds <= 300, let track = sourceTracks.first else { throw VideoIssue("请选择 5 分钟以内的兼容视频。") }
        let sourceSize = try await track.load(.naturalSize)
        let orientation = try await track.load(.preferredTransform)
        let nominalFPS = try await track.load(.nominalFrameRate)
        let bounds = CGRect(origin: .zero, size: sourceSize).applying(orientation).standardized
        guard bounds.width > 0, bounds.height > 0 else { throw VideoIssue("视频尺寸无效。") }
        let scale = min(1, (low ? 1280 : 1920) / max(bounds.width, bounds.height), (low ? 720 : 1080) / min(bounds.width, bounds.height))
        let outputSize = CGSize(width: max(2, floor(bounds.width * scale / 2) * 2), height: max(2, floor(bounds.height * scale / 2) * 2))
        let fps = min(low ? 24 : 30, max(1, nominalFPS > 0 ? nominalFPS : 30))
        let composition = AVMutableComposition()
        guard let outputTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw VideoIssue("无法创建视频副本。") }
        let time = CMTimeRange(start: .zero, duration: duration)
        try outputTrack.insertTimeRange(time, of: track, at: .zero)
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: outputTrack)
        let transform = orientation.concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
        layer.setTransform(transform, at: .zero)
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = time
        instruction.layerInstructions = [layer]
        let video = AVMutableVideoComposition()
        video.renderSize = outputSize
        video.frameDuration = CMTime(value: 1000, timescale: CMTimeScale((fps * 1000).rounded()))
        video.instructions = [instruction]
        guard !videoCancelled else { throw VideoIssue("已取消视频优化。") }
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else { throw VideoIssue("系统无法优化这个视频。") }
        let destination = input.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".mp4")
        exporter.outputURL = destination
        exporter.outputFileType = .mp4
        exporter.videoComposition = video
        exporter.shouldOptimizeForNetworkUse = true
        videoExporter = exporter
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            exporter.exportAsynchronously { continuation.resume() }
        }
        guard exporter.status == .completed else { throw exporter.error ?? VideoIssue("视频优化未完成。") }
        let output = try Data(contentsOf: destination, options: .mappedIfSafe)
        guard output.count > 0 && output.count <= 45 * 1024 * 1024 else { throw VideoIssue("优化副本超过 45 MB，请选择更短的视频。") }
        let originalSize = try input.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        let original: [String: Any] = ["width": Int(bounds.width), "height": Int(bounds.height), "seconds": duration.seconds, "fps": nominalFPS, "bytes": originalSize]
        let converted: [String: Any] = ["width": Int(outputSize.width), "height": Int(outputSize.height), "seconds": duration.seconds, "fps": fps, "bytes": output.count]
        return ["data": output.base64EncodedString(), "metadata": ["original": original, "output": converted]]
    }

    private struct VideoIssue: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    private func open(_ record: Saved, share: Bool) throws {
        var stale = false
        let url = try URL(resolvingBookmarkData: record.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        let access = url.startAccessingSecurityScopedResource()
        if !share {
            let viewer = UIDocumentInteractionController(url: url)
            viewer.delegate = self
            preview = viewer
            previewAccess = access ? url : nil
            if viewer.presentPreview(animated: true) { return }
            preview = nil
            previewAccess = nil
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.completionWithItemsHandler = { _, _, _, _ in if access { url.stopAccessingSecurityScopedResource() } }
        present(sheet, animated: true)
    }

    func documentInteractionControllerViewControllerForPreview(_ controller: UIDocumentInteractionController) -> UIViewController { self }
    func documentInteractionControllerDidEndPreview(_ controller: UIDocumentInteractionController) {
        previewAccess?.stopAccessingSecurityScopedResource()
        previewAccess = nil
        preview = nil
    }

    private func fail(_ id: String, _ error: String) { send(["id": id, "error": error]) }
    private func reply(_ id: String, value: Any) { send(["id": id, "value": value]) }
    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.paperDockReply?.(\(json));")
    }

    nonisolated private static func temporaryFile(name: String, encoded: String) throws -> URL {
        guard encoded.utf8.count <= 96 * 1024 * 1024, let data = Data(base64Encoded: encoded) else { throw CocoaError(.fileReadCorruptFile) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let leaf = URL(fileURLWithPath: name).lastPathComponent
        let file = directory.appendingPathComponent(leaf.isEmpty || leaf == "." || leaf == ".." ? "PaperDock-file" : leaf)
        do { try data.write(to: file, options: .atomic); return file }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
}

private final class WorkbenchAssets: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let types = ["html": "text/html", "css": "text/css", "js": "text/javascript", "wasm": "application/wasm", "woff": "font/woff", "woff2": "font/woff2"]
        guard let request = task.request.url, request.host == "workbench",
              let root = Bundle.main.resourceURL?.appendingPathComponent("workbench", isDirectory: true),
              !request.pathComponents.contains("..") else { task.didFailWithError(URLError(.badURL)); return }
        let path = root.appendingPathComponent(request.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        guard let data = try? Data(contentsOf: path) else { task.didFailWithError(URLError(.fileDoesNotExist)); return }
        let response = HTTPURLResponse(url: request, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": types[path.pathExtension] ?? "application/octet-stream",
            "Access-Control-Allow-Origin": "*",
            "Content-Length": String(data.count),
        ])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
