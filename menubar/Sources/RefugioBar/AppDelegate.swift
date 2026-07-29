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

    // Menu-bar placement. Watched continuously in both directions: a slot can
    // appear or disappear long after launch, so this is never decided once.
    private var placementTimer: Timer?
    private var placementStarted = Date()
    private var lastDockProbe = Date.distantPast
    private var inDockMode = false
    private var announcedPlacement = false

    private var running = false
    private var startedAt: Date?          // for a transient "starting…" state

    // Paths / URLs
    private let home = FileManager.default.homeDirectoryForCurrentUser
    private var refugioDir: URL { home.appendingPathComponent("refugio") }
    private var startScript: URL { refugioDir.appendingPathComponent("start-refugio.cjs") }
    private var pidFile: URL { home.appendingPathComponent(".refugio-logs/supervisor.pid") }
    private let healthURL = URL(string: "http://127.0.0.1:8080/api/config")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        createStatusItem()
        refreshStatus()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
        startPlacementWatch()
    }

    /// Create (or re-create) the status item.
    private func createStatusItem() {
        // squareLength, not variableLength. A variable-length item sizes itself
        // to its content plus padding — ours measured 42 points, where a square
        // item is one menu-bar thickness, around 24. Asking for less room is
        // the only lever an ordinary app has on whether it fits; nothing in
        // AppKit lets one app displace another's item.
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        // ⌘-dragging a status item off the menu bar sets isVisible = false, and
        // macOS persists that against the item's autosave name — every later
        // launch then faithfully restores "hidden". Naming the item and forcing
        // it visible at launch is what undoes that.
        item.autosaveName = "com.phantazein.refugio.menubar.status"
        item.isVisible = true
        statusItem = item

        setIcon(running: running)
        item.menu = makeMenu(live: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// The Dock icon's menu, once we've fallen back to being a Dock app. Built
    /// fresh each time it opens, so it always reads true.
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? { makeMenu(live: false) }

    /// Clicking the Dock icon opens REFUGIO.
    ///
    /// Without this, a left-click on an app with no windows does nothing at
    /// all — the icon looks broken, and the menu is only reachable by knowing
    /// to right-click it. The obvious gesture should do the obvious thing.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { openApp() }
        return true
    }

    // ── Making sure the icon is actually there ──────────────

    /// Append a line to ~/.refugio-logs/menubar.log.
    ///
    /// This app had no log at all, and every interesting failure in it is
    /// invisible by nature — there is no window to put an error in. "I see no
    /// menu bar item" is unanswerable without this.
    private func log(_ line: String) {
        let url = home.appendingPathComponent(".refugio-logs/menubar.log")
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date())
        guard let data = "\(stamp) \(line)\n".data(using: .utf8) else { return }
        if let fh = try? FileHandle(forWritingTo: url) {
            fh.seekToEndOfFile(); fh.write(data); try? fh.close()
        } else {
            try? data.write(to: url)
        }
    }

    /// Is the item actually ON the menu bar?
    ///
    /// None of the obvious properties can answer this. An item macOS declines
    /// to lay out keeps AppKit's default frame — measured here as
    /// (0, -22, 42, 22), off the bottom of the screen — while reporting a
    /// button, a resolved image, isVisible = true and a non-zero width.
    /// Everything reads healthy and nothing is drawn. Only the position knows.
    private func isPlaced() -> Bool {
        guard let item = statusItem, item.isVisible,
              let f = item.button?.window?.frame, f.width > 0 else { return false }

        let onMenuBar = NSScreen.screens.contains { s in
            NSRect(x: s.frame.minX, y: s.frame.maxY - 44,
                   width: s.frame.width, height: 44).intersects(f)
        }
        // On a notched Mac the bar continues under the notch, where an item is
        // positioned and still invisible.
        var notched = false
        if let screen = NSScreen.main,
           let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            notched = NSRect(x: left.maxX, y: min(left.minY, right.minY),
                             width: max(0, right.minX - left.maxX),
                             height: max(left.height, right.height)).intersects(f)
        }
        return onMenuBar && !notched
    }

    /// Keep trying for a slot, and keep the one we get.
    ///
    /// The first version of this gave up after six seconds and turned into a
    /// Dock icon. That is not what other menu-bar apps do, and it isn't what
    /// this should do either: a slot can appear at any time — the user quits
    /// something, a display is connected, the login-time crowd settles — and an
    /// app that decided once at launch will sit in the Dock forever afterwards.
    ///
    /// So: keep watching in both directions. A minute of failure before the
    /// Dock fallback, rather than six seconds, and once there, keep testing so
    /// the icon comes back on its own the moment there is room for it.
    private func startPlacementWatch() {
        placementStarted = Date()
        placementTimer?.invalidate()
        placementTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.evaluatePlacement()
        }
        evaluatePlacement()
    }

    private func evaluatePlacement() {
        if inDockMode {
            // Periodically re-offer ourselves to the menu bar. Cheap, and it is
            // the difference between "you must relaunch it" and the icon simply
            // reappearing when you close something.
            guard Date().timeIntervalSince(lastDockProbe) > 20 else { return }
            lastDockProbe = Date()
            createStatusItem()
            if isPlaced() {
                log("a menu bar slot opened up — leaving Dock mode")
                leaveDockMode()
            } else if let item = statusItem {          // no room still; don't leave a ghost
                NSStatusBar.system.removeStatusItem(item)
                statusItem = nil
            }
            return
        }

        if isPlaced() {
            if !announcedPlacement {
                announcedPlacement = true
                log("placed on the menu bar at \(statusItem?.button?.window?.frame ?? .zero)")
            }
            return
        }

        let waited = Date().timeIntervalSince(placementStarted)
        if waited < 60 {
            if Int(waited) % 15 == 0 {
                log("not placed after \(Int(waited))s: " +
                    "frame=\(statusItem?.button?.window?.frame ?? .zero) " +
                    "screens=\(NSScreen.screens.count)")
            }
            return
        }
        enterDockMode()
    }

    /// No menu-bar slot after a minute: appear in the Dock, so the controls
    /// exist at all. Reversible — see evaluatePlacement().
    private func enterDockMode() {
        guard !inDockMode else { return }
        inDockMode = true
        lastDockProbe = Date()
        log("no room in the menu bar after 60s — falling back to a Dock icon")
        statusItem?.menu = nil
        if let item = statusItem { NSStatusBar.system.removeStatusItem(item) }
        statusItem = nil                       // so setIcon() stops trying
        NSApp.setActivationPolicy(.regular)

        // A Dock app with no icon gets the generic blank one, which reads as a
        // crashed app rather than the thing the alert just described.
        if let img = NSImage(systemSymbolName: "mountain.2.fill", accessibilityDescription: "REFUGIO") {
            NSApp.applicationIconImage =
                img.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 256, weight: .regular))
        }

        // With .regular and no main menu the menu bar is empty and even ⌘Q is
        // gone — the app would be exactly as unreachable as it was before.
        let main = NSMenu()
        let appEntry = NSMenuItem()
        let menu = makeMenu(live: true)
        menu.title = "REFUGIO"
        appEntry.submenu = menu
        main.addItem(appEntry)
        NSApp.mainMenu = main

        // Explain once. Every launch would be nagging about a thing the user
        // has already decided to live with — and this app starts at login.
        let shownKey = "dockFallbackNoticeShown"
        if UserDefaults.standard.bool(forKey: shownKey) { return }
        UserDefaults.standard.set(true, forKey: shownKey)

        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "REFUGIO couldn’t fit in the menu bar"
        a.informativeText =
            "Your menu bar is full. On a Mac with a notch there is less room than it looks, " +
            "and anything that doesn’t fit is simply not drawn.\n\n" +
            "REFUGIO is in the Dock instead — right-click its icon to start, stop or open it.\n\n" +
            "Quit a couple of other menu-bar apps and the icon will come back on its own; " +
            "REFUGIO keeps checking and moves back the moment there is room."
        a.addButton(withTitle: "OK")
        _ = a.runModal()
    }

    /// Room appeared: go back to the menu bar and drop the Dock icon.
    private func leaveDockMode() {
        inDockMode = false
        NSApp.mainMenu = nil
        NSApp.setActivationPolicy(.accessory)
        announcedPlacement = false
    }

    // ── Menu ────────────────────────────────────────────────

    private func headerTitle() -> String {
        if running {
            let mb = stackMemoryMB()
            return mb > 0 ? String(format: "REFUGIO — running · %.1f GB RAM", Double(mb) / 1024.0)
                          : "REFUGIO — running"
        }
        if startedAt.map({ Date().timeIntervalSince($0) < 90 }) ?? false { return "REFUGIO — starting…" }
        return "REFUGIO — stopped"
    }
    private func toggleTitle() -> String {
        running || (startedAt != nil) ? "Stop REFUGIO (frees memory)" : "Start REFUGIO"
    }

    /// Build the menu. `live` means "keep references to these items so status
    /// polling updates them" — true for whichever menu is permanently attached,
    /// false for the Dock menu, which is rebuilt every time it opens.
    private func makeMenu(live: Bool) -> NSMenu {
        let menu = NSMenu()

        let header = NSMenuItem(title: headerTitle(), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        let open = NSMenuItem(title: "Open REFUGIO", action: #selector(openApp), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        // Freeing RAM is the common reason people reach for this menu (the stack
        // can hold GBs) — and it should NOT cost them the menu bar, or there is
        // nothing left to restart from. So the memory-freeing action is this
        // toggle, which leaves the icon in place and flips to "Start REFUGIO".
        let toggle = NSMenuItem(title: toggleTitle(), action: #selector(toggleRun), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)

        menu.addItem(.separator())

        let login = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = LoginItem.isEnabled ? .on : .off
        menu.addItem(login)

        // One exit, and ⌘Q maps to it. It used to map to "Stop REFUGIO & Quit",
        // which meant the reflexive keystroke removed the only way back — quit
        // now asks instead, and the stop-and-quit path lives in that prompt.
        let quit = NSMenuItem(title: "Quit REFUGIO", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        if live {
            headerItem = header; openItem = open; toggleItem = toggle; loginItem = login
        }
        return menu
    }

    private func setIcon(running: Bool) {
        // No button means no slot in the menu bar. It used to return silently
        // here, which is how an app that had already failed went on looking
        // healthy; the placement watch is what notices instead.
        guard let btn = statusItem?.button else { return }
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
        loginItem?.state = LoginItem.isEnabled ? .on : .off
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
            headerItem?.title = "REFUGIO not installed (~/refugio)"
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
            headerItem?.title = "REFUGIO — starting…"
            toggleItem?.title = "Stop REFUGIO (frees memory)"
            setIcon(running: true)
        } catch {
            headerItem?.title = "Start failed: \(error.localizedDescription)"
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
        headerItem?.title = "REFUGIO — stopping…"
        toggleItem?.title = "Start REFUGIO"
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
            headerItem?.title = mb > 0
                ? String(format: "REFUGIO — running · %.1f GB RAM", Double(mb) / 1024.0)
                : "REFUGIO — running"
            toggleItem?.title = "Stop REFUGIO (frees memory)"
        } else if starting {
            headerItem?.title = "REFUGIO — starting…"
            toggleItem?.title = "Stop REFUGIO (frees memory)"
        } else {
            headerItem?.title = "REFUGIO — stopped"
            toggleItem?.title = "Start REFUGIO"
        }
        setIcon(running: up || starting)
    }
}
