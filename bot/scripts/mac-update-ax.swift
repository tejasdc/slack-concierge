#!/usr/bin/swift
import AppKit
import ApplicationServices
import Darwin
import Foundation

// This one-shot action is deliberately limited to the currently open Thinkering board.
private let appBundle = "com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792"
private let appPath = "/Users/tejasdc/Applications/Thinkering.app"
private let boardID = "94504c60-2b34-4fda-ba23-c20a6a71d7df"
private let maxElements = 20_000
private let receiptDirectory = "/Users/tejasdc/Library/Application Support/concierge"

private enum Action: String {
    case openWorkspace = "open-workspace"
    case updateNow = "update-now"
}

private struct Target {
    let webArea: AXUIElement
    let button: AXUIElement
    let pid: pid_t
}

private struct Snapshot {
    let target: Target?
    let updateNowCount: Int
    let updateAnywayCount: Int
}

private enum Refusal: Error, CustomStringConvertible {
    case reason(String)
    var description: String {
        switch self { case .reason(let reason): return reason }
    }
}

private func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if status == .noValue || status == .attributeUnsupported { return nil }
    if status != .success { throw Refusal.reason("AX attribute \(name) failed: \(status.rawValue)") }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ name: String) throws -> String? {
    guard let value = try attribute(element, name) else { return nil }
    if CFGetTypeID(value) == CFStringGetTypeID() { return value as? String }
    if CFGetTypeID(value) == CFURLGetTypeID() { return (value as? URL)?.absoluteString }
    throw Refusal.reason("Unexpected AX value for \(name)")
}

private let leafRoles: Set<String> = [
    "AXButton", "AXStaticText", "AXTextField", "AXTextArea", "AXImage", "AXLink",
    "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXSlider", "AXProgressIndicator",
    "AXValueIndicator", "AXMenuItem", "AXSeparator"
]

private func children(_ element: AXUIElement, role: String?) throws -> [AXUIElement] {
    guard let value = try attribute(element, kAXChildrenAttribute) else {
        guard let role, leafRoles.contains(role) else {
            throw Refusal.reason("AX children unavailable for non-leaf role \(role ?? "unknown")")
        }
        return []
    }
    guard let result = value as? [AXUIElement] else {
        throw Refusal.reason("Unexpected AX children value")
    }
    return result
}

