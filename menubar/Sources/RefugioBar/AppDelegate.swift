import AppKit

/// REFUGIO menu-bar controller: start / stop the local AI stack, open it, toggle
/// launch-at-login, quit. Very light — just an NSStatusItem that shells out to the
/// existing supervisor (~/refugio/start-refugio.cjs).
///
/// The icon and the stack are separate lifetimes: "Stop REFUGIO" frees the
/// memory and keeps the icon (so restarting is one click), "Quit REFUGIO"
/// removes the icon and asks what to do about the stack.
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

        // Freeing RAM is the common reason people reach for this menu (the stack
        // can hold GBs) — and it should NOT cost them the menu bar, or there is
        // nothing left to restart from. So the memory-freeing action is this
        // toggle, which leaves the icon in place and flips to "Start REFUGIO".
        toggleItem = NSMenuItem(title: "Start REFUGIO", action: #selector(toggleRun), keyEquivalent: "")
        toggleItem.target = self
        menu.addItem(toggleItem)

        menu.addItem(.separator())

        loginItem = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")
        loginItem.target = self
        loginItem.state = LoginItem.isEnabled ? .on : .off
        menu.addItem(loginItem)

        // One exit, and ⌘Q maps to it. It used to map to "Stop REFUGIO & Quit",
        // which meant the reflexive keystroke removed the only way back — quit
        // now asks instead, and the stop-and-quit path lives in that prompt.
        let quit = NSMenuItem(title: "Quit REFUGIO", action: #selector(quitApp), keyEquivalent: "q")
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
    private lazy var chatWindow = ChatWindow(url: appURL())

    @objc private func openApp() {
        if running {
            // Native window — no browser, no address bar. Holding Option opens
            // in the default browser instead, for anyone who prefers it.
            if NSEvent.modifierFlags.contains(.option) {
                NSWorkspace.shared.open(appURL())
            } else {
                chatWindow.show(url: appURL())
            }
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

    /// Quit the menu-bar app. Quitting the icon is not the same as stopping the
    /// stack, and either answer can be the one the user meant — so when REFUGIO
    /// is actually up, ask rather than guess. Cancel is the default button: this
    /// is reached by reflex (⌘Q), and both other outcomes are worse to get wrong.
    @objc private func quitApp() {
        if running {
            let a = NSAlert()
            a.messageText = "Quit the REFUGIO menu bar?"
            a.informativeText = "REFUGIO is running and using memory.\n\nTo free that memory but keep the menu bar — so you can start it again in one click — use “Stop REFUGIO” instead."
            a.addButton(withTitle: "Cancel")
            a.addButton(withTitle: "Stop REFUGIO & Quit")
            a.addButton(withTitle: "Quit, Leave It Running")
            switch a.runModal() {
            case .alertSecondButtonReturn: stopAndQuit(); return
            case .alertThirdButtonReturn: break
            default: return
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
        // The built-in chat UI is the default surface; fall back to Open WebUI
        // (custom domain if a cert was set up, else localhost) when it isn't up.
        if portOpen(8090) { return URL(string: "http://127.0.0.1:8090")! }
        let cert = refugioDir.appendingPathComponent("certs/refugio.pem")
        if FileManager.default.fileExists(atPath: cert.path) {
            return URL(string: "https://refugio")!
        }
        return URL(string: "http://refugio.localhost:8080")!
    }

    /// Cheap liveness probe used to choose between the chat UI and Open WebUI.
    private func portOpen(_ port: UInt16) -> Bool {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        if sock < 0 { return false }
        defer { close(sock) }
        var tv = timeval(tv_sec: 0, tv_usec: 300_000)
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
        return ok
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
            toggleItem.title = "Stop REFUGIO (frees memory)"
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
        // The built-in chat UI is the primary surface now, so "running" must be
        // true when only it is up — Open WebUI may not be installed at all.
        if portOpen(8090) {
            DispatchQueue.main.async { self.updateUI(up: true) }
            return
        }
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
            toggleItem.title = "Stop REFUGIO (frees memory)"
        } else if starting {
            headerItem.title = "REFUGIO — starting…"
            toggleItem.title = "Stop REFUGIO (frees memory)"
        } else {
            headerItem.title = "REFUGIO — stopped"
            toggleItem.title = "Start REFUGIO"
        }
        setIcon(running: up || starting)
    }
}
