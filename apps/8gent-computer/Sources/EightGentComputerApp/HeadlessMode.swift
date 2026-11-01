import Foundation

/// Headless CLI runner.
///
/// Connects to the daemon `/computer` channel, sends one intent, prints each
/// streamed event as a single JSON line on stdout, exits when the `done`
/// event arrives. No NSPanel is created. NemoClaw policy lives on the daemon
/// and is not bypassed here.
///
/// Usage:
///   8gent-computer --headless --intent "ping"
///   EIGHT_DAEMON_URL=ws://127.0.0.1:18789/computer 8gent-computer --headless --intent "..."
///   EIGHT_DAEMON_TIMEOUT_MS=15000 8gent-computer --headless --intent "..."
enum HeadlessMode {
    /// Exit codes:
    /// - 0 = done event received
    /// - 1 = invalid arguments
    /// - 2 = connection failure / timeout
    /// - 3 = approval required (not interactive in headless v0)
    static func run(intent: String) -> Int32 {
        let env = ProcessInfo.processInfo.environment
        let url = env["EIGHT_DAEMON_URL"].flatMap(URL.init(string:)) ?? DaemonClient.defaultURL
        let timeoutMs = Int(env["EIGHT_DAEMON_TIMEOUT_MS"] ?? "15000") ?? 15000

        let queue = DispatchQueue(label: "8gent-computer.headless")
        let client = DaemonClient(url: url, callbackQueue: queue)
        let lock = NSLock()
        var exitCode: Int32 = 2
        var doneFired = false
        let group = DispatchGroup()
        group.enter()

        client.onState = { state in
            switch state {
            case .connected:
                emit(["type": "state", "value": "connected"])
                client.sendIntent(intent)
            case .connecting:
                emit(["type": "state", "value": "connecting"])
            case .disconnected:
                emit(["type": "state", "value": "disconnected"])
            }
        }

        client.onProtocolError = { msg in
            emit(["type": "daemon_error", "message": msg])
        }

        client.onEvent = { ev in
            switch ev {
            case let .token(sid, chunk, final):
                emit(["type": "token", "sessionId": sid, "chunk": chunk, "final": final])
            case let .toolCall(sid, tool, callId, _):
                emit(["type": "tool_call", "sessionId": sid, "tool": tool, "callId": callId])
            case let .toolResult(sid, tool, callId, _, dur):
                emit(["type": "tool_result", "sessionId": sid, "tool": tool, "callId": callId, "durationMs": dur])
            case let .approvalRequired(sid, tool, requestId, reason):
                emit(["type": "approval_required", "sessionId": sid, "tool": tool, "requestId": requestId, "reason": reason ?? ""])
                FileHandle.standardError.write(Data("approval required for tool=\(tool) (NemoClaw); not interactive in headless v0\n".utf8))
                lock.lock(); exitCode = 3; lock.unlock()
                group.leave()
            case let .error(sid, error, recoverable):
                emit(["type": "error", "sessionId": sid, "error": error, "recoverable": recoverable])
            case let .done(sid, reason):
                emit(["type": "done", "sessionId": sid, "reason": reason])
                lock.lock()
                if !doneFired {
                    doneFired = true
                    exitCode = 0
                    lock.unlock()
                    group.leave()
                } else {
                    lock.unlock()
                }
            }
        }

        client.connect()

        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) {
            lock.lock()
            if !doneFired {
                doneFired = true
                FileHandle.standardError.write(Data("timed out after \(timeoutMs)ms waiting for done event\n".utf8))
                lock.unlock()
                group.leave()
            } else {
                lock.unlock()
            }
        }

        group.wait()
        client.disconnect()
        return exitCode
    }

    /// Emit one JSON line on stdout. Captions are not persisted; this is the
    /// audit trail for headless runs only.
    private static func emit(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let s = String(data: data, encoding: .utf8) else {
            return
        }
        FileHandle.standardOutput.write(Data((s + "\n").utf8))
    }
}
