import AVFoundation
import Foundation

/// Streamed TTS playback for daemon reply tokens.
///
/// Uses `AVSpeechSynthesizer` from AVFoundation (zero install, ships with
/// macOS, replaces the deprecated NSSpeechSynthesizer path on macOS 14+).
/// Token chunks are buffered until a sentence boundary (`.`, `?`, `!`,
/// newline) before being spoken so the voice does not stutter on partial
/// fragments. `stop()` interrupts mid-utterance for the next hotkey press,
/// and `flush()` forces any unspoken tail (after `done`) to be spoken.
final class SpeechReply: NSObject, AVSpeechSynthesizerDelegate {
    private let synth: AVSpeechSynthesizer
    private var buffer: String = ""
    private var queue: [String] = []
    private var isSpeaking: Bool = false

    /// Sentence-ending punctuation that triggers a flush.
    private static let boundaries: Set<Character> = [".", "?", "!", "\n"]

    /// Optional voice identifier override. When nil, the macOS default voice
    /// is used. Override via `voiceIdentifier =` or the `EIGHT_TTS_VOICE`
    /// env var (BCP-47 language code or AVSpeechSynthesisVoice identifier).
    var voiceIdentifier: String?

    override init() {
        self.synth = AVSpeechSynthesizer()
        super.init()
        self.synth.delegate = self
        if let envVoice = ProcessInfo.processInfo.environment["EIGHT_TTS_VOICE"], !envVoice.isEmpty {
            self.voiceIdentifier = envVoice
        }
    }

    /// Append a streamed chunk. Speaks complete sentences as they form.
    func append(_ chunk: String) {
        guard !chunk.isEmpty else { return }
        buffer.append(chunk)
        drainSentences()
    }

    /// Speak any remaining buffered text. Use when the daemon emits `done`.
    func flush() {
        let tail = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        buffer.removeAll(keepingCapacity: false)
        if !tail.isEmpty {
            enqueue(tail)
        }
    }

    /// Interrupt active speech and drop the queue. Used on next hotkey press.
    func stop() {
        synth.stopSpeaking(at: .immediate)
        queue.removeAll(keepingCapacity: false)
        buffer.removeAll(keepingCapacity: false)
        isSpeaking = false
    }

    private func drainSentences() {
        var lastBoundary = buffer.startIndex
        var i = buffer.startIndex
        while i < buffer.endIndex {
            if Self.boundaries.contains(buffer[i]) {
                let next = buffer.index(after: i)
                let sentence = String(buffer[lastBoundary..<next])
                let trimmed = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    enqueue(trimmed)
                }
                lastBoundary = next
            }
            i = buffer.index(after: i)
        }
        if lastBoundary == buffer.startIndex {
            return
        }
        if lastBoundary >= buffer.endIndex {
            buffer.removeAll(keepingCapacity: true)
        } else {
            buffer = String(buffer[lastBoundary..<buffer.endIndex])
        }
    }

    private func enqueue(_ text: String) {
        queue.append(text)
        speakNextIfIdle()
    }

    private func speakNextIfIdle() {
        guard !isSpeaking else { return }
        guard !queue.isEmpty else { return }
        let next = queue.removeFirst()
        isSpeaking = true
        let utterance = AVSpeechUtterance(string: next)
        if let id = voiceIdentifier {
            // Try identifier first, then fall back to language code.
            utterance.voice = AVSpeechSynthesisVoice(identifier: id)
                ?? AVSpeechSynthesisVoice(language: id)
        }
        synth.speak(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                           didFinish utterance: AVSpeechUtterance) {
        isSpeaking = false
        speakNextIfIdle()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                           didCancel utterance: AVSpeechUtterance) {
        isSpeaking = false
    }
}
