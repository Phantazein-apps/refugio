import Foundation

/// Where REFUGIO is installed, and the Node that runs it.
///
/// This app used to assume both: `~/refugio`, and whichever of two Homebrew
/// paths had a `node` in it. The package installs to /usr/local/refugio with
/// its own Node, an installer can put the checkout anywhere, and a Node from
/// nvm or the nodejs.org installer is in neither Homebrew path — so on those
/// machines Start did nothing at all. The installer now records what it
/// installed and verified (see install-node.cjs), and that is asked first.
struct Install {
    let dir: URL
    let node: String

    /// Written by the installer with `defaults write`. Read every time rather
    /// than cached: a reinstall can move either, and the app outlives it.
    private static var defaults: UserDefaults { .standard }

    static func locate() -> Install? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        var dirs: [URL] = []
        if let recorded = defaults.string(forKey: "installDir") {
            dirs.append(URL(fileURLWithPath: recorded))
        }
        dirs.append(home.appendingPathComponent("refugio"))
        dirs.append(URL(fileURLWithPath: "/usr/local/refugio"))     // the .pkg
        guard let dir = dirs.first(where: {
            fm.fileExists(atPath: $0.appendingPathComponent("start-refugio.cjs").path)
        }) else { return nil }
        guard let node = node(for: dir) else { return nil }
        return Install(dir: dir, node: node)
    }

    /// First match wins, most specific first.
    ///
    ///   1. A runtime inside this app. Nothing ships one yet; a self-contained
    ///      REFUGIO.app will, and must not depend on anything below.
    ///   2. The runtime the .pkg puts beside the code, one per architecture.
    ///   3. The Node the installer ran with, recorded by it.
    ///   4. Homebrew's, as a last guess.
    private static func node(for dir: URL) -> String? {
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x64"
        #endif
        var candidates: [String] = []
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("runtime/bin/node").path {
            candidates.append(bundled)
        }
        candidates.append(dir.appendingPathComponent("runtime/darwin-\(arch)/bin/node").path)
        if let recorded = defaults.string(forKey: "nodePath") { candidates.append(recorded) }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
}

/// Runs REFUGIO's supervisor (start-refugio.cjs) and keeps it running.
///
/// This replaces the launchd agent. That agent ran the supervisor at login with
/// KeepAlive, and this app ran a second copy on demand — two owners for one
/// process, each unaware of the other, and on a Mac with 8 GB or less no owner
/// at all until someone found the menu bar. Now the app runs at login and is
/// the only owner: it starts the supervisor, restarts it if it dies, and stops
/// it when asked.
///
/// The supervisor itself still does the Node-side work — Ollama, the model that
/// fits free memory, the connector config, the chat server and ITS restarts.
/// This only has to keep that one process alive.
final class StackSupervisor {
    /// Called on the main queue whenever something here changes.
    var onChange: (() -> Void)?
    /// Why it gave up, when it has. Cleared by the next deliberate start.
    private(set) var failure: String?

    private var process: Process?
    private var stopRequested = false
    private var crashes: [Date] = []
    private var restartWork: DispatchWorkItem?
    private let log: (String) -> Void
    private let logFile: URL
    private let pidFile: URL

    /// Crashes this close together mean it will not start, not that it hit a
    /// bad moment. Restarting forever would hide that behind a flickering icon.
    private let crashLimit = 5
    private let crashWindow: TimeInterval = 300

    init(logDir: URL, log: @escaping (String) -> Void) {
        self.log = log
        self.logFile = logDir.appendingPathComponent("refugio.log")
        self.pidFile = logDir.appendingPathComponent("supervisor.pid")
    }

    /// Whether this app started the supervisor and it is still alive. A
    /// supervisor someone started from a terminal is not "ours": it is shown as
    /// running (the port says so) but not restarted if it dies.
    var isRunningOurs: Bool { process?.isRunning ?? false }

    /// A restart is scheduled — the icon should read as starting, not stopped.
    var isRestarting: Bool { restartWork != nil }

    /// Start the supervisor. Returns a reason when it cannot.
    @discardableResult
    func start() -> String? {
        stopRequested = false
        failure = nil
        crashes.removeAll()
        return launch()
    }

