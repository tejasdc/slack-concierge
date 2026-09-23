// Screenshots for agents working on Tejas's Mac.
//
//   mac-screenshot status            what macOS currently permits; never prompts
//   mac-screenshot windows [name]    the capturable windows, narrowed by owning app
//   mac-screenshot displays          the screens
//   mac-screenshot window <id>       one window's pixels, and nothing else on screen
//   mac-screenshot app <name>        that app's largest on-screen window
//   mac-screenshot display [<id>]    a whole screen, only when asked for explicitly
//
// Prints JSON; writes the PNG to --out, or to a temporary file whose path it prints.
//
// Why ScreenCaptureKit rather than /usr/sbin/screencapture: without the permission the
// system tool still writes a file, holding the desktop picture and the menu bar with every
// window missing, so a caller cannot tell a refusal from a picture of the wallpaper.
// ScreenCaptureKit is the capture API Apple documents for macOS ("Capturing screen content
// in macOS"), SCScreenshotManager takes one frame (macOS 14+), and
// SCContentFilter(desktopIndependentWindow:) captures exactly one window — so asking for a
// panel never photographs whatever else is on the screen.
//
// The permission is asked for at the moment a capture is first wanted, never at startup, and
// it belongs to the signed agent-host app the whole service runs inside: macOS decides by the
// responsible process, so the alert names that app and the approval is remembered by its
// bundle identifier and signing key. See docs/runbooks/PEER-INSTANCES.md. There is no
// entitlement and no Info.plist purpose string for screen capture — the alert's words are the
// system's — so what Tejas is told has to come from the caller, which is why refusing here
// prints the sentence to relay to him rather than a bare error.
// Built by scripts/install-mac.sh; run through scripts/mac-screenshot.

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// ScreenCaptureKit hands back a CGImage, and Core Graphics asserts (CGS_REQUIRE_INIT) unless
// the process has connected to the window server. A command-line tool started deep inside the
// agent host has not; this is the documented way to make one window-server capable without
// becoming a visible app: touching NSApplication connects, and this process is a background
// tool (no activation policy, no window), so nothing appears in the Dock or on screen.
_ = NSApplication.shared

let hostName = ProcessInfo.processInfo.environment["CONCIERGE_MAC_APP_NAME"] ?? "the agent host"

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("mac-screenshot: \(message)\n".utf8))
    exit(code)
}

/// Exit 77 and the words to relay. macOS asks only while the answer is still unknown: once he
/// has refused, it will not ask again, and the switch is the only way back — which is the one
/// case where naming System Settings is honest.
func refuse() -> Never {
    // Asking is the whole point of arriving here; it is the moment a capture was wanted.
    if CGRequestScreenCaptureAccess() {
        fail("""
        macOS answered while this command was running. Run the same command again.
        """, code: 75)
    }
    fail("""
    Screen capture is not permitted yet, so nothing was captured.

    macOS has just been asked. Its alert names "\(hostName)" — the app every agent session on
    this Mac runs inside. Tell Tejas what the picture is for, that allowing it lets any agent
    session here capture this screen until he turns it off in System Settings > Privacy &
    Security > Screen & System Audio Recording, and run this again once he has answered.

    If no alert appeared, he refused before and macOS will not ask a second time; that same
    switch is what turns it on.
    """, code: 77)
}

func requirePermission() {
    if !CGPreflightScreenCaptureAccess() { refuse() }
}

func shareableContent() async -> SCShareableContent {
    do {
        return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    } catch {
        // Permission can be withdrawn between the preflight and here, and then this is the
        // refusal rather than a fault worth a stack trace.
        if (error as NSError).code == -3801 { refuse() }
        fail("macOS would not list the screen contents: \(error.localizedDescription)")
    }
}

func describe(_ window: SCWindow) -> [String: Any] {
    [
        "id": window.windowID,
        "app": window.owningApplication?.applicationName ?? "",
        "bundleId": window.owningApplication?.bundleIdentifier ?? "",
        "title": window.title ?? "",
        "width": Int(window.frame.width),
        "height": Int(window.frame.height),
    ]
}

/// Windows a picture could sensibly mean: on screen, in the normal window layer, not a sliver.
func ordinaryWindows(_ content: SCShareableContent) -> [SCWindow] {
    content.windows
        .filter { $0.isOnScreen && $0.windowLayer == 0 && $0.frame.width > 80 && $0.frame.height > 80 }
        .sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }
}

func write(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path)
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fail("cannot write a PNG to \(path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    if !CGImageDestinationFinalize(destination) { fail("cannot write a PNG to \(path)") }
}

