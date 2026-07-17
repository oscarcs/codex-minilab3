import AVFoundation
import CoreMedia
import Foundation
@preconcurrency import ScreenCaptureKit

private struct NormalizationConfiguration: Decodable {
    let mode: String
    let floorDb: Float?
    let ceilingDb: Float?
    let dynamicRangeDb: Float?
    let referenceDecayDbPerFrame: Float?
    let silenceThresholdDb: Float?
    let gamma: Float

    func validate() throws {
        guard gamma > 0 else {
            throw configurationError("Spectrum normalization gamma must be positive")
        }
        switch mode {
        case "fixed":
            guard let floorDb, let ceilingDb, floorDb < ceilingDb else {
                throw configurationError("Fixed normalization requires floorDb below ceilingDb")
            }
        case "adaptive":
            guard let dynamicRangeDb, dynamicRangeDb > 0,
                  let referenceDecayDbPerFrame, referenceDecayDbPerFrame > 0,
                  silenceThresholdDb != nil else {
                throw configurationError("Adaptive normalization settings are incomplete")
            }
        default:
            throw configurationError("Unknown spectrum normalization mode: \(mode)")
        }
    }
}

private struct SpectrumConfiguration: Decodable {
    let bandCenters: [Float]
    let bandGains: [Float]
    let filterQ: Float
    let fastDecay: Float
    let bodyDecay: Float
    let bodyAttack: Float
    let bodyMix: Float
    let transientFramesPerSecond: Int?
    let normalization: NormalizationConfiguration

    func validate() throws {
        guard bandCenters.count == 8, bandGains.count == 8 else {
            throw configurationError("A spectrum preset must define exactly eight bands and gains")
        }
        guard bandCenters.allSatisfy({ $0 > 0 }), bandGains.allSatisfy({ $0 > 0 }) else {
            throw configurationError("Spectrum band centers and gains must be positive")
        }
        guard filterQ > 0 else {
            throw configurationError("Spectrum filterQ must be positive")
        }
        if let transientFramesPerSecond,
           !(50...200).contains(transientFramesPerSecond) {
            throw configurationError("Transient analysis rate must be between 50 and 200 Hz")
        }
        for (name, value) in [
            ("fastDecay", fastDecay),
            ("bodyDecay", bodyDecay),
            ("bodyAttack", bodyAttack),
            ("bodyMix", bodyMix),
        ] where !(0...1).contains(value) {
            throw configurationError("Spectrum \(name) must be between zero and one")
        }
        try normalization.validate()
    }
}

private func configurationError(_ message: String) -> NSError {
    NSError(
        domain: "SystemAudioSpectrum",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: message]
    )
}

private struct BandPass {
    let b0: Float
    let b1: Float
    let b2: Float
    let a1: Float
    let a2: Float
    var x1: Float = 0
    var x2: Float = 0
    var y1: Float = 0
    var y2: Float = 0

    init(center: Float, sampleRate: Float, q: Float) {
        let omega = 2 * Float.pi * center / sampleRate
        let alpha = sin(omega) / (2 * q)
        let a0 = 1 + alpha
        b0 = alpha / a0
        b1 = 0
        b2 = -alpha / a0
        a1 = (-2 * cos(omega)) / a0
        a2 = (1 - alpha) / a0
    }

    mutating func process(_ input: Float) -> Float {
        let output = b0 * input + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1
        x1 = input
        y2 = y1
        y1 = output
        return output
    }
}

