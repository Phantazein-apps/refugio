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
    /// Built once, attached only for the duration of a right-click. See popMenu().
    private var menu: NSMenu?
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
        // Here, not before app.run(). Both working reference apps set this
        // inside didFinishLaunching and create their status item immediately
        // after; the old main.swift set it before the app had launched at all.
        NSApp.setActivationPolicy(.accessory)

        createStatusItem()
        refreshStatus()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    /// Create the status item — deliberately the plainest thing that works.
    ///
    /// This used to set an autosaveName, force isVisible, and ask for
    /// squareLength. All of that was added to work around a failure that turned
    /// out to be self-inflicted (see below), and none of it appears in the two
    /// menu-bar apps that work on the same machine. Plain variableLength, an
    /// image, a menu.
    private func createStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        setIcon(running: running)

        // Left click opens REFUGIO; right click (or control-click) opens the
        // menu. The menu is built now but NOT attached — assigning
        // `statusItem.menu` makes AppKit swallow every click to show it, which
        // is why the icon had no primary action at all.
        //
        // On the convention: Apple's own extras (Wi-Fi, Volume) show a menu on
        // click, because they have nothing to open. Extras that front an app —
        // Dropbox, 1Password, Bartender — open the app on left click and keep
        // the menu on right click, because "show me the thing" is what people
        // want nine times in ten. REFUGIO has a window, so it follows the
        // second convention. The cost is discoverability: nothing advertises
        // the right-click, which is what the tooltip is for.
        menu = makeMenu()
        if let btn = statusItem.button {
            btn.target = self
            btn.action = #selector(statusItemClicked)
            _ = btn.sendAction(on: [.leftMouseUp, .rightMouseUp])
            btn.toolTip = "REFUGIO — click to open · right-click for the menu"
        }

        // One observational line. Not a decision — see the comment on the
        // removed placement watch.
        let f = statusItem.button?.window?.frame ?? .zero
        log("status item created: frame=\(f) screen=\(statusItem.button?.window?.screen != nil)")
    }

    @objc private func statusItemClicked() {
        let event = NSApp.currentEvent
        let wantsMenu = event?.type == .rightMouseUp
            || (event?.modifierFlags.contains(.control) ?? false)
        if wantsMenu { popMenu() } else { openApp() }
    }

    /// Show the menu for one click, then detach it again.
    ///
    /// Attaching permanently would take the left click back. Attach, click it
    /// ourselves so it drops from the right place with the right highlight,
    /// then clear it.
    private func popMenu() {
        guard let m = menu else { return }
        statusItem.menu = m
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

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

    // ── Why there is no placement check here any more ───────
    //
    // There was one, and it was the bug. It judged the item unplaced when
    // `button.window.screen` was nil — and on macOS 26 that is TRUE OF A
    // HEALTHY ITEM, because Control Center hosts status items in its own
    // process. So the check failed forever: after 60 seconds it tore the status
    // item down and switched to a Dock icon, then every 20 seconds created a
    // trial item, tested it, and destroyed it again.
    //
    // The icon really was being created correctly every time. It was removed
    // moments later by the code watching it. The "macOS is blocking REFUGIO's
    // menu bar icon" alert was this code accusing the system of its own fault.
    //
    // A minimal probe app with none of this — same bundle shape, same signing,
    // same scene — showed its item immediately. That is the entire difference.
    //
    // If the icon genuinely fails to appear again, the answer is a log line and
    // a human looking at the menu bar, not an automatic remedy built on a
    // property that cannot distinguish healthy from broken.

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

    /// "Open" creates something; "Show" brings back something that exists. The
    /// window is only hidden when closed, never destroyed, so offering to open
    /// an already-open window misdescribes what the click does — and reads as
    /// though it might discard the conversation on screen.
    private func openTitle() -> String {
        windowIsUp ? "Show REFUGIO" : "Open REFUGIO"
    }

    /// Whether the chat window exists AND is on screen. Reads the optional
    /// directly rather than going through `chatWindow`, which would build one
    /// — running appURL() and its socket probe on every three-second poll, for
    /// a window nobody has asked for yet.
    private var windowIsUp: Bool {
        chatWindowInstance?.isVisible ?? false
    }

    /// Build the menu, keeping references so status polling can update it.
    private func makeMenu() -> NSMenu {
        let menu = NSMenu()

        let header = NSMenuItem(title: headerTitle(), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        let open = NSMenuItem(title: openTitle(), action: #selector(openApp), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        // Freeing RAM is the common reason people reach for this menu (the stack
        // can hold GBs) — and it should NOT cost them the menu bar, or there is
        // nothing left to restart from. So the memory-freeing action is this
        // toggle, which leaves the icon in place and flips to "Start REFUGIO".
        let toggle = NSMenuItem(title: toggleTitle(), action: #selector(toggleRun), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)

        // Settings is a page inside the chat window rather than a separate
        // surface, but it needs its own way in. Connectors moved out of the
        // installer's terminal prompts and onto that page, so "WhatsApp stopped
        // working" has to be answerable from the menu bar — the only part of
        // REFUGIO that is always on screen.
        let settings = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

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

        headerItem = header; openItem = open; toggleItem = toggle; loginItem = login
        return menu
    }

    private func setIcon(running: Bool) {
        // No button means no slot in the menu bar. It used to return silently
        // here, which is how an app that had already failed went on looking
        // healthy; the placement watch is what notices instead.
        guard let btn = statusItem?.button else { return }

        // A word instead of the symbol, on request:
        //   defaults write com.phantazein.refugio.app showTextLabel -bool true
        //
        // "No icon" has two shapes that look identical from outside — the item
        // was never placed, or it was placed and the symbol renders blank. A
        // template image that fails to draw leaves a button of the right size
        // showing nothing, which is indistinguishable from an absent item. Text
        // cannot fail that way, so if the word appears the placement is fine
        // and the icon is the bug.
        if UserDefaults.standard.bool(forKey: "showTextLabel") {
            statusItem?.length = NSStatusItem.variableLength   // text needs the room
            btn.image = nil
            btn.title = running ? "REFUGIO●" : "REFUGIO"
            return
        }

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
    /// Built on first use and kept. Not `lazy`, because the poll below has to
    /// ask "is there a window, and is it up?" without building one as a side
    /// effect — and a lazy var cannot be asked that question.
    private var chatWindowInstance: ChatWindow?
    private var chatWindow: ChatWindow {
        if let existing = chatWindowInstance { return existing }
        let created = ChatWindow(url: appURL())
        chatWindowInstance = created
        return created
    }

    @objc private func openApp() {
        if running {
            // Native window — no browser, no address bar. Holding Option opens
            // in the default browser instead, for anyone who prefers it.
            if NSEvent.modifierFlags.contains(.option) {
                NSWorkspace.shared.open(appURL())
            } else {
                // navigate: true so this comes back from the settings page. It
                // only reloads when the URL actually differs, so an already-open
                // chat is left exactly as it was.
                chatWindow.show(url: appURL(), navigate: true)
            }
        } else {
            // Start with the browser auto-opening when the stack is ready.
            startStack(openBrowser: true)
        }
    }

    /// Open the chat window on the settings page.
    ///
    /// Only the built-in chat UI has one — Open WebUI, the legacy surface, does
    /// not. Rather than open a URL that 404s there, say so and offer the one
    /// action that makes it available.
    @objc private func openSettings() {
        guard running, portOpen(8090) else {
            // Spelled out rather than folded into a ternary with string
            // concatenation in one branch. That form type-checks slowly and is
            // exactly the kind of expression that fails to build on a machine
            // this code cannot be compiled on before shipping.
            let title: String
            let detail: String
            if running {
                title = "Settings needs REFUGIO's own chat window."
                detail = "This copy is serving the legacy Open WebUI interface, which has no settings page. Re-run the installer to switch to REFUGIO's own window."
            } else {
                title = "REFUGIO isn't running."
                detail = "Start REFUGIO from this menu, then open Settings."
            }
            let a = NSAlert()
            a.messageText = title
            a.informativeText = detail
            a.addButton(withTitle: "OK")
            a.runModal()
            return
        }
        chatWindow.show(url: URL(string: "http://127.0.0.1:8090/settings")!, navigate: true)
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
        openItem?.title = openTitle()
        setIcon(running: up || starting)
    }
}
