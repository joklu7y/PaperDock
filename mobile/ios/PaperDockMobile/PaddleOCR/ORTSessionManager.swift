// Copyright (c) 2026 PaddlePaddle Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// PaperDock uses CPU sessions from the public ONNX Runtime Swift package.
import Foundation
import OnnxRuntimeBindings

enum ORTSessionManagerError: LocalizedError {
    case inferenceFailed(String)
    case inputTensorElementCountMismatch(expected: Int, actual: Int, modelName: String)
    case outputContainsNaN(String)

    var errorDescription: String? {
        switch self {
        case .inferenceFailed(let detail): return "Inference failed: \(detail)"
        case .inputTensorElementCountMismatch(let expected, let actual, let modelName):
            return "\(modelName): input tensor size mismatch (expected \(expected) floats, got \(actual))"
        case .outputContainsNaN(let name): return "Output tensor '\(name)' contains NaN values"
        }
    }
}

actor ORTSessionManager {
    private struct SessionIONames {
        let inputName: String
        let outputNames: Set<String>
    }

    private let env: ORTEnv
    private let detSession: ORTSession
    private let recSession: ORTSession
    private let detIO: SessionIONames
    private let recIO: SessionIONames

    init() throws {
        let environment = try ORTEnv(loggingLevel: .warning)
        let options = try ORTSessionOptions()
        try options.setGraphOptimizationLevel(.all)
        try options.setIntraOpNumThreads(2)
        let detection = try ORTSession(env: environment, modelPath: ModelConfig.detection().modelPath, sessionOptions: options)
        let recognition = try ORTSession(env: environment, modelPath: ModelConfig.recognition().modelPath, sessionOptions: options)
        env = environment
        detSession = detection
        recSession = recognition
        detIO = try Self.makeSessionIONames(session: detection, modelName: "det")
        recIO = try Self.makeSessionIONames(session: recognition, modelName: "rec")
    }

    private static func makeSessionIONames(session: ORTSession, modelName: String) throws -> SessionIONames {
        let inputNames = try session.inputNames()
        let outputNamesList = try session.outputNames()
        guard let firstInputName = inputNames.first else {
            throw ORTSessionManagerError.inferenceFailed("\(modelName): no input names found")
        }
        return SessionIONames(inputName: firstInputName, outputNames: Set(outputNamesList))
    }

    /// Run detection inference with real preprocessed input data.
    ///
    /// - Parameters:
    ///   - inputData: Float32 array in CHW layout; length must equal the product of `shape`.
    ///   - shape: Tensor shape, e.g. [1, 3, 896, 960].
    /// - Returns: Dictionary mapping output name to (data as [Float], shape as [Int]).
    func runDetection(inputData: [Float], shape: [Int]) async throws -> [String: (data: [Float], shape: [Int])] {
        try runInference(session: detSession, io: detIO, modelName: "det", inputData: inputData, shape: shape)
    }

    /// Run recognition inference with preprocessed input data.
    ///
    /// The recognition model accepts dynamic batch and width: shape `[N, 3, H, W]` with `N ≥ 1`,
    /// fixed `H` (e.g. 48), and `W` shared after padding within each batch. A single line uses `N = 1`.
    ///
    /// - Parameters:
    ///   - inputData: Float32 row-major tensor; length must equal the product of `shape`.
    ///   - shape: e.g. `[1, 3, 48, 320]` or `[6, 3, 48, 640]` for a batch of six lines.
    /// - Returns: Dictionary mapping output name to (data as [Float], shape as [Int]).
    func runRecognition(inputData: [Float], shape: [Int]) async throws -> [String: (data: [Float], shape: [Int])] {
        try runInference(session: recSession, io: recIO, modelName: "rec", inputData: inputData, shape: shape)
    }

    /// Shared inference logic used by both detection and recognition.
    ///
    /// Discovers input/output names at runtime, creates a float32 tensor from the
    /// provided data and shape, runs the session, extracts output arrays, and
    /// validates that no output contains NaN values.
    private func runInference(
        session: ORTSession,
        io: SessionIONames,
        modelName: String,
        inputData: [Float],
        shape: [Int]
    ) throws -> [String: (data: [Float], shape: [Int])] {
        let expectedElements = shape.reduce(1, *)
        guard expectedElements == inputData.count else {
            throw ORTSessionManagerError.inputTensorElementCountMismatch(
                expected: expectedElements,
                actual: inputData.count,
                modelName: modelName
            )
        }

        // Create ORT tensor from input data
        let nsShape = shape.map { NSNumber(value: $0) }
        let tensorData = inputData.withUnsafeBytes { bytes in
            NSMutableData(bytes: bytes.baseAddress, length: bytes.count)
        }
        let inputTensor = try ORTValue(
            tensorData: tensorData,
            elementType: .float,
            shape: nsShape
        )

        let inputs: [String: ORTValue] = [io.inputName: inputTensor]
        let outputs = try session.run(
            withInputs: inputs,
            outputNames: io.outputNames,
            runOptions: nil
        )

        // Extract output tensors as Float arrays
        var result: [String: (data: [Float], shape: [Int])] = [:]
        for (name, value) in outputs {
            let info = try value.tensorTypeAndShapeInfo()
            let outputShape = info.shape.map { $0.intValue }
            let outputData = try value.tensorData() as Data
            let floats: [Float] = outputData.withUnsafeBytes { buffer in
                Array(buffer.bindMemory(to: Float.self))
            }

            if floats.contains(where: \.isNaN) {
                throw ORTSessionManagerError.outputContainsNaN(name)
            }

            result[name] = (data: floats, shape: outputShape)
        }

        return result
    }
}
