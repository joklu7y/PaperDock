// SPDX-License-Identifier: AGPL-3.0-only
import SwiftUI
import UniformTypeIdentifiers

@main
struct PaperDockMobileApp: App {
    var body: some Scene {
        WindowGroup { WorkbenchView() }
    }
}

private struct WorkbenchView: View {
    @State private var files: [URL] = []
    @State private var recognizedText = ""
    @State private var message = "文件在设备上处理。"
    @State private var importing = false
    @State private var exporting = false
    @State private var busy = false
    @State private var document = ExportFile(data: Data())
    @State private var exportType = UTType.plainText
    @State private var exportName = "PaperDock-OCR.txt"

    var body: some View {
        NavigationStack {
            Form {
                Section("导入") {
                    Button("选择图片或 PDF") { importing = true }.disabled(busy)
                    if files.isEmpty {
                        Text("尚未选择文件").foregroundStyle(.secondary)
                    } else {
                        ForEach(files, id: \.self) { url in Text(url.lastPathComponent) }
                    }
                }
                Section("处理") {
                    Button("离线识别文字", action: recognize).disabled(files.isEmpty || busy)
                    Button("把所选图片转为 PDF", action: convert).disabled(files.isEmpty || busy || files.contains(where: LocalDocuments.isPDF))
                    if busy { ProgressView() }
                    Text(message).foregroundStyle(.secondary)
                }
                Section("识别结果") {
                    TextEditor(text: $recognizedText)
                        .frame(minHeight: 140)
                        .accessibilityLabel("识别结果，可校对")
                    Button("保存 TXT") {
                        export(Data(recognizedText.utf8), type: .plainText, name: "PaperDock-OCR.txt")
                    }.disabled(recognizedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                }
            }
            .navigationTitle("PaperDock")
            .fileImporter(isPresented: $importing, allowedContentTypes: [.image, .pdf], allowsMultipleSelection: true) { result in
                do {
                    let selection = try result.get()
                    try LocalDocuments.validate(selection)
                    files = selection
                    recognizedText = ""
                    message = "已导入 \(selection.count) 个文件。"
                } catch {
                    message = error.localizedDescription
                }
            }
            .fileExporter(isPresented: $exporting, document: document, contentType: exportType, defaultFilename: exportName) { result in
                switch result {
                case .success: message = "文件已保存。"
                case .failure(let error): message = "保存失败。\(error.localizedDescription)"
                }
                document = ExportFile(data: Data())
            }
        }
    }

    private func recognize() {
        let selection = files
        busy = true
        message = "正在离线识别…"
        Task { @MainActor in
            defer { busy = false }
            do {
                let text = try await Task.detached(priority: .userInitiated) {
                    try LocalDocuments.recognize(selection)
                }.value
                recognizedText = text
                message = text.isEmpty ? "没有识别到文字，请检查图片清晰度。" : "识别完成，可以校对并保存 TXT。"
            } catch { message = "识别失败。\(error.localizedDescription)" }
        }
    }

    private func convert() {
        let selection = files
        busy = true
        message = "正在生成 PDF…"
        Task { @MainActor in
            defer { busy = false }
            do {
                let data = try await Task.detached(priority: .userInitiated) {
                    try LocalDocuments.imagesToPDF(selection)
                }.value
                export(data, type: .pdf, name: "PaperDock-图片.pdf")
            } catch { message = "转换失败。\(error.localizedDescription)" }
        }
    }

    private func export(_ data: Data, type: UTType, name: String) {
        document = ExportFile(data: data)
        exportType = type
        exportName = name
        exporting = true
    }
}

private struct ExportFile: FileDocument {
    static let readableContentTypes: [UTType] = [.plainText, .pdf]
    let data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        guard let contents = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        data = contents
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
