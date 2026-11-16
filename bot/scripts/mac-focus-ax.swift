#!/usr/bin/swift
import AppKit
import ApplicationServices
import Darwin
import Foundation

private let bundle = "com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792"
private let appPath = "/Users/tejasdc/Applications/Thinkering.app"
private let receiptDirectory = "/Users/tejasdc/Library/Application Support/concierge"
private let receiptPrefix = "mac-focus-775cda97-8177-4202-8545-b451f74ef3bd-"
private let maxElements = 20_000

private enum Action: String { case start, end, verifyStart = "verify-start" }
private struct Target {
    let pid: pid_t
    let window: AXUIElement
    let webArea: AXUIElement
    let button: AXUIElement
    let url: String
}
private struct Snapshot {
    let target: Target
    let startCount: Int
    let endCount: Int
}
private enum Refusal: Error, CustomStringConvertible {
    case reason(String)
    var description: String { switch self { case .reason(let message): return message } }
}
private func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if result == .noValue || result == .attributeUnsupported { return nil }
    if result != .success { throw Refusal.reason("AX read failed for \(name): \(result.rawValue)") }
    return value
}
private func string(_ element: AXUIElement, _ name: String) throws -> String? {
    guard let value = try attribute(element, name) else { return nil }
    if CFGetTypeID(value) == CFStringGetTypeID() { return value as? String }
    if CFGetTypeID(value) == CFURLGetTypeID() { return (value as? URL)?.absoluteString }
    throw Refusal.reason("Unexpected AX value for \(name)")
}
private func enabled(_ element: AXUIElement) throws -> Bool {
    guard let value = try attribute(element,kAXEnabledAttribute),
          CFGetTypeID(value) == CFBooleanGetTypeID() else {
        throw Refusal.reason("Target enabled state unavailable")
    }
    return CFBooleanGetValue(value as! CFBoolean)
}
private let leafRoles: Set<String> = [
    "AXButton", "AXStaticText", "AXTextField", "AXTextArea", "AXImage", "AXLink",
    "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXSlider", "AXProgressIndicator",
    "AXValueIndicator", "AXMenuItem", "AXSeparator"
]
private func children(_ element: AXUIElement, _ role: String?) throws -> [AXUIElement] {
    guard let value = try attribute(element, kAXChildrenAttribute) else {
        if let role, leafRoles.contains(role) { return [] }
        throw Refusal.reason("AX children unavailable")
    }
    guard let result = value as? [AXUIElement] else { throw Refusal.reason("Unexpected AX children") }
    return result
}
private func appAndWindow() throws -> (NSRunningApplication, AXUIElement) {
    guard AXIsProcessTrusted() else { throw Refusal.reason("AX process is not trusted") }
    let matches = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
    guard matches.count == 1, let app = matches.first, app.bundleURL?.standardizedFileURL.path == appPath else {
        throw Refusal.reason("Expected one installed Thinkering WebApp")
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var pid: pid_t = 0
    guard AXUIElementGetPid(root, &pid) == .success, pid == app.processIdentifier else {
        throw Refusal.reason("Thinkering process changed")
    }
    guard let windows = try attribute(root, kAXWindowsAttribute) as? [AXUIElement], windows.count == 1 else {
        throw Refusal.reason("Expected one Thinkering window")
    }
    return (app, windows[0])
}
private func validDocument(_ text: String) -> Bool {
    guard let url = URLComponents(string: text) else { return false }
    return url.scheme == "https" && url.host == "thnkr.ing"
        && url.user == nil && url.password == nil && url.port == nil
}
private func matches(_ element: AXUIElement, _ prefix: String) throws -> Bool {
    let title = try string(element, kAXTitleAttribute) ?? ""
    let description = try string(element, kAXDescriptionAttribute) ?? ""
    return title.hasPrefix(prefix) || description.hasPrefix(prefix)
}
private func snapshot(_ action: Action) throws -> Snapshot {
    let (app, window) = try appAndWindow()
    guard try string(window, kAXRoleAttribute) == "AXWindow" else { throw Refusal.reason("Unexpected window") }
    var pending: [(AXUIElement, AXUIElement?)] = [(window,nil)]
    var areas: [AXUIElement] = []
    var starts: [(AXUIElement,AXUIElement)] = []
    var ends: [(AXUIElement,AXUIElement)] = []
    var seen = 0
    while let (element,parentArea) = pending.popLast() {
        seen += 1
        if seen > maxElements { throw Refusal.reason("AX tree exceeded bound") }
        let role = try string(element, kAXRoleAttribute)
        let area = role == "AXWebArea" ? element : parentArea
        if role == "AXWebArea" { areas.append(element) }
        if role == "AXButton", let area {
            if try matches(element,"Start Deep work (") { starts.append((element,area)) }
            if try matches(element,"End Deep work (") { ends.append((element,area)) }
        }
        pending.append(contentsOf: try children(element,role).map { ($0,area) })
    }
    guard areas.count == 1, let area = areas.first,
          let url = try string(area,kAXURLAttribute), validDocument(url) else {
        throw Refusal.reason("Current Thinkering document is not unique")
    }
    let candidates = action == .start ? starts : ends
    guard candidates.count == 1, CFEqual(candidates[0].1,area) else {
        throw Refusal.reason("Expected one matching Deep work control in current document")
    }
    if action == .start && !ends.isEmpty { throw Refusal.reason("A Deep work session may already be open") }
    if action != .start && !starts.isEmpty { throw Refusal.reason("Deep work control state is ambiguous") }
    return Snapshot(target:Target(pid:app.processIdentifier,window:window,webArea:area,button:candidates[0].0,url:url),
                    startCount:starts.count,endCount:ends.count)
}
private func marker(_ action: Action, _ suffix: String) -> String {
    receiptDirectory + "/" + receiptPrefix + action.rawValue + "." + suffix
}
private func recentMatchingReceipt(_ path: String, _ target: Target) throws -> Bool {
    guard let data = FileManager.default.contents(atPath:path),
          let recorded = String(data:data,encoding:.utf8),
          let modified = try FileManager.default.attributesOfItem(atPath:path)[.modificationDate] as? Date,
          Date().timeIntervalSince(modified) >= 0,
          Date().timeIntervalSince(modified) < 600 else { return false }
    return recorded == "\(target.pid)\n\(target.url)\n"
}
private func persistExclusive(_ path: String, _ value: String) throws {
    try FileManager.default.createDirectory(atPath:receiptDirectory,withIntermediateDirectories:true)
    let descriptor = open(path,O_WRONLY|O_CREAT|O_EXCL,0o600)
    guard descriptor >= 0 else { throw Refusal.reason("This action was attempted already or marker cannot be created") }
    let bytes = Array(value.utf8)
    let written = bytes.withUnsafeBytes { write(descriptor,$0.baseAddress,$0.count) }
    let synced = written == bytes.count && fsync(descriptor) == 0
    let closed = close(descriptor) == 0
    guard synced && closed else { throw Refusal.reason("Action marker was not persisted") }
    let directory = open(receiptDirectory,O_RDONLY)
    guard directory >= 0 else { throw Refusal.reason("Action directory unavailable") }
    let directorySynced = fsync(directory) == 0
    let directoryClosed = close(directory) == 0
    guard directorySynced && directoryClosed else { throw Refusal.reason("Action directory not persisted") }
}
private func run(_ action: Action) throws {
    let first = try snapshot(action)
    if action == .verifyStart {
        guard try recentMatchingReceipt(marker(.start,"press-accepted"),first.target) else {
            throw Refusal.reason("No recent matching accepted Start press")
        }
        guard try enabled(first.target.button) else {
            throw Refusal.reason("Running Deep work control is not enabled")
        }
        let second = try snapshot(action)
        guard first.target.pid == second.target.pid,
              CFEqual(first.target.window,second.target.window),
              CFEqual(first.target.webArea,second.target.webArea),
              CFEqual(first.target.button,second.target.button),
              first.target.url == second.target.url else {
            throw Refusal.reason("Running Deep work control changed during readback")
        }
        guard try enabled(second.target.button) else {
            throw Refusal.reason("Running Deep work control is not enabled on readback")
        }
        try persistExclusive(marker(.start,"ui-verified"),"\(second.target.pid)\n\(second.target.url)\n")
        print("start_ui_readback=verified backend_readback=required")
        return
    }
    if action == .end {
        guard try recentMatchingReceipt(marker(.start,"ui-verified"),first.target) else {
            throw Refusal.reason("No recent matching verified Start UI state; existing Focus session is preserved")
        }
    }
    let second = try snapshot(action)
    let earlier = first.target
    let target = second.target
    guard earlier.pid == target.pid, CFEqual(earlier.window,target.window),
          CFEqual(earlier.webArea,target.webArea), CFEqual(earlier.button,target.button),
          earlier.url == target.url else { throw Refusal.reason("Current document or target changed") }
    let (app,window) = try appAndWindow()
    guard app.processIdentifier == target.pid, CFEqual(window,target.window),
          try string(target.webArea,kAXURLAttribute) == target.url,
          try string(target.button,kAXRoleAttribute) == "AXButton",
          try enabled(target.button) else {
        throw Refusal.reason("Target changed before press")
    }
    guard try matches(target.button,action == .start ? "Start Deep work (" : "End Deep work (") else {
        throw Refusal.reason("Target label changed before press")
    }
    try persistExclusive(marker(action,"attempted"),"reserved before AX action\n")
    let result = AXUIElementPerformAction(target.button,kAXPressAction as CFString)
    print("action=\(action.rawValue) press_status=\(result.rawValue) press_attempted=true")
    fflush(stdout)
    if result != .success { throw Refusal.reason("Press result ambiguous; do not retry") }
    try persistExclusive(marker(action,"press-accepted"),"\(target.pid)\n\(target.url)\n")
    // AX accepted a Press. It has not established the backend Focus transition.
    print("ax_press_accepted=true positive_ui_and_backend_readback=required")
}
do {
    guard CommandLine.arguments.count == 2, let action = Action(rawValue:CommandLine.arguments[1]) else {
        throw Refusal.reason("Expected one fixed Focus action")
    }
    try run(action)
} catch {
    fputs("refused=\(error)\n",stderr)
    exit(1)
}
