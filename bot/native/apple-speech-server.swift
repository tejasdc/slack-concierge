// Resident Apple speech transcriber for Concierge on a Mac (macOS 26 or later).
//
// It speaks the same protocol as the box's Parakeet engine, so Concierge's code path is one:
//   stdin:  <request id>\t<path to raw 16 kHz mono float32 PCM>\n
//   stdout: {"ready":true,"loadMs":N}                                   once, after preparing
//           {"id":"…","text":"…","audioMs":N,"chunks":N,"computeMs":N}  per request
//           {"id":"…","error":"…"}                                      per failed request
//
// It also follows a recording while it is being made, so stopping leaves only the last moments
// to transcribe (bot/src/live-speech.ts):
//   stdin:  <stream id>\tbegin\n
//           <stream id>\tappend\t<base64 raw 16 kHz mono float32 PCM>\n   any number, in order
//           <stream id>\tfinish\n    answered like a request, computeMs counted from finish
//           <stream id>\tcancel\n
//
// The model is Apple's on-device SpeechTranscriber, held by the operating system rather than
// by this process; "ready" means its assets for the locale are installed. Long recordings go
// through one analyzer, not in pieces: SpeechTranscriber is built for long-form audio.
// Transcribing a file needs no Speech permission and showed no prompt when run under the signed
// Thinkering launcher, measured September 21, 2026.
// Built by scripts/install-mac.sh; chosen by bot/src/speech-engine.ts on darwin.

import AVFoundation
import Foundation
import Speech

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("apple-speech-server: \(message)\n".utf8))
    exit(1)
}

let requestedLocale = Locale(identifier: CommandLine.arguments.dropFirst().first ?? "en-US")
let started = Date()
guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
    fail("locale \(requestedLocale.identifier) is not supported by SpeechTranscriber")
}

func makeTranscriber() -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
}

// The first run on a Mac downloads the locale's model through the system; later runs find it
// installed and this returns at once.
do {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [makeTranscriber()]) {
        try await request.downloadAndInstall()
    }
} catch {
    fail("speech assets for \(locale.identifier) could not be installed: \(error)")
}
guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [makeTranscriber()]) else {
    fail("no audio format is available for SpeechTranscriber")
}
let sourceFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
emit(["ready": true, "loadMs": Int(Date().timeIntervalSince(started) * 1000)])

func readSamples(_ path: String) throws -> AVAudioPCMBuffer {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let frames = AVAudioFrameCount(data.count / MemoryLayout<Float>.size)
    guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: frames) else {
        throw NSError(domain: "apple-speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "EMPTY_AUDIO"])
    }
    buffer.frameLength = frames
    data.withUnsafeBytes { raw in
        buffer.floatChannelData![0].update(from: raw.bindMemory(to: Float.self).baseAddress!, count: Int(frames))
    }
    return buffer
}

func convert(_ buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
    if buffer.format == analyzerFormat { return buffer }
    guard let converter = AVAudioConverter(from: sourceFormat, to: analyzerFormat) else {
        throw NSError(domain: "apple-speech", code: 2, userInfo: [NSLocalizedDescriptionKey: "UNSUPPORTED_FORMAT"])
    }
    let ratio = analyzerFormat.sampleRate / sourceFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
    guard let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else {
        throw NSError(domain: "apple-speech", code: 3, userInfo: [NSLocalizedDescriptionKey: "CONVERSION_FAILED"])
    }
    var consumed = false
    var conversionError: NSError?
    converter.convert(to: output, error: &conversionError) { _, status in
        if consumed { status.pointee = .endOfStream; return nil }
        consumed = true
        status.pointee = .haveData
        return buffer
    }
    if let conversionError { throw conversionError }
    return output
}

// Fed as one-second buffers, as a microphone would deliver them. One buffer holding a whole
// four-minute recording lost its first ~40% of words (11 of 25 sentences), measured
// September 21, 2026.
func slices(_ buffer: AVAudioPCMBuffer) -> [AVAudioPCMBuffer] {
    let step = AVAudioFrameCount(buffer.format.sampleRate)
    var pieces: [AVAudioPCMBuffer] = []
    var offset: AVAudioFrameCount = 0
    let bytesPerFrame = Int(buffer.format.streamDescription.pointee.mBytesPerFrame)
    while offset < buffer.frameLength {
        let count = min(step, buffer.frameLength - offset)
        guard let piece = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: count) else { break }
        piece.frameLength = count
        let source = buffer.audioBufferList.pointee.mBuffers
        let target = piece.mutableAudioBufferList.pointee.mBuffers
        memcpy(target.mData!, source.mData!.advanced(by: Int(offset) * bytesPerFrame), Int(count) * bytesPerFrame)
        pieces.append(piece)
        offset += count
    }
    return pieces
}

