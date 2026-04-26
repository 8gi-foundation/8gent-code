import Foundation

/// WebSocket client for the daemon `/computer` channel.
///
/// Connects to `ws://127.0.0.1:18789/computer`. Loopback only. Uses
/// Foundation's `URLSessionWebSocketTask` (no third-party dependencies).
/// Reconnects with exponential backoff up to 30s when the socket drops.
final class DaemonClient: NSObject {
    /// Connection state surfaced to UI for the disconnected indicator.
    enum ConnectionState {
        case disconnected
        case connecting
        case connected
    }

    /// Default loopback endpoint for the computer channel.
    static let defaultURL = URL(string: "ws://127.0.0.1:18789/computer")!

    private let url: URL
    private let session: URLSession
    private let callbackQueue: DispatchQueue
    private var task: URLSessionWebSocketTask?
    private var pingTimer: DispatchSourceTimer?
    private var reconnectAttempt: Int = 0
    private var explicitlyClosed: Bool = false

    /// Called on `callbackQueue` with each decoded event.
    var onEvent: ((StreamEvent) -> Void)?
    /// Called on `callbackQueue` when the connection state changes.
    var onState: ((ConnectionState) -> Void)?
    /// Called on `callbackQueue` with a daemon-side error envelope.
    var onProtocolError: ((String) -> Void)?

    private(set) var state: ConnectionState = .disconnected {
        didSet {
            if state != oldValue {
                let s = state
                callbackQueue.async { [weak self] in self?.onState?(s) }
            }
        }
    }

    /// - Parameters:
    ///   - url: Daemon `/computer` endpoint.
    ///   - session: URLSession for the WebSocket task.
    ///   - callbackQueue: Queue on which `onEvent` / `onState` / `onProtocolError`
    ///     are delivered. Defaults to `.main` (UI-friendly). Pass a custom
    ///     queue when running headless without a main runloop.
    init(url: URL = DaemonClient.defaultURL,
         session: URLSession = .shared,
         callbackQueue: DispatchQueue = .main) {
        self.url = url
        self.session = session
        self.callbackQueue = callbackQueue
    }

    /// Open the socket. Idempotent if already connecting or connected.
    func connect() {
        guard state == .disconnected else { return }
        explicitlyClosed = false
        state = .connecting
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        receiveLoop()
        startPingTimer()
        // The daemon emits an `ack` `session:created` immediately on open.
        // We mark connected as soon as the receive loop sees the first frame
        // OR after a short grace period if no frames have arrived but the
        // task transitioned to .running.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            if self.state == .connecting && self.task?.state == .running {
                self.state = .connected
                self.reconnectAttempt = 0
            }
        }
    }

    /// Close the socket and stop reconnecting.
    func disconnect() {
        explicitlyClosed = true
        pingTimer?.cancel()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .disconnected
    }

    /// Send a user intent transcript.
    func sendIntent(_ text: String) {
        send(ClientMessage.intent(text))
    }

    /// Respond to an approval prompt from the daemon.
    func sendApproval(requestId: String, approved: Bool) {
        send(ClientMessage.approvalResponse(requestId: requestId, approved: approved))
    }

    /// Tell the daemon to destroy the session and close.
    func sendSessionDestroy() {
        send(ClientMessage.sessionDestroy())
    }

    private func send(_ message: String) {
        guard let task = task, state == .connected || state == .connecting else { return }
        task.send(.string(message)) { [weak self] err in
            if let err = err {
                NSLog("DaemonClient send error: \(err.localizedDescription)")
                self?.handleDrop()
            }
        }
    }

    private func receiveLoop() {
        guard let task = task else { return }
        task.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case let .success(.string(text)):
                self.handleFrame(text)
                self.receiveLoop()
            case let .success(.data(data)):
                if let text = String(data: data, encoding: .utf8) {
                    self.handleFrame(text)
                }
                self.receiveLoop()
            case .success:
                self.receiveLoop()
            case let .failure(err):
                NSLog("DaemonClient receive error: \(err.localizedDescription)")
                self.handleDrop()
            }
        }
    }

    private func handleFrame(_ raw: String) {
        if state != .connected {
            state = .connected
            reconnectAttempt = 0
        }
        guard let decoded = EnvelopeDecoder.decode(raw) else { return }
        switch decoded {
        case let .event(ev):
            callbackQueue.async { [weak self] in self?.onEvent?(ev) }
        case .ack:
            return
        case let .protocolError(message):
            callbackQueue.async { [weak self] in self?.onProtocolError?(message) }
        case let .unsupported(version):
            NSLog("DaemonClient unsupported protocol_version=\(version)")
        }
    }

    private func handleDrop() {
        guard !explicitlyClosed else { return }
        pingTimer?.cancel()
        pingTimer = nil
        task = nil
        state = .disconnected
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        let attempt = reconnectAttempt
        reconnectAttempt = min(attempt + 1, 8)
        // 0.5, 1, 2, 4, 8, 16, 30, 30 seconds.
        let delay = min(30.0, 0.5 * pow(2.0, Double(attempt)))
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, !self.explicitlyClosed else { return }
            self.connect()
        }
    }

    private func startPingTimer() {
        pingTimer?.cancel()
        // 30s app-level ping per the protocol spec keep-alive contract.
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in
            self?.send(ClientMessage.ping())
        }
        timer.resume()
        pingTimer = timer
    }
}
