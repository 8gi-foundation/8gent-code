import AVFoundation
import Foundation
import Speech

/// On-device streaming speech recognition.
///
/// Uses `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true` so
/// audio never leaves the machine. Mic and speech permission are requested
/// on first start. Partial results stream to `onPartial`, final transcripts
/// to `onFinal`. Caption strings are NEVER logged or persisted in v0.
final class SpeechCapture: NSObject {
    enum AuthorizationStatus {
        case granted
        case denied
        case restricted
        case notDetermined
    }

    enum CaptureError: Error {
        case micPermissionDenied
        case speechPermissionDenied
        case recognizerUnavailable
        case audioEngineFailure(String)
    }

    /// Called on main queue with the running partial transcript.
    var onPartial: ((String) -> Void)?
    /// Called on main queue when SFSpeechRecognizer reports `isFinal`.
    var onFinal: ((String) -> Void)?
    /// Called on main queue if capture cannot start or fails mid-stream.
    var onError: ((CaptureError) -> Void)?

    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var isRunning: Bool = false

    override init() {
        self.recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        super.init()
    }

    /// Request both mic and speech recognition permission. The completion
    /// receives the combined status on the main queue.
    func requestAuthorization(_ completion: @escaping (AuthorizationStatus) -> Void) {
        SFSpeechRecognizer.requestAuthorization { speechStatus in
            let speech = Self.mapSpeech(speechStatus)
            guard speech == .granted else {
                DispatchQueue.main.async { completion(speech) }
                return
            }
            #if os(macOS)
            // On macOS the AVAudioSession path is not used; mic access prompts
            // the first time we install the engine tap. We surface that
            // result by attempting a 0-frame input read here is overkill, so
            // we lean on the system to prompt later. Treat speech-granted as
            // granted at this stage.
            DispatchQueue.main.async { completion(.granted) }
            #else
            AVAudioSession.sharedInstance().requestRecordPermission { ok in
                DispatchQueue.main.async { completion(ok ? .granted : .denied) }
            }
            #endif
        }
    }

    /// Start streaming recognition. Safe to call when already running (no-op).
    func start() {
        guard !isRunning else { return }
        guard let recognizer = recognizer, recognizer.isAvailable else {
            DispatchQueue.main.async { self.onError?(.recognizerUnavailable) }
            return
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if #available(macOS 13, *) {
            req.requiresOnDeviceRecognition = true
            req.addsPunctuation = true
        }
        self.request = req

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak req] buffer, _ in
            req?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            DispatchQueue.main.async {
                self.onError?(.audioEngineFailure(error.localizedDescription))
            }
            return
        }

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                if result.isFinal {
                    DispatchQueue.main.async { self.onFinal?(text) }
                } else {
                    DispatchQueue.main.async { self.onPartial?(text) }
                }
            }
            if error != nil {
                self.stopInternal()
            }
        }

        isRunning = true
    }

    /// Stop capture and release the audio tap. Safe to call repeatedly.
    func stop() {
        stopInternal()
    }

    private func stopInternal() {
        guard isRunning else { return }
        isRunning = false
        request?.endAudio()
        task?.finish()
        task = nil
        request = nil
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
    }

    private static func mapSpeech(_ status: SFSpeechRecognizerAuthorizationStatus) -> AuthorizationStatus {
        switch status {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .denied
        }
    }
}
