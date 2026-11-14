import Foundation

// Lil Eight is a client of the 8gent daemon, never its owner (governance #1123).
//
// The daemon is owned by the login service that `8gent daemon install` sets up
// (launchd label com.8gent.daemon). When the daemon is not answering, the most
// Lil Eight may do is ask launchd to start that installed service. It never runs
// bun, never runs packages/daemon/index.ts, and never runs anything from a
// source checkout: a copy started that way lives outside launchd, keeps its own
// cron list in memory and rewrites cron.json over the real daemon's jobs.
//
// If the service is not installed, or was unloaded on purpose with
// `8gent daemon stop`, Lil Eight does not load it back. It reports that the
// daemon is not running and leaves the decision to the person.

enum DaemonStartPlan: Equatable {
    /// The service is installed: ask launchd to start it. `argv[0]` is the executable.
    case kickstart(argv: [String])
    /// No installed service: nothing is started.
    case notInstalled(plistPath: String)
}

enum DaemonService {
    static let label = "com.8gent.daemon"
    static let launchctl = "/bin/launchctl"

    static func plistPath(home: String) -> String {
        return home + "/Library/LaunchAgents/" + label + ".plist"
    }

    /// What Lil Eight does when the daemon is not answering. Pure, so it can be tested.
    static func startPlan(uid: uid_t, home: String, fileExists: (String) -> Bool) -> DaemonStartPlan {
        let plist = plistPath(home: home)
        guard fileExists(plist) else { return .notInstalled(plistPath: plist) }
        return .kickstart(argv: [launchctl, "kickstart", "gui/\(uid)/\(label)"])
    }

    static func currentPlan() -> DaemonStartPlan {
        return startPlan(
            uid: getuid(),
            home: NSHomeDirectory(),
            fileExists: { FileManager.default.fileExists(atPath: $0) }
        )
    }

    /// Runs the plan. Returns a one-line status for the log and the menu.
    @discardableResult
    static func requestStart(_ plan: DaemonStartPlan = currentPlan()) -> String {
        switch plan {
        case .notInstalled:
            return "daemon not running (no login service; run `8gent daemon install`)"
        case .kickstart(let argv):
            let process = Process()
            process.executableURL = URL(fileURLWithPath: argv[0])
            process.arguments = Array(argv.dropFirst())
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
            } catch {
                return "daemon not running (launchctl failed: \(error.localizedDescription))"
            }
            if process.terminationStatus == 0 {
                return "asked launchd to start \(label)"
            }
            // Not loaded: it was stopped with `8gent daemon stop`. Respect that.
            return "daemon not running (\(label) is not loaded; run `8gent daemon start`)"
        }
    }
}
