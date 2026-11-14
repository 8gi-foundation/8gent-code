// Compiled with ../LilEight/DaemonService.swift by lil-eight-client.test.ts.
// Exercises the start plan Lil Eight follows when the daemon is not answering.
import Foundation

@main
struct DaemonServiceCheck {
    static var failures = 0

    static func check(_ ok: Bool, _ what: String) {
        if ok {
            print("ok   \(what)")
        } else {
            print("FAIL \(what)")
            failures += 1
        }
    }

    static func main() {
        let home = "/Users/ada"
        let plist = "/Users/ada/Library/LaunchAgents/com.8gent.daemon.plist"

        // Installed service: the only command is launchctl kickstart of com.8gent.daemon.
        let installed = DaemonService.startPlan(uid: 501, home: home, fileExists: { $0 == plist })
        check(
            installed == .kickstart(argv: ["/bin/launchctl", "kickstart", "gui/501/com.8gent.daemon"]),
            "installed service -> launchctl kickstart gui/501/com.8gent.daemon"
        )
        if case .kickstart(let argv) = installed {
            let joined = argv.joined(separator: " ")
            check(argv[0] == "/bin/launchctl", "executable is /bin/launchctl")
            check(!joined.contains("bun"), "no bun in the start command")
            check(!joined.contains("index.ts"), "no daemon entry file in the start command")
            check(!joined.contains("packages/daemon"), "no source checkout path in the start command")
            check(!argv.contains("bootstrap"), "never loads an unloaded service")
        }

        // No service: nothing is started, whatever else exists on disk (a checkout included).
        let checkoutOnDisk = DaemonService.startPlan(uid: 501, home: home, fileExists: { path in
            path != plist // every other path "exists", e.g. ~/8gent-code/packages/daemon/index.ts
        })
        check(checkoutOnDisk == .notInstalled(plistPath: plist), "no service -> notInstalled, even with a checkout on disk")

        // A not-installed plan runs nothing and reports "daemon not running".
        let status = DaemonService.requestStart(.notInstalled(plistPath: plist))
        check(status.hasPrefix("daemon not running"), "not installed -> \"daemon not running\" (got: \(status))")

        if failures > 0 {
            print("DaemonServiceCheck: \(failures) failure(s)")
            exit(1)
        }
        print("DaemonServiceCheck: PASS")
    }
}
