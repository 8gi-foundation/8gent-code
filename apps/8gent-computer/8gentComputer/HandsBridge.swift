// HandsBridge.swift - subprocess shell-out to packages/hands/run.ts.
//
// The Swift app runs `bun run /path/to/8gent-code/packages/hands/run.ts "<prompt>"`,
// captures stdout/stderr, and decodes stdout into RunResult.
//
// Resolution order for the repo root (where packages/hands lives):
//   1. EIGHT_REPO_ROOT environment variable
//   2. ~/8gent-code               (matches James's local layout)
//   3. CWD                         (last resort, useful for `swift run` from the repo)
//
// Resolution order for `bun`:
//   1. EIGHT_BUN env var
//   2. ~/.bun/bin/bun
//   3. /opt/homebrew/bin/bun
//   4. /usr/local/bin/bun

import Foundation

enum HandsBridge {

    struct BridgeError: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private static func resolveBun() -> String? {
        if let env = ProcessInfo.processInfo.environment["EIGHT_BUN"], !env.isEmpty {
            return env
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.bun/bin/bun",
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        return nil
    }

    private static func resolveRepoRoot() -> String? {
        let fm = FileManager.default
        if let env = ProcessInfo.processInfo.environment["EIGHT_REPO_ROOT"],
           fm.fileExists(atPath: "\(env)/packages/hands/run.ts") {
            return env
        }
        let home = fm.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/8gent-code",
            fm.currentDirectoryPath,
        ]
        for path in candidates where fm.fileExists(atPath: "\(path)/packages/hands/run.ts") {
            return path
        }
        return nil
    }

    /// Run a single prompt through packages/hands. Returns the decoded RunResult
    /// plus raw stderr (kept around so the UI can surface it for debugging).
    static func run(prompt: String) async throws -> (RunResult, String) {
        guard let bun = resolveBun() else {
            throw BridgeError(
                message: "Could not find a `bun` executable. Set EIGHT_BUN or install Bun."
            )
        }
        guard let root = resolveRepoRoot() else {
            throw BridgeError(
                message: "Could not find packages/hands. Set EIGHT_REPO_ROOT to your 8gent-code checkout."
            )
        }

        let runScript = "\(root)/packages/hands/run.ts"

        let process = Process()
        process.executableURL = URL(fileURLWithPath: bun)
        process.arguments = ["run", runScript, prompt]
        process.currentDirectoryURL = URL(fileURLWithPath: root)

        var env = ProcessInfo.processInfo.environment
        // Make sure cua-driver is on PATH. The wrapper hard-codes /usr/local/bin/cua-driver
        // already, but PATH is still useful for any child shells.
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:" + (env["PATH"] ?? "")
        process.environment = env

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        try process.run()

        // Run on a background thread so we don't block the main actor.
        return try await Task.detached(priority: .userInitiated) {
            let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()

            let stderrText = String(data: stderrData, encoding: .utf8) ?? ""

            guard let stdoutText = String(data: stdoutData, encoding: .utf8),
                  !stdoutText.isEmpty else {
                throw BridgeError(
                    message: "hands wrapper produced no stdout. stderr:\n\(stderrText)"
                )
            }

            // Some shells print extra noise; pull from the first '{' through the last '}'.
            let trimmed = stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)
            let jsonString: String
            if let first = trimmed.firstIndex(of: "{"),
               let last = trimmed.lastIndex(of: "}"),
               first <= last {
                jsonString = String(trimmed[first...last])
            } else {
                jsonString = trimmed
            }

            guard let data = jsonString.data(using: .utf8) else {
                throw BridgeError(message: "Could not encode wrapper stdout as UTF-8.")
            }

            do {
                let decoded = try JSONDecoder().decode(RunResult.self, from: data)
                return (decoded, stderrText)
            } catch {
                throw BridgeError(
                    message: "Failed to decode RunResult: \(error.localizedDescription)\n--- stdout ---\n\(stdoutText)\n--- stderr ---\n\(stderrText)"
                )
            }
        }.value
    }
}