private final class SpectrumOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "dev.codex-minilab3.system-audio", qos: .userInteractive)
    private let configuration: SpectrumConfiguration
    private var sampleRate: Float = 48_000
    private var filters: [BandPass] = []
    private var energy = Array(repeating: Float(0), count: 8)
    private var fastEnvelope = Array(repeating: Float(0), count: 8)
    private var bodyEnvelope = Array(repeating: Float(0), count: 8)
    private var adaptiveReferenceDecibels: Float?
    private var accumulatedFrames = 0
    private var transientEnergy = Array(repeating: Float(0), count: 3)
    private var transientAccumulatedFrames = 0

    init(configuration: SpectrumConfiguration) {
        self.configuration = configuration
        super.init()
        configureFilters(sampleRate: sampleRate)
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }
        guard let description = sampleBuffer.formatDescription?.audioStreamBasicDescription else { return }
        let nextSampleRate = Float(description.mSampleRate)
        if abs(nextSampleRate - sampleRate) > 1 {
            configureFilters(sampleRate: nextSampleRate)
        }

        try? sampleBuffer.withAudioBufferList { buffers, _ in
            let frameCount = sampleBuffer.numSamples
            let channels = max(1, Int(description.mChannelsPerFrame))
            let nonInterleaved = description.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0

            for frame in 0..<frameCount {
                var mono: Float = 0
                var samplesRead = 0
                if nonInterleaved || buffers.count > 1 {
                    for buffer in buffers.prefix(channels) {
                        guard let data = buffer.mData else { continue }
                        let available = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
                        guard frame < available else { continue }
                        mono += data.assumingMemoryBound(to: Float.self)[frame]
                        samplesRead += 1
                    }
                } else if let buffer = buffers.first, let data = buffer.mData {
                    let samples = data.assumingMemoryBound(to: Float.self)
                    let available = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
                    for channel in 0..<channels {
                        let index = frame * channels + channel
                        guard index < available else { continue }
                        mono += samples[index]
                        samplesRead += 1
                    }
                }
                guard samplesRead > 0 else { continue }
                process(mono / Float(samplesRead))
            }
        }
    }

    private func configureFilters(sampleRate: Float) {
        self.sampleRate = sampleRate
        filters = configuration.bandCenters.map {
            BandPass(
                center: min($0, sampleRate * 0.45),
                sampleRate: sampleRate,
                q: configuration.filterQ
            )
        }
        energy = Array(repeating: 0, count: configuration.bandCenters.count)
        fastEnvelope = Array(repeating: 0, count: configuration.bandCenters.count)
        bodyEnvelope = Array(repeating: 0, count: configuration.bandCenters.count)
        adaptiveReferenceDecibels = nil
        accumulatedFrames = 0
        transientEnergy = Array(repeating: 0, count: 3)
        transientAccumulatedFrames = 0
    }

    private func process(_ sample: Float) {
        for index in filters.indices {
            let filtered = filters[index].process(sample)
            energy[index] += filtered * filtered
            guard configuration.transientFramesPerSecond != nil else { continue }
            let scaled = filtered * configuration.bandGains[index]
            let squared = scaled * scaled
            switch index {
            case 2:
                transientEnergy[0] += squared * 0.45
            case 3:
                transientEnergy[0] += squared
                transientEnergy[1] += squared * 0.45
            case 4:
                transientEnergy[0] += squared * 0.65
                transientEnergy[1] += squared
            case 5:
                transientEnergy[1] += squared * 0.7
                transientEnergy[2] += squared * 0.25
            case 6:
                transientEnergy[2] += squared * 0.8
            case 7:
                transientEnergy[2] += squared
            default:
                break
            }
        }
        accumulatedFrames += 1
        if let transientFramesPerSecond = configuration.transientFramesPerSecond {
            transientAccumulatedFrames += 1
            if transientAccumulatedFrames >= Int(sampleRate) / transientFramesPerSecond {
                emitTransientFrame()
            }
        }
        guard accumulatedFrames >= Int(sampleRate / 30) else { return }

        var decibels = Array(repeating: Float(0), count: filters.count)
        for index in filters.indices {
            let rms = sqrt(energy[index] / Float(accumulatedFrames)) * configuration.bandGains[index]
            decibels[index] = 20 * log10(max(rms, 0.000_001))
            energy[index] = 0
        }

        let normalizedLevels = normalize(decibels)
        var levels = Array(repeating: Float(0), count: filters.count)
        for index in filters.indices {
            let normalized = normalizedLevels[index]
            fastEnvelope[index] = normalized >= fastEnvelope[index]
                ? normalized
                : fastEnvelope[index] * configuration.fastDecay
            bodyEnvelope[index] = normalized >= bodyEnvelope[index]
                ? bodyEnvelope[index] + (normalized - bodyEnvelope[index]) * configuration.bodyAttack
                : bodyEnvelope[index] * configuration.bodyDecay
            if fastEnvelope[index] < 0.001 {
                fastEnvelope[index] = 0
            }
            if bodyEnvelope[index] < 0.001 {
                bodyEnvelope[index] = 0
            }
            levels[index] = max(fastEnvelope[index], bodyEnvelope[index] * configuration.bodyMix)
        }
        accumulatedFrames = 0
        emitLevels(levels)
    }

    private func normalize(_ decibels: [Float]) -> [Float] {
        let normalization = configuration.normalization
        if normalization.mode == "fixed" {
            let floor = normalization.floorDb!
            let ceiling = normalization.ceilingDb!
            return decibels.map { decibels in
                pow(max(0, min(1, (decibels - floor) / (ceiling - floor))), normalization.gamma)
            }
        }

        let currentMaximum = decibels.max() ?? -120
        let previousReference = adaptiveReferenceDecibels ?? currentMaximum
        let decay = normalization.referenceDecayDbPerFrame!
        let reference = currentMaximum >= previousReference
            ? currentMaximum
            : max(currentMaximum, previousReference - decay)
        adaptiveReferenceDecibels = reference
        if currentMaximum < normalization.silenceThresholdDb! {
            return Array(repeating: 0, count: decibels.count)
        }
        let range = normalization.dynamicRangeDb!
        let floor = reference - range
        return decibels.map { decibels in
            pow(max(0, min(1, (decibels - floor) / range)), normalization.gamma)
        }
    }

    private func emitTransientFrame() {
        let weightTotals: [Float] = [2.1, 2.15, 2.05]
        var decibels = Array(repeating: Float(0), count: 3)
        for index in decibels.indices {
            let meanEnergy = transientEnergy[index]
                / (Float(transientAccumulatedFrames) * weightTotals[index])
            decibels[index] = 10 * log10(max(meanEnergy, 0.000_000_000_001))
            transientEnergy[index] = 0
        }
        transientAccumulatedFrames = 0
        emitObject(["transient": decibels])
    }

    private func emitLevels(_ levels: [Float]) {
        if configuration.transientFramesPerSecond == nil {
            guard let data = try? JSONSerialization.data(withJSONObject: levels) else { return }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a]))
            return
        }
        emitObject(["levels": levels])
    }

    private func emitObject(_ value: [String: [Float]]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}

