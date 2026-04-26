import Foundation

/// Daemon protocol v1 wire types. Mirrors `packages/daemon/types.ts`.
///
/// Every server-to-client frame carries `protocol_version: 1`. Clients reject
/// any envelope they don't support. The `StreamEvent` taxonomy is the public
/// contract documented in `docs/specs/DAEMON-PROTOCOL.md`.

enum DaemonProtocol {
    static let version: Int = 1
}

/// One streaming event from the daemon during a turn.
enum StreamEvent: Equatable {
    case token(sessionId: String, chunk: String, final: Bool)
    case toolCall(sessionId: String, tool: String, callId: String, input: Any?)
    case toolResult(sessionId: String, tool: String, callId: String, output: Any?, durationMs: Int)
    case approvalRequired(sessionId: String, tool: String, requestId: String, reason: String?)
    case error(sessionId: String, error: String, recoverable: Bool)
    case done(sessionId: String, reason: String)

    static func == (lhs: StreamEvent, rhs: StreamEvent) -> Bool {
        switch (lhs, rhs) {
        case let (.token(a, b, c), .token(x, y, z)): return a == x && b == y && c == z
        case let (.toolCall(a, b, c, _), .toolCall(x, y, z, _)): return a == x && b == y && c == z
        case let (.toolResult(a, b, c, _, d), .toolResult(x, y, z, _, w)): return a == x && b == y && c == z && d == w
        case let (.approvalRequired(a, b, c, d), .approvalRequired(x, y, z, w)): return a == x && b == y && c == z && d == w
        case let (.error(a, b, c), .error(x, y, z)): return a == x && b == y && c == z
        case let (.done(a, b), .done(x, y)): return a == x && b == y
        default: return false
        }
    }
}

/// Decoder for inbound envelopes. Returns nil for frames the client should ignore.
enum EnvelopeDecoder {
    /// Decode a raw daemon frame. Validates `protocol_version`.
    static func decode(_ raw: String) -> Decoded? {
        guard let data = raw.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = any as? [String: Any] else {
            return nil
        }
        let pv = dict["protocol_version"] as? Int ?? 1
        guard pv == DaemonProtocol.version else { return .unsupported(version: pv) }
        let type = dict["type"] as? String ?? ""
        switch type {
        case "ack":
            return .ack(payload: dict["payload"])
        case "error":
            let msg = (dict["payload"] as? [String: Any])?["message"] as? String ?? "unknown error"
            return .protocolError(message: msg)
        case "event":
            guard let ev = dict["event"] as? [String: Any] else { return nil }
            return decodeEvent(ev).map { .event($0) }
        default:
            return nil
        }
    }

    enum Decoded {
        case event(StreamEvent)
        case ack(payload: Any?)
        case protocolError(message: String)
        case unsupported(version: Int)
    }

    private static func decodeEvent(_ ev: [String: Any]) -> StreamEvent? {
        let kind = ev["kind"] as? String ?? ""
        let sid = ev["sessionId"] as? String ?? ""
        switch kind {
        case "token":
            let chunk = ev["chunk"] as? String ?? ""
            let final = ev["final"] as? Bool ?? false
            return .token(sessionId: sid, chunk: chunk, final: final)
        case "tool_call":
            let tool = ev["tool"] as? String ?? ""
            let callId = ev["callId"] as? String ?? ""
            return .toolCall(sessionId: sid, tool: tool, callId: callId, input: ev["input"])
        case "tool_result":
            let tool = ev["tool"] as? String ?? ""
            let callId = ev["callId"] as? String ?? ""
            let dur = ev["durationMs"] as? Int ?? 0
            return .toolResult(sessionId: sid, tool: tool, callId: callId, output: ev["output"], durationMs: dur)
        case "approval_required":
            let tool = ev["tool"] as? String ?? ""
            let requestId = ev["requestId"] as? String ?? ""
            let reason = ev["reason"] as? String
            return .approvalRequired(sessionId: sid, tool: tool, requestId: requestId, reason: reason)
        case "error":
            let err = ev["error"] as? String ?? "unknown error"
            let recoverable = ev["recoverable"] as? Bool ?? false
            return .error(sessionId: sid, error: err, recoverable: recoverable)
        case "done":
            let reason = ev["reason"] as? String ?? "turn-complete"
            return .done(sessionId: sid, reason: reason)
        default:
            return nil
        }
    }
}

/// Inbound message builders (client to daemon). Always include protocol_version.
enum ClientMessage {
    static func intent(_ text: String) -> String {
        encode(["type": "intent", "text": text])
    }

    static func ping() -> String {
        encode(["type": "ping"])
    }

    static func approvalResponse(requestId: String, approved: Bool) -> String {
        encode(["type": "approval:response", "requestId": requestId, "approved": approved])
    }

    static func sessionDestroy() -> String {
        encode(["type": "session:destroy"])
    }

    private static func encode(_ payload: [String: Any]) -> String {
        var dict = payload
        dict["protocol_version"] = DaemonProtocol.version
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
              let str = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return str
    }
}
