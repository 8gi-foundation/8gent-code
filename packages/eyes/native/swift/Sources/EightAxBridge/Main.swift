// 8gent AX bridge - main entry point.
//
// Transport: stdin/stdout JSON-line IPC. Each stdin line is one Request JSON.
// Each stdout line is exactly one Response JSON terminated by a newline.
//
// The TS adapter (packages/eyes/backends/ax-native.ts) spawns this binary
// once per call (one-shot mode is simpler than session multiplex; latency is
// dominated by AX/CG syscalls, not process startup). The envelope shape is
// the same `{ success, data, error }` Peekaboo emits, so the existing TS
// parser stays untouched modulo the binary it spawns.

import Foundation

// One-shot mode: read entire stdin, dispatch one command, write one envelope,
// exit. This makes argv-driven invocations work too.
@main
struct EightAxBridgeMain {
    static func main() {
        let args = CommandLine.arguments
        if args.count >= 2, args[1] == "--version" {
            emit(envelope: .success(["version": Bridge.version]))
            return
        }
        if args.count >= 2, args[1] == "--help" {
            emit(envelope: .success([
                "binary": "8gent-ax-bridge",
                "version": Bridge.version,
                "transport": "stdin-json-line",
                "commands": ["image", "see", "list-screens", "list-windows", "permissions"],
            ]))
            return
        }

        // Argv-driven: `8gent-ax-bridge <command> --json-args <json-blob>`
        if args.count >= 2 {
            let command = args[1]
            var jsonArgs: [String: Any] = [:]
            if let idx = args.firstIndex(of: "--json-args"), idx + 1 < args.count {
                if let data = args[idx + 1].data(using: .utf8),
                   let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    jsonArgs = parsed
                }
            }
            dispatch(command: command, args: jsonArgs)
            return
        }

        // Stdin mode: one JSON object on stdin, one envelope on stdout.
        let stdinData = FileHandle.standardInput.readDataToEndOfFile()
        guard !stdinData.isEmpty else {
            emit(envelope: .failure(code: "USAGE", message: "no command and no stdin payload"))
            return
        }
        guard let parsed = try? JSONSerialization.jsonObject(with: stdinData) as? [String: Any],
              let command = parsed["command"] as? String else {
            emit(envelope: .failure(code: "USAGE", message: "stdin must be JSON with a string 'command' field"))
            return
        }
        let jsonArgs = (parsed["args"] as? [String: Any]) ?? [:]
        dispatch(command: command, args: jsonArgs)
    }

    static func dispatch(command: String, args: [String: Any]) {
        switch command {
        case "image":
            ImageCommand.run(args: args)
        case "see":
            SeeCommand.run(args: args)
        case "list-screens":
            ScreenList.run()
        case "list-windows":
            WindowList.run(args: args)
        case "permissions":
            PermissionsCommand.run()
        default:
            emit(envelope: .failure(code: "USAGE", message: "unknown command: \(command)"))
        }
    }
}

enum Bridge {
    static let version = "0.1.0"
}

// MARK: - Envelope

enum Envelope {
    case success(Any)
    case failure(code: String, message: String)

    var dictionary: [String: Any] {
        switch self {
        case .success(let payload):
            return ["success": true, "data": payload, "error": NSNull()]
        case .failure(let code, let message):
            return [
                "success": false,
                "data": NSNull(),
                "error": ["code": code, "message": message],
            ]
        }
    }
}

func emit(envelope: Envelope) {
    let dict = envelope.dictionary
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]) else {
        FileHandle.standardOutput.write(Data("{\"success\":false,\"data\":null,\"error\":{\"code\":\"INTERNAL\",\"message\":\"failed to serialize envelope\"}}\n".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}