    private func launch() -> String? {
        restartWork = nil
        if isRunningOurs { return nil }
        guard let install = Install.locate() else {
            let why = "REFUGIO isn't installed where this app looks (~/refugio), or no Node was found to run it."
            log("start: \(why)")
            return why
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: install.node)
        // --no-browser always: this app has its own window, and shows it itself.
        task.arguments = [install.dir.appendingPathComponent("start-refugio.cjs").path, "--no-browser"]
        task.currentDirectoryURL = install.dir

        // An app opened at login gets launchd's PATH — /usr/bin:/bin:/usr/sbin:/sbin
        // — and connectors launched by name (`npx`, `node`) would not be found
        // in it. The Node running REFUGIO comes first, so they get the same one.
        var env = ProcessInfo.processInfo.environment
        let nodeDir = URL(fileURLWithPath: install.node).deletingLastPathComponent().path
        let inherited = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", inherited].joined(separator: ":")
        task.environment = env

        // Appended, not truncated: the log of the run that crashed is the one
        // worth reading, and the restart must not overwrite it.
        try? FileManager.default.createDirectory(at: logFile.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logFile.path) {
            FileManager.default.createFile(atPath: logFile.path, contents: nil)
        }
        if let fh = try? FileHandle(forWritingTo: logFile) {
            fh.seekToEndOfFile()
            task.standardOutput = fh
            task.standardError = fh
        } else {
            task.standardOutput = FileHandle.nullDevice
            task.standardError = FileHandle.nullDevice
        }

        task.terminationHandler = { [weak self] p in
            DispatchQueue.main.async { self?.exited(p) }
        }
        do {
            try task.run()
        } catch {
            log("start failed: \(error.localizedDescription)")
            return "Couldn't start REFUGIO: \(error.localizedDescription)"
        }
        process = task
        log("started supervisor pid \(task.processIdentifier) (node \(install.node), dir \(install.dir.path))")
        onChange?()
        return nil
    }

    /// Stop the supervisor and do not bring it back. It stops its own children
    /// (the chat server, an Ollama it started) on SIGTERM.
    func stop() {
        stopRequested = true
        restartWork?.cancel()
        restartWork = nil
        if let p = process, p.isRunning {
            p.terminate()
        } else if let pid = try? String(contentsOf: pidFile, encoding: .utf8)
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                  let n = Int32(pid), n > 1 {
            // Not ours — started from a terminal, or by an earlier run of this
            // app that has since quit and been reopened. Same signal, by pidfile.
            kill(n, SIGTERM)
        }
        onChange?()
    }

    private func exited(_ p: Process) {
        guard p === process else { return }
        process = nil
        let reason = p.terminationReason == .uncaughtSignal
            ? "signal \(p.terminationStatus)" : "exit \(p.terminationStatus)"

        if stopRequested {
            log("supervisor stopped (\(reason))")
            onChange?()
            return
        }
        // SIGTERM or SIGINT from someone else is a stop, not a crash: `refugio
        // stop`, or a second supervisor taking over (start-refugio.cjs stops an
        // older one before it starts). Restarting would fight them.
        if p.terminationReason == .uncaughtSignal,
           p.terminationStatus == SIGTERM || p.terminationStatus == SIGINT {
            log("supervisor stopped from outside (\(reason)) — not restarting")
            onChange?()
            return
        }
        if p.terminationReason == .exit && p.terminationStatus == 0 {
            log("supervisor exited cleanly — not restarting")
            onChange?()
            return
        }

        let now = Date()
        crashes = crashes.filter { now.timeIntervalSince($0) < crashWindow } + [now]
        if crashes.count >= crashLimit {
            failure = "REFUGIO stopped \(crashes.count) times in \(Int(crashWindow / 60)) minutes, so it was left stopped."
            log("supervisor exited (\(reason)) — \(crashes.count) times in \(Int(crashWindow))s, giving up")
            onChange?()
            return
        }
        // 1, 2, 4, 8 … seconds, capped at a minute.
        let delay = min(60.0, pow(2.0, Double(crashes.count - 1)))
        log("supervisor exited (\(reason)) — restarting in \(Int(delay))s")
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.stopRequested else { return }
            if let why = self.launch() {
                self.failure = why
                self.onChange?()
            }
        }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        onChange?()
    }
}