func capture(_ filter: SCContentFilter, to path: String, what: [String: Any]) async -> Never {
    let configuration = SCStreamConfiguration()
    // Points to pixels, so a Retina window arrives at its real resolution rather than half of it.
    configuration.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
    configuration.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
    configuration.showsCursor = false
    configuration.capturesAudio = false
    do {
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        write(image, to: path)
        var result = what
        result["path"] = path
        result["pixelWidth"] = image.width
        result["pixelHeight"] = image.height
        emit(result)
        exit(0)
    } catch {
        if (error as NSError).code == -3801 { refuse() }
        fail("macOS would not capture that: \(error.localizedDescription)")
    }
}

func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func outputPath(_ arguments: [String], _ label: String) -> String {
    if let given = option("--out", in: arguments) { return given }
    let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
    let safe = label.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: " ", with: "-")
    return FileManager.default.temporaryDirectory
        .appendingPathComponent("mac-screenshot-\(safe)-\(stamp).png").path
}

let arguments = Array(CommandLine.arguments.dropFirst())
let command = arguments.first ?? "status"

switch command {
case "status":
    // Deliberately only a preflight: asking is the capture commands' job, at the moment of need.
    emit([
        "permitted": CGPreflightScreenCaptureAccess(),
        "host": hostName,
        "note": "Permission belongs to the agent-host app; every agent session on this Mac captures as it.",
    ])

case "windows":
    requirePermission()
    let wanted = arguments.dropFirst().first { !$0.hasPrefix("--") }?.lowercased()
    let windows = ordinaryWindows(await shareableContent()).filter { window in
        guard let wanted else { return true }
        let app = (window.owningApplication?.applicationName ?? "").lowercased()
        return app.contains(wanted) || (window.title ?? "").lowercased().contains(wanted)
    }
    emit(["windows": windows.map(describe)])

case "displays":
    requirePermission()
    emit(["displays": (await shareableContent()).displays.map { display in
        ["id": display.displayID, "width": display.width, "height": display.height]
    }])

case "window":
    requirePermission()
    guard let given = arguments.dropFirst().first, let id = UInt32(given) else {
        fail("usage: mac-screenshot window <id from `mac-screenshot windows`> [--out <path>]")
    }
    guard let window = (await shareableContent()).windows.first(where: { $0.windowID == id }) else {
        fail("no window with id \(id) is on screen now; run `mac-screenshot windows` again")
    }
    await capture(SCContentFilter(desktopIndependentWindow: window),
                  to: outputPath(arguments, window.owningApplication?.applicationName ?? "window"),
                  what: describe(window))

case "app":
    requirePermission()
    guard let wanted = arguments.dropFirst().first(where: { !$0.hasPrefix("--") })?.lowercased() else {
        fail("usage: mac-screenshot app <name, e.g. Safari> [--out <path>]")
    }
    let matches = ordinaryWindows(await shareableContent()).filter {
        ($0.owningApplication?.applicationName ?? "").lowercased().contains(wanted)
            || ($0.owningApplication?.bundleIdentifier ?? "").lowercased().contains(wanted)
    }
    guard let window = matches.first else {
        fail("no on-screen window belongs to an app matching \"\(wanted)\"; run `mac-screenshot windows`")
    }
    await capture(SCContentFilter(desktopIndependentWindow: window),
                  to: outputPath(arguments, window.owningApplication?.applicationName ?? "app"),
                  what: describe(window))

case "display":
    requirePermission()
    let displays = (await shareableContent()).displays
    let given = arguments.dropFirst().first { !$0.hasPrefix("--") }
    let display = given.flatMap { wanted in displays.first { String($0.displayID) == wanted } } ?? displays.first
    guard let display else { fail("this Mac reports no displays") }
    await capture(SCContentFilter(display: display, excludingWindows: []),
                  to: outputPath(arguments, "display-\(display.displayID)"),
                  what: ["display": display.displayID, "width": display.width, "height": display.height])

default:
    fail("""
    usage:
      mac-screenshot status
      mac-screenshot windows [name]
      mac-screenshot displays
      mac-screenshot window <id> [--out <path>]
      mac-screenshot app <name> [--out <path>]
      mac-screenshot display [<id>] [--out <path>]

    Prefer a window over a display: a picture of one window is the narrowest thing that
    answers the question, and it keeps everything else he has open out of the file. For a
    page in Thinkering or any other web app, prefer the browser's own screenshot
    (agent-browser, Playwright) — that needs no permission from him at all.
    """, code: 64)
}
