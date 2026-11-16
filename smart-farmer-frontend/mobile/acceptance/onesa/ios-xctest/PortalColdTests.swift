import XCTest
import UIKit
import Vision

final class PortalColdTests: XCTestCase {
    private enum Checkpoint: String {
        case fixture, signedOut, localLauncher, introduction, developerMenu, signInControl
        case consent, email, password, remember, firstSubmit
        case mfa, secondSubmit, returnLink, nativeInvitation, joinFarm
        case farmWorkspace, forumTab, forumScreen, forumFeed, completed
    }

    // Only these fixed names leave the runner. Never print a field, URL or assertion payload.
    private func checkpoint(_ value: Checkpoint) {
        print("FARMER_XCUI_CHECKPOINT " + value.rawValue)
    }

    private enum ControlPhase: String { case startup, cancel }
    private enum ControlOwner: String { case farmer, safari, authSheet }
    private enum PreInputControl: String {
        case signIn, introduction, developerMenu, localChooser, savedBundle, cancelButton, cancelLink
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

    // The iOS release flow needs one automation owner. Native test setup now
    // enters the prewarmed Expo app directly, without a Maestro XCTest session
    // that can outlive a browser handoff on the same disposable simulator.
    @MainActor private func startOnesaSignIn() throws {
        let bundle = "http://127.0.0.1:8081/index.bundle?platform=ios&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&unstable_transformProfile=hermes-stable"
        var link = URLComponents()
        link.scheme = "smartfarmer"
        link.host = "expo-development-client"
        link.path = "/"
        link.queryItems = [URLQueryItem(name: "url", value: bundle),
                           URLQueryItem(name: "__expo_disable_fab", value: "1"),
                           URLQueryItem(name: "disableFab", value: "1")]
        let localURL = try XCTUnwrap(link.url)
        // The launch argument is consumed on process startup. Give the test
        // runner ownership from startup so activating the app cannot replace it.
        app.launchArguments = ["--initialUrl", localURL.absoluteString]
        app.launch()
        let nodes = app.descendants(matching: .any)
        let start = nodes["auth-onesa"].firstMatch
        let intro = nodes.matching(NSPredicate(format: "label == %@", "Continue")).firstMatch
        let close = nodes.matching(NSPredicate(format: "label == %@", "Close")).firstMatch
        let chooser = nodes.matching(NSPredicate(format: "label == %@", "Enter URL manually")).firstMatch
        func ready(_ element: XCUIElement, _ control: PreInputControl) -> Bool {
            controlReady(element, phase: .startup, owner: .farmer, control: control)
        }
        _ = waitFor({ ready(start, .signIn) || ready(intro, .introduction) || ready(close, .developerMenu) || ready(chooser, .localChooser) }, seconds: 100)
        if !ready(start, .signIn) && ready(chooser, .localChooser) {
            checkpoint(.localLauncher)
            let savedBundle = nodes.matching(NSPredicate(format: "label == %@", bundle)).firstMatch
            if ready(savedBundle, .savedBundle) { savedBundle.tap() }
            if !waitFor({ ready(start, .signIn) || ready(intro, .introduction) || ready(close, .developerMenu) }, seconds: 12), ready(chooser, .localChooser) {
                // Repeat only before any authentication request and only while
                // the known local-development chooser remains on screen.
                app.terminate()
                app.launch()
            }
        }
        _ = waitFor({ ready(start, .signIn) || ready(intro, .introduction) || ready(close, .developerMenu) }, seconds: 30)
        // Expo's sheet can leave the sign-in button visible and hittable above
        // it. Dismiss onboarding before using that underlying control; its
        // first tap can otherwise dismiss the sheet without starting sign-in.
        if ready(intro, .introduction) {
            checkpoint(.introduction)
            intro.tap()
            _ = waitFor({ ready(start, .signIn) || ready(close, .developerMenu) }, seconds: 45)
        }
        if ready(close, .developerMenu) {
            checkpoint(.developerMenu)
            close.tap()
        }
        // The launcher can briefly expose the underlying control during dismissal.
        let unlocked = waitFor({
            !(close.exists && close.isHittable) && !(intro.exists && intro.isHittable) && ready(start, .signIn) && start.isEnabled
        }, seconds: 45)
        let button = try XCTUnwrap(unlocked ? start : nil, "Installed Farmer reached its signed-out Onesa control")
        checkpoint(.signInControl)
        button.tap()

        func stillOnIdleForm() -> Bool {
            guard app.state == .runningForeground, start.exists, start.isEnabled, start.isHittable,
                  nodes["auth-username"].firstMatch.exists, nodes["auth-password"].firstMatch.exists,
                  !(intro.exists && intro.isHittable), !(close.exists && close.isHittable),
                  !(chooser.exists && chooser.isHittable), !app.alerts.firstMatch.exists,
                  !springboard.alerts.firstMatch.exists else { return false }
            return !browserOwners.contains { $0.webViews.firstMatch.exists }
        }
        // The React press handler immediately disables this button. An enabled,
        // unobscured local form after the observation window means the initial
        // Expo overlay consumed the gesture. Do not re-launch or repeat a flow
        // that has moved to a browser, a disabled control, or an error alert.
        if !waitFor({ !stillOnIdleForm() }, seconds: 6), stillOnIdleForm() {
            start.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
    }

    @MainActor private func browserConsent() -> XCUIElement? {
        // ASWebAuthenticationSession's confirmation can be exposed as more
        // than one alert node. Inspect every alert and combine its accessible
        // text instead of requiring host and purpose to share one label.
        // Before consent, SafariViewService and Safari may not have launched.
        // Querying a stopped application's alerts aborts XCTest before the
        // SpringBoard fallback can inspect the visible OS confirmation.
        for owner in [springboard] + browserOwners {
            for alert in owner.alerts.allElementsBoundByIndex {
                let labels = [alert.label, (alert.value as? String) ?? ""] +
                    alert.staticTexts.allElementsBoundByIndex.map { $0.label }
                let text = labels.joined(separator: " ").lowercased()
                guard (text.contains("localhost") || text.contains("127.0.0.1")),
                      text.contains("sign in") else { continue }
                let button = alert.buttons.matching(NSPredicate(format: "label == %@", "Continue")).firstMatch
                if button.exists && button.isHittable { return button }
            }
        }
        // Some iOS simulator releases surface the same host confirmation in
        // SpringBoard's accessibility tree rather than its alerts collection.
        // Keep this fallback confined to SpringBoard and require both the
        // loopback host and sign-in purpose before tapping its Continue button.
        let host = springboard.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "localhost", "127.0.0.1")
        ).firstMatch
        let purpose = springboard.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS[c] %@", "sign in")
        ).firstMatch
        let continueButton = springboard.buttons.matching(NSPredicate(format: "label == %@", "Continue")).firstMatch
        if host.exists && purpose.exists && continueButton.exists && continueButton.isHittable {
            return continueButton
        }
        return nil
    }

    @MainActor private func captureConsentFailure() {
        guard let directory = ProcessInfo.processInfo.environment["FARMER_XCUI_EVIDENCE_DIR"] else { return }
        guard let data = XCUIScreen.main.screenshot().image.pngData() else { return }
        let destination = URL(fileURLWithPath: directory).appendingPathComponent("ios-consent-unresolved.png")
        try? data.write(to: destination, options: .atomic)
    }

    @MainActor private func awaitBrowser(_ ready: @escaping () -> Bool) -> Bool {
        var consent: XCUIElement?
        let presented = {
            consent = self.browserConsent()
            return consent != nil || ready()
        }
        // A WebKit/XCTest snapshot can finish after the deadline. Recheck the
        // live alert once before failing. Rendering Portal gets its own wait
        // after the OS prompt has actually been accepted.
        guard waitFor(presented) || presented() else {
            // This checkpoint occurs before any fixture credentials are entered;
            // retain the simulator's actual blocking prompt for diagnosis.
            captureConsentFailure()
            return false
        }
        guard let consent else { return true }
        consent.tap()
        if !consent.waitForNonExistence(timeout: 5), let stillPresented = browserConsent() {
            // The first tap can coincide with presentation. Retry only the
            // same local sign-in alert, without repeating the app's request.
            stillPresented.tap()
        }
        // A slow remote AX snapshot can cross the deadline before WebKit's
        // current controls are returned. Refresh the same predicate once; this
        // neither repeats sign-in nor changes the required native gesture.
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

    @MainActor private func enter(_ value: String, into label: String, in web: XCUIElement) throws {
        var acceptedTutorial = false
        @MainActor func keyboardReady() -> Bool {
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
        if !waitFor(keyboardReady, seconds: 6), input.exists && input.isEnabled && input.isHittable {
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
        let ready = waitFor(keyboardReady, seconds: 10)

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
            for surface in browserOwners {
                let done = surface.buttons["Done"].firstMatch
                if done.exists && done.isHittable { doneTyping = done; return true }
            }
            return false
        }, seconds: 10), "Native browser Done control")
        try XCTUnwrap(doneTyping).tap()
        XCTAssertTrue(waitFor({
            self.browserOwners.allSatisfy { !$0.keyboards.firstMatch.exists }
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

    // Embedded WebKit can render the issuer while exposing none of its DOM
    // controls to XCTest. Locate only a known action on its visible loopback
    // page. The image and OCR stay in memory, including after sign-in.
    @MainActor private func renderedAction(labels: Set<String>, landmarks: Set<String>,
                                          onPasswordSheet: ((XCUICoordinate) -> Void)? = nil) -> BrowserAction? {
        guard let foreground = [app, authSheet, safari].first(where: { $0.state == .runningForeground }),
              let image = XCUIScreen.main.screenshot().image.cgImage else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        guard (try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])) != nil else { return nil }
        let rows = (request.results ?? []).compactMap { observation -> (String, CGRect)? in
            guard let best = observation.topCandidates(1).first, best.confidence >= 0.55 else { return nil }
            let label = best.string.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "‑", with: "-").replacingOccurrences(of: "–", with: "-")
            return (label, observation.boundingBox)
        }
        let frame = foreground.frame
        let aspect = CGFloat(image.width) / CGFloat(image.height)
        guard frame.minX == 0, frame.minY == 0, frame.height > 0,
              abs(frame.width / frame.height - aspect) < 0.02 else { return nil }
        func point(for rect: CGRect) -> XCUICoordinate {
            foreground.coordinate(withNormalizedOffset: CGVector(dx: rect.midX, dy: 1 - rect.midY))
        }
        let words = Set(rows.map { $0.0 })
        // Apple's sheet can cover the return link without exposing any AX
        // controls. Decline only the uniquely identified password prompt.
        if words.contains("Save Password?"), words.contains("Save") {
            let declines = rows.filter { $0.0 == "Not Now" }
            if declines.count == 1 { onPasswordSheet?(point(for: declines[0].1)) }
            return nil
        }
        // Browser chrome identifies the issuer/callback origin. These are the
        // hostnames in the disposable HTTPS device fixture.
        guard rows.contains(where: { ["localhost", "127.0.0.1"].contains($0.0) && $0.1.midY > 0.82 }),
              landmarks.isSubset(of: words) else { return nil }
        let matches = rows.filter { labels.contains($0.0) && $0.1.midY < 0.88 }
        guard matches.count == 1 else { return nil }
        return .point(point(for: matches[0].1))
    }

    @MainActor private func returnLink() -> XCUIElement? {
        let names = NSPredicate(format: "label IN %@", ["Dzokera muSmart Farmer", "Buyela ku-Smart Farmer"])
        for owner in browserOwners + [springboard] {
            let notice = owner.staticTexts["Securely store your password so it’s filled automatically the next time you need it."].firstMatch
            let notNow = owner.buttons["Not Now"].firstMatch
            if app.state == .runningForeground && notice.exists && notNow.exists && notNow.isEnabled {
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

    @MainActor private func returnToFarmer(issuerOwner: XCUIApplication? = nil) throws {
        checkpoint(.returnLink)
        var action: BrowserAction?
        var declinedPasswordSheet = false
        let found = waitFor({
            if let link = self.returnLink() {
                action = .element(link)
            } else if let owner = issuerOwner {
                let names = NSPredicate(format: "label IN %@", ["Dzokera muSmart Farmer", "Buyela ku-Smart Farmer"])
                let links = owner.links.matching(names)
                if links.count == 1, links.firstMatch.isHittable { action = .element(links.firstMatch) }
            }
            if action == nil {
                action = self.renderedAction(labels: ["Dzokera muSmart Farmer", "Buyela ku-Smart Farmer"],
                                             landmarks: ["Smart Farmer"]) { point in
                    if !declinedPasswordSheet { declinedPasswordSheet = true; point.tap() }
                }
            }
            return action != nil
        }, seconds: 40)
        try XCTUnwrap(found ? action : nil, "Real browser return link").tap()
    }

    @MainActor private func portalCancel() -> XCUIElement? {
        // The localized issuer is real WebKit UI, not a synthetic callback.
        // XCUITest may expose it under SafariViewService or the foreground app.
        // The embedded issuer's Cancel button is exposed by foreground Farmer.
        // Query it before a background Safari service whose snapshot can lag.
        let runningOwners = browserOwners
        let owners = runningOwners.filter { $0 === app } + runningOwners.filter { $0 !== app }
        for owner in owners {
            let ownerName: ControlOwner = owner === app ? .farmer : owner === safari ? .safari : .authSheet
            let button = owner.buttons["Cancel sign-in"].firstMatch
            if controlReady(button, phase: .cancel, owner: ownerName, control: .cancelButton) { return button }
            let link = owner.links["Cancel sign-in"].firstMatch
            if controlReady(link, phase: .cancel, owner: ownerName, control: .cancelLink) { return link }
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
            if let button = self.portalCancel() {
                cancel = .element(button)
            } else {
                cancel = self.renderedAction(labels: ["Cancel sign-in"],
                                              landmarks: ["Sign in to Onesa", "Remember this browser"])
            }
            return cancel != nil
        }
        try XCTUnwrap(visible ? cancel : nil, "Actual issuer offers cancel sign-in").tap()
        // A real denied issuer callback must return through the operating-system
        // browser link. Merely observing an HTTP 200 is not sufficient.
        try returnToFarmer()
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
            return surface != nil
        }
        let web = try XCTUnwrap(visible ? surface : nil, "System browser owns the issuer form")
        let email = try XCTUnwrap(env["FARMER_EMAIL"], "Synthetic email exists")
        let password = try XCTUnwrap(env["FARMER_PASSWORD"], "Synthetic password exists")
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
        try returnToFarmer(issuerOwner: web as? XCUIApplication)
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
        XCTAssertTrue(waitFor({ farm.exists && forum.exists && forum.isHittable }), "Farm and forum available")
        checkpoint(.forumTab)
        forum.tap()
        checkpoint(.forumScreen)
        let newDiscussion = app.descendants(matching: .any)["forum-new"].firstMatch
        XCTAssertTrue(newDiscussion.waitForExistence(timeout: 30), "Forum opened")
        checkpoint(.forumFeed)
        let title = try XCTUnwrap(env["FARMER_DISCUSSION"])
        let discussion = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "forum-open-", title)).firstMatch
        let scroll = app.scrollViews.firstMatch
        for _ in 0..<8 {
            if discussion.exists && discussion.isHittable { break }
            scroll.swipeUp()
        }
        XCTAssertTrue(discussion.exists && discussion.isHittable, "Seeded discussion is visible")
        checkpoint(.completed)
    }
}
