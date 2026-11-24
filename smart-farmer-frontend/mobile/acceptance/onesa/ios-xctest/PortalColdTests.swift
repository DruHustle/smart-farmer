import XCTest
import UIKit

final class PortalColdTests: XCTestCase {
    private enum Checkpoint: String {
        case fixture, signedOut, reauthenticate, rememberedSession, configRetry, signInControl
        case consent, email, password, remember, firstSubmit
        case mfa, secondSubmit, returnLink, nativeInvitation, joinFarm
        case farmWorkspace, forumTab, forumScreen, forumFeed, completed
    }

    private var currentCheckpoint: Checkpoint = .fixture
    private var retainedCancelFrame = false

    // Only these fixed names leave the runner. Never print a field, URL or assertion payload.
    private func checkpoint(_ value: Checkpoint) {
        currentCheckpoint = value
        print("FARMER_XCUI_CHECKPOINT " + value.rawValue)
    }

    private enum ControlPhase: String { case startup, cancel }
    private enum ControlOwner: String { case farmer, safari, authSheet }
    private enum PreInputControl: String {
        case signIn, configRetry, cancelButton, cancelLink
    }
    private enum ControlFact: String {
        case absent, present, enabled, disabled, hittable
        case visibleFrame = "visible-frame", hiddenFrame = "not-visible-frame"
        case hitQuery = "hittable-query", notHittable = "not-hittable"
    }
    private var recordedControls = Set<String>()

    @discardableResult private func controlFact(_ phase: ControlPhase, _ owner: ControlOwner,
                                                _ control: PreInputControl, _ fact: ControlFact) -> Bool {
        let value = [phase.rawValue, owner.rawValue, control.rawValue, fact.rawValue].joined(separator: " ")
        guard recordedControls.count < 64, recordedControls.insert(value).inserted else { return false }
        print("FARMER_XCUI_CONTROL " + value)
        return true
    }

    @MainActor private func controlReady(_ element: XCUIElement, phase: ControlPhase,
                                        owner: ControlOwner, control: PreInputControl) -> Bool {
        guard element.exists else {
            controlFact(phase, owner, control, .absent)
            return false
        }
        // Record the exact known control before AX can abort while computing a
        // hit point. No element label, value, coordinate or user input is logged.
        if controlFact(phase, owner, control, .present) {
            controlFact(phase, owner, control, element.isEnabled ? .enabled : .disabled)
            let frame = element.frame
            let visible = !frame.isEmpty && !frame.isInfinite && app.frame.contains(frame)
            controlFact(phase, owner, control, visible ? .visibleFrame : .hiddenFrame)
        }
        controlFact(phase, owner, control, .hitQuery)
        let hittable = element.isHittable
        controlFact(phase, owner, control, hittable ? .hittable : .notHittable)
        return hittable
    }

