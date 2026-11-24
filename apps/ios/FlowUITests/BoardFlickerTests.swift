import XCTest

// Drives the board the way a person does, slowly, so a screen recording shows any jump or flicker:
// switch columns from the strip, swipe between columns, open a card and come back, leave the tab and
// return. Run against a local Flow server (FLOW_TEST_SERVER, default http://localhost:4391) in local mode.
final class BoardFlickerTests: XCTestCase {
    func testBoardInteractions() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-server", ProcessInfo.processInfo.environment["FLOW_TEST_SERVER"] ?? "http://localhost:4391",
                               "-autoSignIn", "YES", "-startTab", "board"]
        app.launch()
        let pause = { (s: Double) in Thread.sleep(forTimeInterval: s) }
        pause(3)

        // The column strip.
        for name in ["UAT", "Blocked", "Requests", "Doing"] {
            let chip = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            if chip.waitForExistence(timeout: 3) { chip.tap(); pause(1.2) }
        }
        // Quick taps through every column, back and forth.
        for name in ["Requests", "Doing", "Blocked", "UAT", "Done", "Blocked", "Doing"] {
            let chip = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
            if chip.waitForExistence(timeout: 3) { chip.tap(); pause(0.6) }
        }
        // Scrolling the list.
        app.swipeUp(); pause(0.8); app.swipeDown(); pause(0.8)
        // A card, then back.
        let card = app.staticTexts["Board view on iPad"].firstMatch
        if card.waitForExistence(timeout: 3) {
            card.tap(); pause(2)
            app.navigationBars.buttons.element(boundBy: 0).tap(); pause(2)
        }
        // Away to another tab and back.
        app.tabBars.buttons["Inbox"].tap(); pause(1.5)
        app.tabBars.buttons["Board"].tap(); pause(2)
        app.tabBars.buttons["Map"].tap(); pause(1.5)
        app.tabBars.buttons["Board"].tap(); pause(2)
    }
}