private func currentApplication() throws -> (NSRunningApplication, AXUIElement) {
    guard AXIsProcessTrusted() else { throw Refusal.reason("AX process is not trusted") }
    let matches = NSRunningApplication.runningApplications(withBundleIdentifier: appBundle)
    guard matches.count == 1, let app = matches.first,
          app.bundleURL?.standardizedFileURL.path == appPath else {
        throw Refusal.reason("Expected exactly one installed Thinkering WebApp process")
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var pid: pid_t = 0
    guard AXUIElementGetPid(root, &pid) == .success, pid == app.processIdentifier else {
        throw Refusal.reason("AX application PID changed")
    }
    guard let windows = try attribute(root, kAXWindowsAttribute) as? [AXUIElement], windows.count == 1 else {
        throw Refusal.reason("Expected exactly one Thinkering window")
    }
    return (app, windows[0])
}

private func isCurrentBoard(_ urlText: String?) -> Bool {
    guard let urlText, let url = URL(string: urlText),
          url.scheme == "https", url.host == "thnkr.ing", url.path == "/boards",
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
    let boardItems = components.queryItems?.filter { $0.name == "board" } ?? []
    return boardItems.count == 1 && boardItems[0].value == boardID
}

private func reserveOnePress(_ action: Action) throws {
    try FileManager.default.createDirectory(atPath: receiptDirectory,
                                            withIntermediateDirectories: true)
    let marker = "\(receiptDirectory)/mac-update-2026-11-06-\(boardID)-\(action.rawValue).attempted"
    let descriptor = open(marker, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard descriptor >= 0 else {
        throw Refusal.reason("This fixed action was already attempted or its marker cannot be created")
    }
    let bytes = Array("press reserved before AX call\n".utf8)
    let written = bytes.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
    let synced = written == bytes.count && fsync(descriptor) == 0
    let closed = close(descriptor) == 0
    guard synced, closed else { throw Refusal.reason("One-shot marker could not be persisted") }
    let directory = open(receiptDirectory, O_RDONLY)
    guard directory >= 0 else { throw Refusal.reason("One-shot marker directory could not be opened") }
    let directorySynced = fsync(directory) == 0
    let directoryClosed = close(directory) == 0
    guard directorySynced, directoryClosed else {
        throw Refusal.reason("One-shot marker directory could not be persisted")
    }
}

private func snapshot(for action: Action, requireTarget: Bool = true) throws -> Snapshot {
    let (app, window) = try currentApplication()
    guard try stringAttribute(window, kAXRoleAttribute) == "AXWindow" else {
        throw Refusal.reason("Unexpected AX window role")
    }
    var pending: [(AXUIElement, AXUIElement?)] = [(window, nil)]
    var webAreas: [AXUIElement] = []
    var menuButtons: [(AXUIElement, AXUIElement)] = []
    var updateButtons: [(AXUIElement, AXUIElement)] = []
    var updateAnywayCount = 0
    var visited = 0
    while let (element, parentWebArea) = pending.popLast() {
        visited += 1
        if visited > maxElements { throw Refusal.reason("AX tree exceeded fixed bound") }
        let role = try stringAttribute(element, kAXRoleAttribute)
        let webArea = role == "AXWebArea" ? element : parentWebArea
        if role == "AXWebArea" { webAreas.append(element) }
        if role == "AXButton", let webArea {
            let title = try stringAttribute(element, kAXTitleAttribute)
            let description = try stringAttribute(element, kAXDescriptionAttribute)
            let help = try stringAttribute(element, kAXHelpAttribute)
            if title == "Open workspace menu · synced" && help == "Workspace menu" {
                menuButtons.append((element, webArea))
            }
            if title == "Update now" || description == "Update now" {
                updateButtons.append((element, webArea))
            }
            if title == "Update anyway" || description == "Update anyway" {
                updateAnywayCount += 1
            }
        }
        pending.append(contentsOf: try children(element, role: role).map { ($0, webArea) })
    }
    guard webAreas.count == 1, let currentWebArea = webAreas.first,
          isCurrentBoard(try stringAttribute(currentWebArea, kAXURLAttribute)) else {
        throw Refusal.reason("Current Thinkering board is not uniquely present")
    }
    let candidates = action == .openWorkspace ? menuButtons : updateButtons
    if requireTarget && (candidates.count != 1 || !CFEqual(candidates[0].1, currentWebArea)) {
        throw Refusal.reason("Expected exactly one action button under current board")
    }
    if requireTarget && action == .updateNow && updateAnywayCount != 0 {
        throw Refusal.reason("Update anyway is present; first-tap route refused")
    }
    let target = requireTarget ? Target(webArea: currentWebArea, button: candidates[0].0,
                                        pid: app.processIdentifier) : nil
    return Snapshot(target: target,
                    updateNowCount: updateButtons.count, updateAnywayCount: updateAnywayCount)
}

private func run(_ action: Action) throws {
    // The second fresh traversal supplies the retained AX object used by the single Press.
    _ = try snapshot(for: action)
    let current = try snapshot(for: action)
    guard let target = current.target else { throw Refusal.reason("No action target") }
    let (onlyApp, _) = try currentApplication()
    guard onlyApp.processIdentifier == target.pid,
          isCurrentBoard(try stringAttribute(target.webArea, kAXURLAttribute)),
          try stringAttribute(target.button, kAXRoleAttribute) == "AXButton" else {
        throw Refusal.reason("Current target changed before Press")
    }
    let title = try stringAttribute(target.button, kAXTitleAttribute)
    let description = try stringAttribute(target.button, kAXDescriptionAttribute)
    let help = try stringAttribute(target.button, kAXHelpAttribute)
    if action == .openWorkspace && (title != "Open workspace menu · synced" || help != "Workspace menu") {
        throw Refusal.reason("Workspace menu target changed before Press")
    }
    if action == .updateNow && title != "Update now" && description != "Update now" {
        throw Refusal.reason("Update now target changed before Press")
    }
    try reserveOnePress(action)
    let status = AXUIElementPerformAction(target.button, kAXPressAction as CFString)
    print("action=\(action.rawValue) press_status=\(status.rawValue) press_attempted=true")
    fflush(stdout)
    if status != .success { throw Refusal.reason("Press result is ambiguous; do not retry") }
    if action == .openWorkspace {
        // A fresh read is diagnostic only; this process never presses an update control.
        do {
            let after = try snapshot(for: .updateNow, requireTarget: false)
            print("observation=success update_now_count=\(after.updateNowCount) update_anyway_count=\(after.updateAnywayCount)")
        } catch {
            print("observation=failed reason=\(error)")
        }
    }
}

do {
    guard CommandLine.arguments.count == 2,
          let action = Action(rawValue: CommandLine.arguments[1]) else {
        throw Refusal.reason("Expected one fixed action argument")
    }
    try run(action)
} catch {
    fputs("refused=\(error)\n", stderr)
    exit(1)
}
