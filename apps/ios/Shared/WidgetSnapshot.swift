import Foundation

// What the widgets show, written by the app into the App Group container after it loads the inbox.
// The widgets read only this file: they never hold the API key or call Flow themselves.
struct WidgetSnapshot: Codable, Equatable {
    struct Item: Codable, Equatable, Identifiable {
        let id: String
        let title: String
        let detail: String
        let kind: Kind
        // flowapp://card?env=…&id=… or flowapp://inbox
        let link: String

        enum Kind: String, Codable {
            case agent, uat, doing, blocked, other
        }
    }

    var updated: Date
    var signedIn: Bool
    var agentsWaiting: Int
    var uat: Int
    var doing: Int
    var waiting: [Item]
    var inProgress: [Item]

    var waitingCount: Int { agentsWaiting + uat }

    static let empty = WidgetSnapshot(updated: .distantPast, signedIn: false, agentsWaiting: 0, uat: 0, doing: 0, waiting: [], inProgress: [])

    static let preview = WidgetSnapshot(updated: .now, signedIn: true, agentsWaiting: 1, uat: 2, doing: 3,
        waiting: [
            Item(id: "a", title: "Fix login is waiting", detail: "Run: npm test", kind: .agent, link: "flowapp://inbox"),
            Item(id: "b", title: "#12 Sign-up form", detail: "UAT · Lantern", kind: .uat, link: "flowapp://inbox"),
            Item(id: "c", title: "#14 Onboarding copy", detail: "UAT · Lantern", kind: .uat, link: "flowapp://inbox"),
        ],
        inProgress: [
            Item(id: "d", title: "#9 Board on iPad", detail: "Flow iOS", kind: .doing, link: "flowapp://inbox"),
            Item(id: "e", title: "#10 Push notifications", detail: "Flow iOS", kind: .doing, link: "flowapp://inbox"),
            Item(id: "f", title: "#11 Widgets", detail: "Flow iOS", kind: .doing, link: "flowapp://inbox"),
        ])
}

enum SharedStore {
    // Must match the App Group in Config/Flow.entitlements and Config/FlowWidgets.entitlements.
    static let appGroup = "group.com.flygonlc.flow"

    private static var file: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?.appendingPathComponent("widget-snapshot.json")
    }

    static func load() -> WidgetSnapshot {
        guard let file, let data = try? Data(contentsOf: file), let s = try? JSONDecoder().decode(WidgetSnapshot.self, from: data) else { return .empty }
        return s
    }

    static func save(_ snapshot: WidgetSnapshot) {
        guard let file, let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