func samples(fromBase64 text: String) throws -> AVAudioPCMBuffer {
    guard let data = Data(base64Encoded: text), data.count >= MemoryLayout<Float>.size else {
        throw NSError(domain: "apple-speech", code: 4, userInfo: [NSLocalizedDescriptionKey: "BAD_PIECE"])
    }
    let frames = AVAudioFrameCount(data.count / MemoryLayout<Float>.size)
    let buffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: frames)!
    buffer.frameLength = frames
    data.withUnsafeBytes { raw in
        buffer.floatChannelData![0].update(from: raw.bindMemory(to: Float.self).baseAddress!, count: Int(frames))
    }
    return buffer
}

// A recording being followed while it is made. Final results arrive as he speaks and are kept,
// so finishing waits only for what was said since the last one.
final class LiveStream {
    let transcriber: SpeechTranscriber
    let analyzer: SpeechAnalyzer
    let continuation: AsyncStream<AnalyzerInput>.Continuation
    let collector: Task<String, Error>
    var frames: AVAudioFrameCount = 0
    var pieces = 0
    var failure: String?

    init(_ transcriber: SpeechTranscriber) async throws {
        self.transcriber = transcriber
        analyzer = SpeechAnalyzer(modules: [transcriber])
        collector = Task {
            var text = ""
            for try await result in transcriber.results where result.isFinal {
                text += String(result.text.characters)
            }
            return text
        }
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.continuation = continuation
        try await analyzer.start(inputSequence: stream)
    }
}
var live: [String: LiveStream] = [:]

func errorCode(_ error: Error) -> String {
    let code = (error as NSError).localizedDescription.uppercased().replacingOccurrences(of: " ", with: "_")
    return String(code.prefix(120))
}

@MainActor func handleLive(_ id: String, _ command: String, _ payload: String?) async {
    switch command {
    case "begin":
        do { live[id] = try await LiveStream(makeTranscriber()) } catch { emit(["id": id, "error": errorCode(error)]) }
    case "append":
        guard let stream = live[id], stream.failure == nil, let payload else { return }
        do {
            let piece = try convert(try samples(fromBase64: payload))
            stream.frames += piece.frameLength
            stream.pieces += 1
            for slice in slices(piece) { stream.continuation.yield(AnalyzerInput(buffer: slice)) }
        } catch { stream.failure = errorCode(error) }
    case "finish":
        guard let stream = live.removeValue(forKey: id) else { emit(["id": id, "error": "UNKNOWN_STREAM"]); return }
        let began = Date()
        stream.continuation.finish()
        do {
            if let failure = stream.failure { throw NSError(domain: "apple-speech", code: 5, userInfo: [NSLocalizedDescriptionKey: failure]) }
            try await stream.analyzer.finalizeAndFinishThroughEndOfInput()
            let text = try await stream.collector.value.trimmingCharacters(in: .whitespacesAndNewlines)
            emit(["id": id, "text": text, "audioMs": Int(Double(stream.frames) / analyzerFormat.sampleRate * 1000),
                  "chunks": stream.pieces, "computeMs": Int(Date().timeIntervalSince(began) * 1000)])
        } catch { emit(["id": id, "error": errorCode(error)]) }
    case "cancel":
        guard let stream = live.removeValue(forKey: id) else { return }
        stream.continuation.finish()
        await stream.analyzer.cancelAndFinishNow()
        stream.collector.cancel()
    default:
        emit(["id": id, "error": "UNKNOWN_COMMAND"])
    }
}

func transcribe(_ path: String) async throws -> (text: String, audioMs: Int) {
    let samples = try readSamples(path)
    let audioMs = Int(Double(samples.frameLength) / sourceFormat.sampleRate * 1000)
    let input = try convert(samples)
    // An analyzer finishes with its input, so each recording gets its own; the model it uses
    // stays loaded in the system between them.
    let transcriber = makeTranscriber()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collector = Task { () throws -> String in
        var text = ""
        for try await result in transcriber.results where result.isFinal {
            text += String(result.text.characters)
        }
        return text
    }
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    try await analyzer.start(inputSequence: stream)
    for piece in slices(input) { continuation.yield(AnalyzerInput(buffer: piece)) }
    continuation.finish()
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    let text = try await collector.value
    return (text.trimmingCharacters(in: .whitespacesAndNewlines), audioMs)
}

// stdin is read on its own thread so a blocked read never holds the concurrency runtime.
let lines = AsyncStream<String> { continuation in
    Thread.detachNewThread {
        while let line = readLine() { continuation.yield(line) }
        continuation.finish()
    }
}
for await line in lines {
    let parts = line.split(separator: "\t", maxSplits: 2).map(String.init)
    guard parts.count >= 2 else { continue }
    // A path is absolute; anything else is a command on a followed recording.
    if !parts[1].hasPrefix("/") {
        await handleLive(parts[0], parts[1], parts.count == 3 ? parts[2] : nil)
        continue
    }
    let began = Date()
    do {
        let result = try await transcribe(parts[1])
        emit(["id": parts[0], "text": result.text, "audioMs": result.audioMs, "chunks": 1,
              "computeMs": Int(Date().timeIntervalSince(began) * 1000)])
    } catch {
        emit(["id": parts[0], "error": errorCode(error)])
    }
}