@main
private struct SystemAudioSpectrum {
    static func main() async {
        do {
            guard CommandLine.arguments.count == 2,
                  let configurationData = CommandLine.arguments[1].data(using: .utf8) else {
                throw configurationError("Expected one JSON spectrum-preset argument")
            }
            let analyzerConfiguration = try JSONDecoder().decode(
                SpectrumConfiguration.self,
                from: configurationData
            )
            try analyzerConfiguration.validate()
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else {
                throw NSError(
                    domain: "SystemAudioSpectrum",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "No display is available for system-audio capture"]
                )
            }

            let filter = SCContentFilter(
                display: display,
                excludingApplications: [],
                exceptingWindows: []
            )
            let streamConfiguration = SCStreamConfiguration()
            streamConfiguration.capturesAudio = true
            streamConfiguration.sampleRate = 48_000
            streamConfiguration.channelCount = 2
            streamConfiguration.excludesCurrentProcessAudio = true
            streamConfiguration.width = 2
            streamConfiguration.height = 2
            streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            streamConfiguration.queueDepth = 1

            let output = SpectrumOutput(configuration: analyzerConfiguration)
            let stream = SCStream(filter: filter, configuration: streamConfiguration, delegate: nil)
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
            try await stream.startCapture()
            FileHandle.standardError.write(Data("READY\n".utf8))

            while !Task.isCancelled {
                try await Task.sleep(for: .seconds(3_600))
            }
            try? await stream.stopCapture()
        } catch {
            FileHandle.standardError.write(Data("ERROR \(error.localizedDescription)\n".utf8))
            Foundation.exit(1)
        }
    }
}
