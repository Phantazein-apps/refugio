import AppKit
import WebKit

/// A native window hosting REFUGIO's chat UI.
///
/// The chat UI is a local web app, so the "native app" is a WKWebView pointed
/// at 127.0.0.1 — no browser, no address bar, no tab clutter. That completes
/// the goal of a user never seeing a terminal or a browser.
///
/// Deliberately minimal: REFUGIO's own UI supplies all the chrome, so this is
/// a window, a web view, and the few behaviours a webview doesn't give free.
final class ChatWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {

    private var window: NSWindow?
    private var web: WKWebView?
    private var url: URL

    init(url: URL) {
        self.url = url
        super.init()
    }

    /// Show the window, creating it on first use. Reuses the existing window on
    /// later calls so the conversation isn't reloaded out from under the user.
    ///
    /// The parameter is deliberately named apart from the `url` property. As
    /// `url:` it shadowed it, and the first-load path below then passed the
    /// OPTIONAL parameter where a URL was required — a compile error, but only
    /// on the one line of two that got it wrong, which is easy to read past.
    ///
    /// `navigate` forces a load into an already-open window. It defaults to
    /// false because reopening must never throw away the conversation on
    /// screen — but "Settings…" in the menu bar has to actually go somewhere,
    /// and without this it focused whatever was already showing and did
    /// nothing else, which reads as a dead menu item.
    func show(url newURL: URL? = nil, navigate: Bool = false) {
        let changed = newURL != nil && newURL != self.url
        if let newURL { self.url = newURL }

        if let window {
            if let web, web.url == nil || (navigate && changed) {
                web.load(URLRequest(url: self.url))
            }
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // persist localStorage across launches

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")  // avoid a white flash before CSS paints
        web.load(URLRequest(url: self.url))
        self.web = web

        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        w.title = "REFUGIO (beta)"
        w.titlebarAppearsTransparent = true
        // Drag the window by its background, not only the title bar. The title
        // bar is transparent and thin here, so the obvious place to grab —
        // REFUGIO's own top strip — was not a handle at all. WKWebView consumes
        // clicks on its own controls, so this adds a drag surface without
        // taking one away.
        w.isMovableByWindowBackground = true
        w.minSize = NSSize(width: 640, height: 480)
        w.contentView = web
        w.delegate = self
        w.center()
        // Remember size/position between launches.
        w.setFrameAutosaveName("RefugioChatWindow")
        w.isReleasedWhenClosed = false
        self.window = w

        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func reload() { web?.reload() }

    var isVisible: Bool { window?.isVisible ?? false }

    // Closing the window must not quit the app — this is a menu-bar agent, and
    // REFUGIO keeps running. Hide instead so reopening is instant.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    // Links to anywhere other than the local UI open in the real browser: the
    // window is REFUGIO, not a general-purpose browser.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = navigationAction.request.url else {
            decisionHandler(.allow); return
        }
        let isLocal = target.host == "127.0.0.1" || target.host == "localhost"
            || target.host == "refugio" || target.host?.hasSuffix(".localhost") == true
        if isLocal {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            NSWorkspace.shared.open(target)
        }
    }

    // target="_blank" has no window to open into here — send it to the browser.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = navigationAction.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    /// If the server isn't up yet the load fails; retry briefly rather than
    /// leaving the user staring at a blank window right after "Start".
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retrySoon()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retrySoon()
    }

    private var retries = 0
    private func retrySoon() {
        guard retries < 20 else { return }     // ~30s, then give up quietly
        retries += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, let web = self.web else { return }
            web.load(URLRequest(url: self.url))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retries = 0
    }
}
