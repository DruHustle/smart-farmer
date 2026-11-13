import XCTest

final class PortalColdTests: XCTestCase {
    private enum Checkpoint: String {
        case fixture, signedOut, consent, email, password, remember, firstSubmit
        case mfa, secondSubmit, returnLink, nativeInvitation, completed
    }

    // Only these fixed names leave the runner. Never print a field, URL or assertion payload.
    private func checkpoint(_ value: Checkpoint) {
        print("FARMER_XCUI_CHECKPOINT " + value.rawValue)
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

    @MainActor private func browserConsent() -> XCUIElement? {
        let title = NSPredicate(format: "label CONTAINS[c] %@ AND label CONTAINS[c] %@", "localhost", "sign in")
        for owner in [springboard, app] {
            let alert = owner.alerts.firstMatch
            guard alert.exists, title.evaluate(with: alert) || alert.staticTexts.matching(title).firstMatch.exists else { continue }
            let button = alert.buttons["Continue"].firstMatch
            if button.exists && button.isHittable { return button }
        }
        return nil
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
        guard waitFor(presented) || presented() else { return false }
        guard let consent else { return true }
        consent.tap()
        if !consent.waitForNonExistence(timeout: 5), let stillPresented = browserConsent() {
            // The first tap can coincide with presentation. Retry only the
            // same local sign-in alert, without repeating the app's request.
            stillPresented.tap()
        }
        return waitFor(ready)
    }

    @MainActor private func field(_ label: String, in web: XCUIElement) -> XCUIElement {
        let fields = label == "Password" ? web.secureTextFields : web.textFields
        // Only the admin whole-owner fallback passes an application here.
        if web is XCUIApplication {
            return fields.matching(NSPredicate(format: "label == %@", label)).firstMatch
        }
        let named = fields[label]
        return named.exists ? named : fields.matching(NSPredicate(format: "label CONTAINS[c] %@", label)).firstMatch
    }

    @MainActor private func enter(_ value: String, into label: String, in web: XCUIElement) throws {
        var acceptedTutorial = false
        @MainActor func keyboardReady() -> Bool {
            let owners = [authSheet, safari, app, springboard].filter { $0.state == .runningForeground }
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
        let editable = waitFor({ input.exists && input.isEnabled && input.isHittable }, seconds: 15)
        try XCTUnwrap(editable ? input : nil, "Browser input is editable").tap()
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
        try XCTUnwrap(ready ? typingTarget : nil, "Browser keyboard is ready for input").typeText(value)
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
            for surface in [app, authSheet, safari] where surface.state == .runningForeground {
                let done = surface.buttons["Done"].firstMatch
                if done.exists && done.isHittable { doneTyping = done; return true }
            }
            return false
        }, seconds: 10), "Native browser Done control")
        try XCTUnwrap(doneTyping).tap()
        XCTAssertTrue(waitFor({
            [app, authSheet, safari].filter { $0.state == .runningForeground }.allSatisfy { !$0.keyboards.firstMatch.exists }
        }, seconds: 10), "Native keyboard dismissed before form action")
    }

    @MainActor private func portalWeb() -> XCUIElement? {
        for owner in [authSheet, safari] where owner.state == .runningForeground {
            let web = owner.webViews.firstMatch
            let email = field("Email address", in: web)
            if web.exists && email.exists && email.isEnabled && email.isHittable { return web }
        }
        return nil
    }

    // Maestro reads the complete iOS 26 SafariViewService snapshot. The
    // separate service can be backgrounded while its sheet is on screen.
    // Scope this fallback to one real issuer form in the system browser.
    @MainActor private func adminIssuerOwner() -> XCUIApplication? {
        guard [.runningForeground, .runningBackground].contains(authSheet.state),
              authSheet.webViews.count > 0, let snapshot = try? authSheet.snapshot() else { return nil }
        var heading = false
        var email = 0
        var password = 0
        func inspect(_ node: XCUIElementSnapshot) {
            if node.label == "Sign in to Onesa" { heading = true }
            if node.isEnabled && node.elementType == .textField && node.label == "Email address" { email += 1 }
            if node.isEnabled && node.elementType == .secureTextField && node.label == "Password" { password += 1 }
            for child in node.children { inspect(child) }
        }
        inspect(snapshot)
        guard heading, email == 1, password == 1 else { return nil }
        let target = field("Email address", in: authSheet)
        guard target.exists, target.isEnabled, target.isHittable else { return nil }
        return authSheet
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

    @MainActor private func returnLink() -> XCUIElement? {
        let names = NSPredicate(format: "label IN %@", ["Dzokera muSmart Farmer", "Buyela ku-Smart Farmer"])
        for owner in [authSheet, safari, app, springboard] where owner.state == .runningForeground {
            let notice = owner.staticTexts["Securely store your password so it’s filled automatically the next time you need it."].firstMatch
            let notNow = owner.buttons["Not Now"].firstMatch
            if notice.exists && notNow.exists && notNow.isHittable { notNow.tap(); return nil }
            let link = owner.webViews.firstMatch.links.matching(names).firstMatch
            if link.exists && link.isHittable { return link }
        }
        return nil
    }

    @MainActor private func returnToFarmer(adminOwner: XCUIApplication? = nil) throws {
        checkpoint(.returnLink)
        var link: XCUIElement?
        let found = waitFor({
            link = self.returnLink()
            if link == nil, let owner = adminOwner {
                let names = NSPredicate(format: "label IN %@", ["Dzokera muSmart Farmer", "Buyela ku-Smart Farmer"])
                let links = owner.links.matching(names)
                if links.count == 1, links.firstMatch.isHittable { link = links.firstMatch }
            }
            return link != nil
        }, seconds: 40)
        try XCTUnwrap(found ? link : nil, "Real browser return link").tap()
    }

    @MainActor func testColdPortal() throws {
        continueAfterFailure = false
        checkpoint(.fixture)
        let env = ProcessInfo.processInfo.environment
        let role = try XCTUnwrap(env["FARMER_ROLE"], "Known synthetic role")
        XCTAssertTrue(["member", "admin"].contains(role), "Known synthetic role")
        // Maestro has already navigated the installed Farmer to the signed-out screen.
        // Activating the existing app here does not start the timed request or open a URL.
        checkpoint(.signedOut)
        app.activate()
        let start = app.descendants(matching: .any)["auth-onesa"].firstMatch
        let startReady = waitFor({ start.exists && start.isHittable && start.isEnabled }, seconds: 30)
        try XCTUnwrap(startReady ? start : nil, "Signed-out Farmer sign-in control").tap()
        checkpoint(.consent)
        let web: XCUIElement
        if role == "admin" {
            var surface: XCUIElement?
            let visible = awaitBrowser {
                surface = self.portalWeb() ?? self.adminIssuerOwner()
                return surface != nil
            }
            web = try XCTUnwrap(visible ? surface : nil, "Real browser owns administrator issuer form")
        } else {
            try XCTUnwrap(awaitBrowser { self.portalWeb() != nil } ? true : nil, "Issuer page in system browser")
            web = try XCTUnwrap(portalWeb(), "Real browser owns issuer form")
        }
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
        try returnToFarmer(adminOwner: web as? XCUIApplication)
        checkpoint(.nativeInvitation)
        let invitation = app.descendants(matching: .any)["first-farm-invitation"].firstMatch
        try XCTUnwrap(waitFor({ self.app.state == .runningForeground && invitation.exists }, seconds: 40) ? true : nil,
                      "Native callback opened the expected unaffiliated account")
        checkpoint(.completed)
    }
}