    @MainActor private lazy var app = XCUIApplication(bundleIdentifier: "eu.onesa.smartfarmer")
    @MainActor private lazy var safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    @MainActor private lazy var authSheet = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
    @MainActor private lazy var springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    @MainActor private func waitFor(_ check: () -> Bool, seconds: TimeInterval = 45) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if check() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return false
    }

    // iOS embeds the Safari view service in Farmer. Its accessibility tree can
    // remain live while XCTest reports that service in the background.
    @MainActor private var browserOwners: [XCUIApplication] {
        var owners: [XCUIApplication] = []
        if [.runningForeground, .runningBackground].contains(authSheet.state) { owners.append(authSheet) }
        if safari.state == .runningForeground { owners.append(safari) }
        if app.state == .runningForeground { owners.append(app) }
        return owners
    }

    @MainActor private func startOnesaSignIn(reauthenticate: Bool = false) throws {
        app.launch()
        if reauthenticate {
            checkpoint(.reauthenticate)
            let lock = app.descendants(matching: .any)["device-reauthenticate"].firstMatch
            let ready = waitFor({ lock.exists && lock.isEnabled && lock.isHittable }, seconds: 60)
            try XCTUnwrap(ready ? lock : nil, "Restarted Farmer offers device reauthentication").tap()
            XCTAssertTrue(lock.waitForNonExistence(timeout: 30), "Device lock sheet dismissed before sign-in")
        }
        let start = app.descendants(matching: .any)["auth-onesa"].firstMatch
        let retry = app.descendants(matching: .any)["auth-onesa-retry"].firstMatch
        var retriedConfiguration = false
        let ready = waitFor({
            guard self.app.state == .runningForeground else { return false }
            if self.controlReady(start, phase: .startup, owner: .farmer, control: .signIn), start.isEnabled {
                return true
            }
            // A failed configuration request exposes the app's existing Retry.
            // Exercise it once before beginning any browser authorization.
            if !retriedConfiguration, self.controlReady(retry, phase: .startup, owner: .farmer, control: .configRetry), retry.isEnabled {
                retriedConfiguration = true
                self.checkpoint(.configRetry)
                retry.tap()
            }
            return false
        }, seconds: 60)
        let button = try XCTUnwrap(ready ? start : nil, "Installed release Farmer offers Onesa sign-in")
        checkpoint(.signInControl)
        button.tap()
    }

    @MainActor private func browserConsent() -> XCUIElement? {
        // Only query the exact system prompt. Enumerating every alert on a stale
        // background SafariViewService can abort XCTest before authorization.
        let prompt = NSPredicate(format: "label MATCHES[c] %@",
            #"^[“"]Smart\s?Farmer[”"]\s+Wants\s+to\s+Use\s+[“"](localhost|127[.]0[.]0[.]1)[”"]\s+to\s+Sign\s+In$"#)
        for owner in [springboard, app] {
            let title = owner.staticTexts.matching(prompt).firstMatch
            guard title.exists else { continue }
            let cancel = owner.buttons["Cancel"].firstMatch
            let accept = owner.buttons["Continue"].firstMatch
            if cancel.exists && accept.exists && accept.isEnabled && accept.isHittable { return accept }
        }
        return nil
    }

    @MainActor private func captureConsentFailure() {
        guard let directory = ProcessInfo.processInfo.environment["FARMER_XCUI_EVIDENCE_DIR"] else { return }
        guard let data = XCUIScreen.main.screenshot().image.pngData() else { return }
        let destination = URL(fileURLWithPath: directory).appendingPathComponent("ios-consent-unresolved.png")
        try? data.write(to: destination, options: .atomic)
    }

    @MainActor private func awaitBrowser(captureFailure: Bool = true, _ ready: @escaping () -> Bool) -> Bool {
        var lastConsentTap: Date?
        var retriedConsent = false
        let visible = waitFor({
            // A SpringBoard consent alert can abort a full-screen XCTest
            // snapshot on a cold simulator. Prefer its exact verified native
            // accessibility controls before asking the compositor for pixels.
            if let accept = self.browserConsent() {
                self.renderObserved(.systemConsent)
                if let previous = lastConsentTap, retriedConsent || Date().timeIntervalSince(previous) < 5 {
                    return false
                }
                retriedConsent = lastConsentTap != nil
                lastConsentTap = Date()
                accept.tap()
                self.renderObserved(.consentTapped)
                return false
            }
            // When SpringBoard cannot publish the control, use the observed
            // frame (or an actual browser surface) instead of guessing a tap.
            let screen = self.renderedScreen()
            var consent: BrowserAction?
            // Prefer the actual verified operating-system Continue control.
            // A compositor frame can describe a real consent prompt while a
            // coordinate touch on the app window never reaches SpringBoard.
            // Keep the fixed-title accessibility guard; use the recognized
            // frame only when WebKit does not publish the native control.
            if screen?.systemConsentPoint() != nil, let button = self.browserConsent() {
                consent = .element(button)
            } else if let point = screen?.systemConsentPoint() {
                consent = .point(point)
            } else if screen?.hasLoopbackChrome == true {
                self.renderObserved(.browserVisible)
                return true
            } else if let button = self.browserConsent() {
                consent = .element(button)
            }
            if let consent {
                self.renderObserved(.systemConsent)
                if let previous = lastConsentTap, retriedConsent || Date().timeIntervalSince(previous) < 5 {
                    return false
                }
                retriedConsent = lastConsentTap != nil
                lastConsentTap = Date()
                consent.tap()
                self.renderObserved(.consentTapped)
                return false
            }
            // Fall back to a visible live browser surface if OCR is unavailable.
            // The caller still has to identify the real issuer or return control.
            return [self.app, self.safari, self.authSheet].contains { owner in
                owner.state == .runningForeground && owner.webViews.firstMatch.exists
            }
        }, seconds: 90)
        guard visible else {
            if captureFailure { captureConsentFailure() }
            return false
        }
        return waitFor(ready) || ready()
    }

    @MainActor private func field(_ label: String, in web: XCUIElement) -> XCUIElement {
        let fields = label == "Password" ? web.secureTextFields : web.textFields
        // WebKit may expose the external HTML label on a neighbouring text
        // node. Only use the unnamed control if its type is unique in the
        // verified issuer form. The MFA page has another text input.
        if web is XCUIApplication {
            let exact = fields.matching(NSPredicate(format: "label == %@", label))
            if exact.count == 1 { return exact.firstMatch }
            if ["Email address", "Password"].contains(label), fields.count == 1 { return fields.firstMatch }
            return exact.firstMatch
        }
        let named = fields[label]
        return named.exists ? named : fields.matching(NSPredicate(format: "label CONTAINS[c] %@", label)).firstMatch
    }

    @MainActor private func keyboardReady(_ acceptedTutorial: inout Bool) -> Bool {
        let owners = browserOwners + [springboard]
        for surface in owners {
            let tutorial = surface.descendants(matching: .any)["UIContinuousPathIntroductionView"].firstMatch
            guard tutorial.exists else { continue }
            let explanation = surface.staticTexts["Speed up your typing by sliding your finger across the letters to compose a word."].firstMatch
            if !acceptedTutorial && explanation.exists {
                let buttons = surface.buttons.matching(NSPredicate(format: "label == %@", "Continue")).allElementsBoundByIndex
                if let button = buttons.first(where: { $0.isHittable && $0.frame.minY >= explanation.frame.maxY &&
                    tutorial.frame.intersects($0.frame) }) {
                    button.tap()
                    acceptedTutorial = true
                }
            }
            return false
        }
        return owners.contains { $0.keyboards.firstMatch.exists }
    }

    @MainActor private func enter(_ value: String, into label: String, in web: XCUIElement) throws {
        var acceptedTutorial = false
        let input = field(label, in: web)
        let editable = waitFor({ input.exists && input.isEnabled && !input.frame.intersection(self.app.frame).isEmpty }, seconds: 15)
        _ = try XCTUnwrap(editable ? true : nil, "Browser input is editable")
        if input.isHittable {
            input.tap()
        } else {
            // The remote view may be backgrounded while the embedded sheet is
            // visible. Tap the real field within the foreground app's display.
            let visible = input.frame.intersection(app.frame)
            let point = CGVector(dx: visible.midX - app.frame.minX, dy: visible.midY - app.frame.minY)
            app.coordinate(withNormalizedOffset: .zero).withOffset(point).tap()
        }
        if !waitFor({ self.keyboardReady(&acceptedTutorial) }, seconds: 6), input.exists && input.isEnabled && input.isHittable {
            // A newly presented WebKit field can appear before its first tap
            // gives the software keyboard focus. This repeat only focuses it.
            let visible = web.frame.intersection(input.frame)
            if web is XCUIApplication {
                input.tap()
            } else if !visible.isEmpty {
                let offset = CGVector(dx: visible.midX - web.frame.minX, dy: visible.midY - web.frame.minY)
                web.coordinate(withNormalizedOffset: .zero).withOffset(offset).tap()
            }
        }
        let ready = waitFor({ self.keyboardReady(&acceptedTutorial) }, seconds: 10)

        // A focused descendant receives real OS typing. Verify privately that
        // the intended field received it before entering another value.
        let typingTarget = web is XCUIApplication ? input : web
        let keyboardTarget = try XCTUnwrap(ready ? typingTarget : nil, "Browser keyboard is ready for input")
        // A bulk XCTest key stream dropped characters in the live WebKit email
        // field. Dispatch each key separately so the remote keyboard completes
        // one event before the next. Never submit or retry a mismatched value.
        for character in value { keyboardTarget.typeText(String(character)) }
        let received = waitFor({
            let current = self.field(label, in: web)
            guard let actual = current.value as? String else { return false }
            if label == "Password" {
                return current.elementType == .secureTextField && actual.count == value.count &&
                    actual.allSatisfy { $0 == "•" || $0 == "●" }
            }
            return actual == value
        }, seconds: 5)
        _ = try XCTUnwrap(received ? true : nil, "Named browser input received the fixture value")
    }

    @MainActor private func dismissNativeKeyboard() throws {
        var doneTyping: XCUIElement?
        XCTAssertTrue(waitFor({
            for surface in browserOwners + [springboard] {
                let done = surface.buttons["Done"].firstMatch
                if done.exists && done.isHittable { doneTyping = done; return true }
            }
            return false
        }, seconds: 10), "Native browser Done control")
        try XCTUnwrap(doneTyping).tap()
        XCTAssertTrue(waitFor({
            (self.browserOwners + [self.springboard]).allSatisfy { !$0.keyboards.firstMatch.exists }
        }, seconds: 10), "Native keyboard dismissed before form action")
    }

    @MainActor private func portalWeb() -> XCUIElement? {
        // SafariViewService may report background state while its embedded
        // authentication view remains visible inside Farmer. The input helper
        // already uses a foreground-app coordinate when a descendant is not
        // independently hittable, so do not discard that valid browser tree.
        for owner in browserOwners {
            let web = owner.webViews.firstMatch
            guard web.exists else { continue }
            let email = field("Email address", in: web)
            if email.exists && email.isEnabled && !email.frame.intersection(app.frame).isEmpty { return web }
        }
        return nil
    }

    // Verify the whole embedded sheet when the foreground web view lookup
    // misses it. HTML labels can be separate siblings of the input nodes.
    @MainActor private func embeddedIssuer() -> XCUIApplication? {
        for owner in browserOwners {
            guard owner.webViews.count > 0 else { continue }
            let nodes = owner.descendants(matching: .any)
            let cancelButton = owner.buttons["Cancel sign-in"].firstMatch
            let cancelLink = owner.links["Cancel sign-in"].firstMatch
            guard nodes["Sign in to Onesa"].firstMatch.exists,
                  nodes["Remember this browser"].firstMatch.exists,
                  cancelButton.exists || cancelLink.exists else { continue }
            let email = field("Email address", in: owner)
            let password = field("Password", in: owner)
            guard email.exists, password.exists, email.isEnabled, password.isEnabled,
                  !email.frame.intersection(app.frame).isEmpty else { continue }
            return owner
        }
        return nil
    }

    @MainActor private func remember(_ web: XCUIElement) throws {
        let checkbox = web.checkBoxes["Remember this browser"].firstMatch
        let toggle = web.switches["Remember this browser"].firstMatch
        try XCTUnwrap(waitFor({ checkbox.exists || toggle.exists }, seconds: 10) ? true : nil,
                      "Browser remembers this synthetic account")
        let control = checkbox.exists ? checkbox : toggle
        if control.value as? String != "1" { control.tap() }
        try XCTUnwrap(control.value as? String == "1" ? true : nil, "Remember control is checked")
    }

    @MainActor private func submit(_ web: XCUIElement) throws {
        let button = web.buttons["Continue"].firstMatch
        let ready = waitFor({ button.exists && button.isEnabled && button.isHittable }, seconds: 15)
        try XCTUnwrap(ready ? button : nil, "Portal Continue is enabled").tap()
    }

    private enum BrowserAction {
        case element(XCUIElement)
        case point(XCUICoordinate)

        @MainActor func tap() {
            switch self {
            case .element(let element): element.tap()
            case .point(let point): point.tap()
            }
        }
    }

    private struct RenderedScreen {
        let rows: [(text: String, box: CGRect)]
        let display: CGRect
        let owners: [XCUIApplication]

        var words: Set<String> { Set(rows.map { $0.text }) }
        let titleBottom: CGFloat?
        var hasLoopbackChrome: Bool { titleBottom != nil }

        func unique(_ text: String) -> CGRect? {
            let matches = rows.filter { $0.text == text }
            return matches.count == 1 ? matches[0].box : nil
        }

        @MainActor func systemConsentPoint() -> XCUICoordinate? {
            guard let title = unique("systemConsentTitle"),
                  let cancel = unique("Cancel"), let accept = unique("Continue"),
                  title.minY > max(cancel.maxY, accept.maxY),
                  cancel.maxX < accept.minX,
                  abs(cancel.midY - accept.midY) < max(cancel.height, accept.height)
            else { return nil }
            return point(at: CGPoint(x: accept.midX, y: accept.midY))
        }

        // These normalized boxes span the entire captured display and grow upward.
        // XCTest coordinates use points within the owner, which may be an inset
        // authentication sheet. Convert through display space before selecting it.
        @MainActor func point(at normalized: CGPoint) -> XCUICoordinate? {
            guard normalized.x >= 0, normalized.x <= 1, normalized.y >= 0, normalized.y <= 1 else { return nil }
            let target = CGPoint(x: display.minX + normalized.x * display.width,
                                 y: display.minY + (1 - normalized.y) * display.height)
            for owner in owners {
                let bounds = owner.frame
                guard !bounds.isEmpty, !bounds.isInfinite, bounds.contains(target) else { continue }
                return owner.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: target.x - bounds.minX, dy: target.y - bounds.minY))
            }
            return nil
        }
    }

    private enum RenderObservation: String { case systemConsent, consentTapped, browserVisible, frameRequested, frameWritten, requestWriteFailed, responseTimedOut, screenshotUnavailable, displayMismatch, noForegroundOwner, recognitionUnavailable, chromeMissing, landmarksMissing, ambiguousAction, outsideOwner, actionReady }
    private var renderObservations = Set<RenderObservation>()
    private func renderObserved(_ value: RenderObservation) {
        if renderObservations.insert(value).inserted { print("FARMER_RENDER " + value.rawValue) }
    }

    private struct ControlResponse: Decodable {
        struct Screen: Decodable {
            struct Row: Decodable {
                let text: String
                let box: [CGFloat]
            }
            let width: Int
            let height: Int
            let titleBottom: CGFloat?
            let rows: [Row]
        }
        let id: String
        let screen: Screen?
    }

    @MainActor private func renderedScreen() -> RenderedScreen? {
        guard let session = ProcessInfo.processInfo.environment["FARMER_OCR_SESSION"],
              let uuid = UUID(uuidString: session) else { return nil }
        guard let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            renderObserved(.requestWriteFailed); return nil
        }
        let directory = cache.appendingPathComponent("farmer-ocr-" + uuid.uuidString, isDirectory: true)
        let request = UUID().uuidString
        let frame = directory.appendingPathComponent(request + ".png")
        defer { try? FileManager.default.removeItem(at: frame) }
        // Capture through the XCTest session that owns the foreground browser.
        // The host recognizes this exact image and never starts a second display reader.
        renderObserved(.frameRequested)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        guard !png.isEmpty else { renderObserved(.screenshotUnavailable); return nil }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o700])
            try png.write(to: frame, options: .atomic)
            renderObserved(.frameWritten)
            try request.write(to: directory.appendingPathComponent("request"), atomically: true, encoding: .utf8)
            // xcodebuild output stays private on the Mac. The observer validates
            // this directory inside the booted device; published receipts exclude it.
            print("FARMER_PRIVATE_OCR_DIRECTORY " + directory.path)
        } catch { renderObserved(.requestWriteFailed); return nil }
        var screen: ControlResponse.Screen?
        let received = waitFor({
            guard let data = try? Data(contentsOf: directory.appendingPathComponent("response.json")),
                  let response = try? JSONDecoder().decode(ControlResponse.self, from: data),
                  response.id == request else { return false }
            screen = response.screen
            return true
        }, seconds: 45)
        guard received else { renderObserved(.responseTimedOut); return nil }
        guard let screen else { renderObserved(.recognitionUnavailable); return nil }
        // Cancellation does not receive credentials. Retain one verified
        // pre-input screen using the same pixels that produced its landmarks.
        let labels = Set(screen.rows.map { $0.text })
        if currentCheckpoint == .consent, !retainedCancelFrame,
           ProcessInfo.processInfo.environment["FARMER_ROLE"] == "cancel",
           labels.contains("systemConsentTitle") ||
            (screen.titleBottom != nil && labels.contains("Sign in to Onesa") && labels.contains("Cancel sign-in")),
           let base = ProcessInfo.processInfo.environment["FARMER_XCUI_EVIDENCE_DIR"] {
            let destination = URL(fileURLWithPath: base).appendingPathComponent("ios-cancel-live-consent.png")
            if (try? png.write(to: destination, options: .atomic)) != nil { retainedCancelFrame = true }
        }
        let owners = [app, authSheet, safari, springboard].filter { $0.state == .runningForeground }
        guard !owners.isEmpty else { renderObserved(.noForegroundOwner); return nil }
        let pixels = CGSize(width: screen.width, height: screen.height)
        guard let display = owners.map({ $0.frame }).first(where: { frame in
            guard frame.origin == .zero, !frame.isEmpty, !frame.isInfinite else { return false }
            let scale = (pixels.width / frame.width).rounded()
            return scale >= 1 && abs(pixels.width - scale * frame.width) <= 1 &&
                abs(pixels.height - scale * frame.height) <= 1
        }) else { renderObserved(.displayMismatch); return nil }
        let rows = screen.rows.compactMap { row -> (String, CGRect)? in
            let box = row.box
            guard box.count == 4, box.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }),
                  box[2] > 0, box[3] > 0, box[0] + box[2] <= 1.000001,
                  box[1] + box[3] <= 1.000001 else { return nil }
            return (row.text, CGRect(x: box[0], y: box[1], width: box[2], height: box[3]))
        }
        return RenderedScreen(rows: rows, display: display, owners: owners, titleBottom: screen.titleBottom)
    }

    // Embedded WebKit can render the issuer without publishing its DOM nodes
    // to XCTest. Recognized controls must belong to the verified visible page.
    @MainActor private func renderedAction(labels: Set<String>, landmarks: Set<String>,
                                          onPasswordSheet: ((XCUICoordinate) -> Void)? = nil) -> BrowserAction? {
        guard let screen = renderedScreen() else { return nil }
        if screen.words.contains("Save Password?"), screen.words.contains("Save") {
            if let decline = screen.unique("Not Now"),
               let point = screen.point(at: CGPoint(x: decline.midX, y: decline.midY)) {
                onPasswordSheet?(point)
            }
            return nil
        }
        guard let titleBottom = screen.titleBottom, titleBottom.isFinite,
              (0...1).contains(titleBottom) else { renderObserved(.chromeMissing); return nil }
        guard landmarks.isSubset(of: screen.words) else { renderObserved(.landmarksMissing); return nil }
        let targets = screen.rows.filter { labels.contains($0.text) && $0.box.maxY < titleBottom }
        guard targets.count == 1, let box = targets.first?.box else { renderObserved(.ambiguousAction); return nil }
        if landmarks == ["Smart Farmer"], !screen.rows.contains(where: {
            $0.text == "Smart Farmer" && $0.box.minY > box.maxY
        }) { renderObserved(.landmarksMissing); return nil }
        guard let point = screen.point(at: CGPoint(x: box.midX, y: box.midY)) else { renderObserved(.outsideOwner); return nil }
        renderObserved(.actionReady)
        return .point(point)
    }

    // The hosted ASWebAuthenticationSession can render the real form without
    // exposing its HTML inputs to XCTest. Portal nests every input inside its
    // visible HTML label. Tapping the label focuses that real input or toggles
    // the real checkbox. The synthetic credentials only enter the native keyboard.
    @MainActor private func renderedFormAction(_ label: String) -> BrowserAction? {
        // Each step has another form landmark in addition to the browser origin.
        let landmarks: Set<String> = label == "Authenticator or recovery code"
            ? ["Password", "Remember this browser"] : ["Email address", "Password"]
        return renderedAction(labels: [label], landmarks: landmarks)
    }

    @MainActor private func tapRenderedForm(_ label: String) throws {
        var action: BrowserAction?
        let ready = waitFor({
            action = self.renderedFormAction(label)
            return action != nil
        }, seconds: 15)
        try XCTUnwrap(ready ? action : nil, "Unique visible control in the loopback issuer form").tap()
    }

    @MainActor private func enterRendered(_ value: String, into label: String) throws {
        try tapRenderedForm(label)
        var acceptedTutorial = false
        let ready = waitFor({ self.keyboardReady(&acceptedTutorial) }, seconds: 10)
        try XCTUnwrap(ready ? true : nil, "System keyboard opened for the selected issuer input")
        let owner = try XCTUnwrap(browserOwners.first(where: { $0.keyboards.firstMatch.exists })
            ?? browserOwners.first(where: { $0.state == .runningForeground }),
            "System keyboard has an issuer owner")
        for character in value { owner.typeText(String(character)) }
        try dismissNativeKeyboard()
        // Check the exact email within its own field before typing a password.
        // Password and recovery values stay private. The real issuer validates
        // both and the external receipt check requires the exact role sequence.
        if label == "Email address" {
            let correct = waitFor({
                guard let screen = self.renderedScreen(), screen.hasLoopbackChrome,
                      let email = screen.unique("Email address"), let password = screen.unique("Password")
                else { return false }
                return screen.rows.contains { row in
                    row.text == "fixtureEmail" && row.box.midY < email.minY && row.box.midY > password.maxY
                }
            }, seconds: 8)
            try XCTUnwrap(correct ? true : nil, "Issuer email input received the synthetic account")
        }
    }

    @MainActor private func signInWithRenderedForm(email: String, password: String,
                                                   adminFactor: String?) throws {
        checkpoint(.email)
        try enterRendered(email, into: "Email address")
        checkpoint(.password)
        try enterRendered(password, into: "Password")
        checkpoint(.remember)
        try tapRenderedForm("Remember this browser")
        checkpoint(.firstSubmit)
        try tapRenderedForm("Continue")
        if let code = adminFactor {
            checkpoint(.mfa)
            try enterRendered(code, into: "Authenticator or recovery code")
            checkpoint(.secondSubmit)
            try tapRenderedForm("Continue")
        }
    }

    @MainActor private func returnLink(checkPasswordSheet: Bool = true) -> XCUIElement? {
        let names = NSPredicate(format: "label IN %@", ["Dzokera muSmart Farmer", "Buyela ku-Smart Farmer"])
        for owner in browserOwners + [springboard] {
            let notice = owner.staticTexts["Securely store your password so it’s filled automatically the next time you need it."].firstMatch
            let notNow = owner.buttons["Not Now"].firstMatch
            if checkPasswordSheet && app.state == .runningForeground && notice.exists && notNow.exists && notNow.isEnabled {
                let frame = notNow.frame
                // Apple's remote AutoFill alert can report a hittable button
                // with an invalid activation point. Use the exact identified
                // button's live, fully visible frame in the foreground app.
                if !frame.isEmpty && frame.intersection(app.frame) == frame && notice.frame.intersects(app.frame) {
                    let point = CGVector(dx: frame.midX - app.frame.minX, dy: frame.midY - app.frame.minY)
                    app.coordinate(withNormalizedOffset: .zero).withOffset(point).tap()
                    return nil
                }
            }
            // SafariViewService can expose the real callback link beneath a
            // secondary web view or directly in its embedded accessibility
            // hierarchy. Requiring the first web view to own it produced a
            // false-negative after the issuer had served the callback page.
            // Still require the exact localized link and an actual user tap.
            let link = owner.links.matching(names).firstMatch
            if link.exists && link.isHittable { return link }
        }
        return nil
    }

    @MainActor private func callbackAction(issuerOwner: XCUIApplication? = nil, checkPasswordSheet: Bool = true,
                                           onPasswordSheet: ((XCUICoordinate) -> Void)? = nil) -> BrowserAction? {
        if let link = returnLink(checkPasswordSheet: checkPasswordSheet) { return .element(link) }
        if let owner = issuerOwner {
            let names = NSPredicate(format: "label IN %@", ["Dzokera muSmart Farmer", "Buyela ku-Smart Farmer"])
            let links = owner.links.matching(names)
            if links.count == 1, links.firstMatch.isHittable { return .element(links.firstMatch) }
        }
        return renderedAction(labels: ["Dzokera muSmart Farmer", "Buyela ku-Smart Farmer"],
                              landmarks: ["Smart Farmer"], onPasswordSheet: checkPasswordSheet ? onPasswordSheet : nil)
    }

    @MainActor private func returnToFarmer(issuerOwner: XCUIApplication? = nil, afterCancellation: Bool = false) throws {
        checkpoint(.returnLink)
        var action: BrowserAction?
        var declinedPasswordSheet = false
        // The OCR observer permits two 20-second segmentation passes per
        // compositor frame. A 40-second return-link deadline therefore allows
        // only one worst-case frame and can fail although the real callback
        // page has already loaded. Permit a second observation, without
        // resubmitting credentials or fabricating the browser return link.
        let found = waitFor({
            action = self.callbackAction(issuerOwner: issuerOwner, checkPasswordSheet: !afterCancellation) { point in
                if !declinedPasswordSheet { declinedPasswordSheet = true; point.tap() }
            }
            return action != nil
        }, seconds: afterCancellation ? 100 : 85)
        try XCTUnwrap(found ? action : nil, "Real browser return link").tap()
    }

    @MainActor private func rememberedAccount(_ email: String) -> BrowserAction? {
        for owner in browserOwners {
            let button = owner.buttons["Continue as " + email].firstMatch
            if button.exists && button.isEnabled && button.isHittable { return .element(button) }
        }
        // The observer only emits this label for the full expected account button.
        return renderedAction(labels: ["rememberedAccount"], landmarks: ["Sign in to Onesa"])
    }

    @MainActor private func portalCancel() -> BrowserAction? {
        // The localized issuer is real WebKit UI, not a synthetic callback.
        // XCUITest may expose it under SafariViewService or the foreground app.
        // The embedded issuer's Cancel button is exposed by foreground Farmer.
        // Query it before a background Safari service whose snapshot can lag.
        let runningOwners = browserOwners
        let owners = runningOwners.filter { $0 === app } + runningOwners.filter { $0 !== app }
        for owner in owners {
            let ownerName: ControlOwner = owner === app ? .farmer : owner === safari ? .safari : .authSheet
            let name = "Cancel sign-in"
            let label = NSPredicate(format: "label == %@ OR identifier == %@", name, name)
            let candidates: [(XCUIElementQuery, PreInputControl)] = [
                (owner.buttons.matching(label), .cancelButton), (owner.links.matching(label), .cancelLink)
            ]
            for (query, kind) in candidates {
                let element = query.firstMatch
                guard controlReady(element, phase: .cancel, owner: ownerName, control: kind),
                      query.count == 1, element.isEnabled else { continue }
                // The remote WebKit button can be hittable while element.tap()
                // fails resolving its activation point. Tap its verified live
                // bounds through the foreground window, as for WebKit fields.
                let display = app.state == .runningForeground ? app : owner
                let frame = element.frame
                let bounds = display.frame
                guard display.state == .runningForeground, !frame.isEmpty,
                      !frame.isInfinite, bounds.contains(frame) else { continue }
                let offset = CGVector(dx: frame.midX - bounds.minX, dy: frame.midY - bounds.minY)
                renderObserved(.actionReady)
                return .point(display.coordinate(withNormalizedOffset: .zero).withOffset(offset))
            }
        }
        return nil
    }

    @MainActor func testCancelPortal() throws {
        continueAfterFailure = false
        checkpoint(.fixture)
        checkpoint(.signedOut)
        try startOnesaSignIn()
        checkpoint(.consent)
        var cancel: BrowserAction?
        let visible = awaitBrowser {
            cancel = self.portalCancel() ?? self.renderedAction(labels: ["Cancel sign-in"],
                                                                 landmarks: ["Sign in to Onesa", "Remember this browser"])
            return cancel != nil
        }
        try XCTUnwrap(visible ? cancel : nil, "Actual issuer offers cancel sign-in").tap()
        // A real denied issuer callback must return through the operating-system
        // browser link. Merely observing an HTTP 200 is not sufficient.
        try returnToFarmer(afterCancellation: true)
        let denied = NSPredicate(format: "label IN %@", [
            "Onesa haina kupa mvumo yekupinda muSmart Farmer.",
            "I-Onesa kayinikanga imvumo yokungena ku-Smart Farmer."
        ])
        let error = app.staticTexts.matching(denied).firstMatch
        let signIn = app.descendants(matching: .any)["auth-onesa"].firstMatch
        XCTAssertTrue(waitFor({
            self.app.state == .runningForeground && error.exists && signIn.exists && signIn.isEnabled
        }, seconds: 45), "Denied issuer callback restores signed-out Farmer with a visible error")
        XCTAssertFalse(app.descendants(matching: .any)["tab-forum"].firstMatch.exists,
                       "Cancelled sign-in must not create an authenticated farm session")
        checkpoint(.completed)
    }

    @MainActor func testColdPortal() throws {
        continueAfterFailure = false
        checkpoint(.fixture)
        let env = ProcessInfo.processInfo.environment
        let role = try XCTUnwrap(env["FARMER_ROLE"], "Known synthetic role")
        XCTAssertTrue(["member", "admin"].contains(role), "Known synthetic role")
        // App setup is part of this one XCTest session, before the timed
        // authorization request. No second UI driver may remain attached.
        checkpoint(.signedOut)
        try startOnesaSignIn()
        checkpoint(.consent)
        var surface: XCUIElement?
        let visible = awaitBrowser {
            surface = self.portalWeb() ?? self.embeddedIssuer()
            return surface != nil || self.renderedFormAction("Cancel sign-in") != nil
        }
        try XCTUnwrap(visible ? true : nil, "System browser owns the issuer form")
        let email = try XCTUnwrap(env["FARMER_EMAIL"], "Synthetic email exists")
        let password = try XCTUnwrap(env["FARMER_PASSWORD"], "Synthetic password exists")
        if let web = surface {
            checkpoint(.email)
            try enter(email, into: "Email address", in: web)
            try dismissNativeKeyboard()
            checkpoint(.password)
            try enter(password, into: "Password", in: web)
            try dismissNativeKeyboard()
            checkpoint(.remember)
            try remember(web)
            checkpoint(.firstSubmit)
            try submit(web)
            if role == "admin" {
                checkpoint(.mfa)
                let code = field("Authenticator or recovery code", in: web)
                try XCTUnwrap(code.waitForExistence(timeout: 20) ? true : nil, "Issuer requested an administrator factor")
                try enter(try XCTUnwrap(env["FARMER_MFA"], "Synthetic factor exists"),
                          into: "Authenticator or recovery code", in: web)
                try dismissNativeKeyboard()
                checkpoint(.secondSubmit)
                try submit(web)
            }
        } else {
            let code = role == "admin" ? try XCTUnwrap(env["FARMER_MFA"], "Synthetic factor exists") : nil
            try signInWithRenderedForm(email: email, password: password, adminFactor: code)
        }
        try returnToFarmer(issuerOwner: surface as? XCUIApplication)
        checkpoint(.nativeInvitation)
        let invitation = app.descendants(matching: .any)["first-farm-invitation"].firstMatch
        let invitationVisible = { self.app.state == .runningForeground && invitation.exists }
        if !waitFor(invitationVisible, seconds: 25) {
            // Only retry membership discovery in the signed-in, unjoined workspace.
            // Never replay sign-in, token exchange, or farm invitation acceptance.
            XCTAssertEqual(app.state, .runningForeground, "Callback did not return to Farmer")
            let workspace = app.descendants(matching: .any)["workspace-language"].firstMatch
            XCTAssertTrue(workspace.exists, "The signed-in workspace did not open")
            XCTAssertFalse(app.descendants(matching: .any)["tab-forum"].firstMatch.exists,
                           "The fixture already belongs to a farm")
            let sync = app.buttons["workspace-sync"].firstMatch
            XCTAssertTrue(waitFor({ invitationVisible() || (sync.exists && sync.isEnabled && sync.isHittable) }, seconds: 10),
                          "Membership loading did not finish or offer Sync")
            if !invitationVisible() { sync.tap() }
            XCTAssertTrue(waitFor(invitationVisible, seconds: 25),
                          "The first-farm invitation did not appear after membership discovery")
        }
        // Keep the XCTest session that observed the native callback. Starting
        // a second runner here used to lose the visible invitation mid-handoff.
        checkpoint(.joinFarm)
        let forum = app.descendants(matching: .any)["tab-forum"].firstMatch
        XCTAssertFalse(forum.exists, "Uninvited account has no workspace")
        invitation.tap()
        invitation.typeText(try XCTUnwrap(env["FARMER_INVITE"]))
        // The secure native keyboard covers the Join control. Use Farmer's
        // visible dismissal action before scrolling; a full-screen swipe can
        // otherwise start over the keyboard and never reach the ScrollView.
        if app.keyboards.firstMatch.exists {
            let dismiss = app.descendants(matching: .any)["keyboard-dismiss"].firstMatch
            try XCTUnwrap(waitFor({ dismiss.exists && dismiss.isHittable }, seconds: 10) ? dismiss : nil,
                          "Native invitation keyboard dismissal is available").tap()
            XCTAssertTrue(waitFor({ !self.app.keyboards.firstMatch.exists }, seconds: 10),
                          "Native invitation keyboard dismissed before joining")
        }
        let join = app.descendants(matching: .any)["first-farm-join"].firstMatch
        if !join.isHittable { app.scrollViews.firstMatch.swipeUp() }
        _ = try XCTUnwrap(waitFor({ join.exists && join.isEnabled && join.isHittable }) ? true : nil, "Invitation can be submitted")
        join.tap()
        checkpoint(.farmWorkspace)
        let farmName = try XCTUnwrap(env["FARMER_FARM"])
        let farm = app.staticTexts[farmName].firstMatch
        // A fresh administrator account joins while the initial encrypted
        // local farm workspace is still populating. Require the actual named
        // farm and actionable Forum control; do not replay invitation or grant.
        // Keep individual assertions so an absent farm is distinguishable from
        // a still-mounting tab on the slowest clean macOS simulator.
        XCTAssertTrue(waitFor({ farm.exists }, seconds: 90), "Joined farm becomes visible")
        XCTAssertTrue(waitFor({ forum.exists && forum.isHittable }, seconds: 45), "Forum becomes actionable")
        checkpoint(.forumTab)
        forum.tap()
        checkpoint(.forumScreen)
        let newDiscussion = app.descendants(matching: .any)["forum-new"].firstMatch
        XCTAssertTrue(newDiscussion.waitForExistence(timeout: 30), "Forum opened")
        try assertSeededDiscussion()
        checkpoint(.completed)
    }

    @MainActor private func assertSeededDiscussion() throws {
        checkpoint(.forumFeed)
        let title = try XCTUnwrap(ProcessInfo.processInfo.environment["FARMER_DISCUSSION"])
        let discussion = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "forum-open-", title)).firstMatch
        let scroll = app.scrollViews.firstMatch
        for _ in 0..<8 {
            if discussion.exists && discussion.isHittable { break }
            scroll.swipeUp()
        }
        XCTAssertTrue(discussion.exists && discussion.isHittable, "Seeded discussion is visible")
    }

    @MainActor func testActivePortal() throws {
        continueAfterFailure = false
        checkpoint(.fixture)
        let env = ProcessInfo.processInfo.environment
        let email = try XCTUnwrap(env["FARMER_EMAIL"])
        let farmName = try XCTUnwrap(env["FARMER_FARM"])
        try startOnesaSignIn(reauthenticate: true)
        checkpoint(.rememberedSession)
        var callback: BrowserAction?
        var account: BrowserAction?
        // A remembered browser may return immediately or ask which account to
        // continue as. Neither path enters credentials or joins a farm again.
        let ready = awaitBrowser(captureFailure: false) {
            callback = self.callbackAction()
            if callback == nil { account = self.rememberedAccount(email) }
            return callback != nil || account != nil
        }
        try XCTUnwrap(ready ? true : nil, "Issuer restored the existing browser session")
        if let callback {
            checkpoint(.returnLink)
            callback.tap()
        } else {
            try XCTUnwrap(account, "Issuer offers the same remembered account").tap()
            try returnToFarmer()
        }
        checkpoint(.forumScreen)
        let forum = app.descendants(matching: .any)["tab-forum"].firstMatch
        let composer = app.descendants(matching: .any)["forum-new"].firstMatch
        let farm = app.staticTexts[farmName].firstMatch
        XCTAssertTrue(waitFor({
            self.app.state == .runningForeground && forum.exists && forum.isSelected &&
                composer.exists && farm.exists
        }), "Same farm and previously selected Forum restored after reauthentication")
        try assertSeededDiscussion()
        checkpoint(.completed)
    }
    // Only used after the isolated iPad Maestro run captured and identified
    // Apple's exact Save Password? sheet. The system owns this overlay, so a
    // Maestro tap sent to Farmer cannot dismiss it. XCTest can target its owner.
    // Open Record in the same native session that dismisses the overlay.
    @MainActor func testDismissSystemPasswordSheet() throws {
        continueAfterFailure = false
        let record = app.descendants(matching: .any)["tab-record"].firstMatch
        for owner in [springboard, app] {
            let title = owner.staticTexts["Save Password?"].firstMatch
            let decline = owner.buttons["Not Now"].firstMatch
            if title.exists && decline.exists && decline.isEnabled && decline.isHittable {
                decline.tap()
                XCTAssertTrue(title.waitForNonExistence(timeout: 15),
                              "The observed Apple system password dialog must close")
                break
            }
        }
        // Starting a separate XCTest runner can itself put Farmer in the
        // background or dismiss the transient OS sheet. Restore only the
        // existing installed application, retaining its encrypted session.
        if app.state != .runningForeground { app.activate() }
        XCTAssertTrue(waitFor({
            self.app.state == .runningForeground && record.exists && record.isHittable
        }, seconds: 45), "Previously authenticated Farmer workspace must be usable")
        if !record.isSelected { record.tap() }
        // Maestro verifies the Record form after this native session.
        XCTAssertTrue(waitFor({
            record.isSelected
        }, seconds: 20), "Record must be selected after the system password dialog closes")
    }

}
