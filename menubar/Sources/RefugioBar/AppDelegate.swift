import AppKit

/// REFUGIO menu-bar controller: start / stop the local AI stack, open it, toggle
/// launch-at-login, quit. Very light — just an NSStatusItem that shells out to the
/// existing supervisor (~/refugio/start-refugio.cjs). Quitting this app does NOT stop
/// REFUGIO; use "Stop REFUGIO" for that.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var headerItem: NSMenuItem!
    private var toggleItem: NSMenuItem!
    private var openItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private var pollTimer: Timer?

    private var running = false
    private var startedAt: Date?          // for a transient "starting…" state

    // Paths / URLs
    private let home = FileManager.default.homeDirectoryForCurrentUser
    private var refugioDir: URL { home.appendingPathComponent("refugio") }
    private var startScript: URL { refugioDir.appendingPathComponent("start-refugio.cjs") }
    private var pidFile: URL { home.appendingPathComponent(".refugio-logs/supervisor.pid") }
    private let healthURL = URL(string: "http://127.0.0.1:8080/api/config")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        setIcon(running: false)
        buildMenu()
        refreshStatus()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // ── Menu ────────────────────────────────────────────────
    private func buildMenu() {
        let menu = NSMenu()

        headerItem = NSMenuItem(title: "REFUGIO — checking…", action: nil, keyEquivalent: "")
        headerItem.isEnabled = false
        menu.addItem(headerItem)
        menu.addItem(.separator())

        openItem = NSMenuItem(title: "Open REFUGIO", action: #selector(openApp), keyEquivalent: "o")
        openItem.target = self
        menu.addItem(openItem)

        toggleItem = NSMenuItem(title: "Start REFUGIO", action: #selector(toggleRun), keyEquivalent: "")
        toggleItem.target = self
        menu.addItem(toggleItem)

        menu.addItem(.separator())

        loginItem = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")
        loginItem.target = self
        loginItem.state = LoginItem.isEnabled ? .on : .off
        menu.addItem(loginItem)

        // Two distinct exits. Freeing RAM is the common reason people reach for
        // the menu bar (the stack can hold GBs), and a plain "Quit" that leaves
        // the supervisor running is the opposite of what they wanted — so the
        // memory-freeing action is spelled out and listed first.
        let stopQuit = NSMenuItem(title: "Stop REFUGIO & Quit",
                                  action: #selector(stopAndQuit), keyEquivalent: "q")
        stopQuit.target = self
        menu.addItem(stopQuit)

        let quit = NSMenuItem(title: "Quit menu bar only (keeps running)",
                              action: #selector(quitApp), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    private func setIcon(running: Bool) {
        guard let btn = statusItem.button else { return }
        let name = running ? "mountain.2.fill" : "mountain.2"
        if let img = NSImage(systemSymbolName: name, accessibilityDescription: "REFUGIO") {
            img.isTemplate = true
            btn.image = img
            btn.title = ""
        } else {
            btn.image = nil
            btn.title = "⛰"   // fallback for older SF Symbols sets
        }
    }

    // ── Actions ─────────────────────────────────────────────
    @objc private func openApp() {
        if running {
            NSWorkspace.shared.open(appURL())
        } else {
            // Start with the browser auto-opening when the stack is ready.
            startStack(openBrowser: true)
        }
    }

    @objc private func toggleRun() {
        running ? stopStack() : startStack(openBrowser: false)
    }

    @objc private func toggleLogin() {
        LoginItem.setEnabled(!LoginItem.isEnabled)
        loginItem.state = LoginItem.isEnabled ? .on : .off
    }

    /// Quit the menu-bar app only. REFUGIO keeps running and keeps its memory —
    /// warn first when it's actually up, so this can't be mistaken for the
    /// memory-freeing action.
    @objc private func quitApp() {
        if running {
            let a = NSAlert()
            a.messageText = "Leave REFUGIO running?"
            a.informativeText = "The menu bar will close but REFUGIO keeps running in the background and keeps using memory.\n\nTo free that memory, use “Stop REFUGIO & Quit”."
            a.addButton(withTitle: "Leave It Running")
            a.addButton(withTitle: "Stop REFUGIO & Quit")
            a.addButton(withTitle: "Cancel")
            switch a.runModal() {
            case .alertSecondButtonReturn: stopAndQuit(); return
            case .alertThirdButtonReturn: return
            default: break
            }
        }
        NSApp.terminate(nil)
    }

    /// Stop the whole stack, then quit — the "give me my RAM back" path.
    /// Gives the supervisor a moment to SIGTERM its children before exiting,
    /// so we don't orphan Ollama or Open WebUI.
    @objc private func stopAndQuit() {
        stopStack()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { NSApp.terminate(nil) }
    }

    // ── Start / stop the supervisor ─────────────────────────
    private func nodePath() -> String? {
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    private func appURL() -> URL {
        // Prefer the custom domain if the cert was set up; otherwise the localhost shortcut.
        let cert = refugioDir.appendingPathComponent("certs/refugio.pem")
        if FileManager.default.fileExists(atPath: cert.path) {
            return URL(string: "https://refugio")!
        }
        return URL(string: "http://refugio.localhost:8080")!
    }

    private func startStack(openBrowser: Bool) {
        guard FileManager.default.fileExists(atPath: startScript.path) else {
            headerItem.title = "REFUGIO not installed (~/refugio)"
            return
        }
        let task = Process()
        var args: [String] = []
        if let node = nodePath() {
            task.executableURL = URL(fileURLWithPath: node)
            args = [startScript.path]
        } else {
            // Fall back to `env node` if no well-known node path exists.
            task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            args = ["node", startScript.path]
        }
        if !openBrowser { args.append("--no-browser") }
        task.arguments = args
        task.currentDirectoryURL = refugioDir

        // Detach IO to the log so the child runs independently of this app.
        let logURL = home.appendingPathComponent(".refugio-logs/refugio.log")
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let fh = try? FileHandle(forWritingTo: logURL) {
            fh.seekToEndOfFile()
            task.standardOutput = fh
            task.standardError = fh
        } else {
            task.standardOutput = FileHandle.nullDevice
            task.standardError = FileHandle.nullDevice
        }

        do {
            try task.run()
            startedAt = Date()
            headerItem.title = "REFUGIO — starting…"
            toggleItem.title = "Stop REFUGIO"
            setIcon(running: true)
        } catch {
            headerItem.title = "Start failed: \(error.localizedDescription)"
        }
    }

    private func stopStack() {
        // SIGTERM the supervisor by its pidfile; it shuts down its own children
        // (Open WebUI, Ollama, MCP servers). Fall back to pkill.
        if let pidStr = try? String(contentsOf: pidFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
           let pid = Int32(pidStr), pid > 1 {
            kill(pid, SIGTERM)
        }
        let pk = Process()
        pk.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        pk.arguments = ["-f", "start-refugio"]
        try? pk.run()

        startedAt = nil
        running = false
        headerItem.title = "REFUGIO — stopping…"
        toggleItem.title = "Start REFUGIO"
        setIcon(running: false)
    }

    // ── Status polling ──────────────────────────────────────
    /// Resident memory (MB) of the REFUGIO stack: the supervisor and its
    /// children, plus Ollama and Open WebUI, which are separate process trees.
    /// One `ps` call, summed. Returns 0 if anything goes wrong — the header
    /// then just omits the figure rather than showing a wrong one.
    private func stackMemoryMB() -> Int {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c",
            "ps -Ao rss,comm,args | grep -E 'start-refugio|open-webui|ollama|mcpo' " +
            "| grep -v grep | awk '{s+=$1} END {print int(s/1024)}'"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return 0 }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return Int(String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    }

    private func refreshStatus() {
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            let up = (resp as? HTTPURLResponse) != nil
            DispatchQueue.main.async { self?.updateUI(up: up) }
        }.resume()
    }

    private func updateUI(up: Bool) {
        // Hold a transient "starting…" for up to 90s after a start click.
        let starting = !up && (startedAt.map { Date().timeIntervalSince($0) < 90 } ?? false)
        running = up
        if up {
            startedAt = nil
            // Surface RAM in the header — the stack (Ollama + model + Open
            // WebUI) can hold GBs, and "is this what's eating my machine?" is
            // the question that sends people to this menu.
            let mb = stackMemoryMB()
            headerItem.title = mb > 0
                ? String(format: "REFUGIO — running · %.1f GB RAM", Double(mb) / 1024.0)
                : "REFUGIO — running"
            toggleItem.title = "Stop REFUGIO"
        } else if starting {
            headerItem.title = "REFUGIO — starting…"
            toggleItem.title = "Stop REFUGIO"
        } else {
            headerItem.title = "REFUGIO — stopped"
            toggleItem.title = "Start REFUGIO"
        }
        setIcon(running: up || starting)
    }
}
