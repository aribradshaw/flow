import SwiftUI
import WidgetKit

// Home and lock screen widgets, in Flow's look (the app's Theme, repeated here because the widget is its
// own target). They read the snapshot the app writes (Shared/WidgetSnapshot.swift) and never talk to Flow
// themselves. Tapping one opens the app (flowapp:// links).

@main
struct FlowWidgetBundle: WidgetBundle {
    var body: some Widget {
        AgentsWidget()
        WaitingWidget()
        DoingWidget()
    }
}

// MARK: Palette (Views/Theme.swift)

private enum W {
    static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light) })
    }
    static let bg = dyn(0xf6f7f6, 0x151719)
    static let surface = dyn(0xffffff, 0x222529)
    static let line = dyn(0xe3e7e5, 0x3a3f45)
    static let ink = dyn(0x1d2725, 0xf1f3f4)
    static let muted = dyn(0x66726e, 0xbbc1c7)
    static let faint = dyn(0x98a39f, 0x8a9198)
    static let accent = dyn(0x324b34, 0xb7d9ae)
    static let green = Color(UIColor(rgb: 0x7cb980))
    static let brick = Color(UIColor(rgb: 0xa8524c))
    static let warn = dyn(0xc27a1a, 0xe0a552)

    static func vendor(_ v: String) -> Color {
        switch v {
        case "claude": Color(UIColor(rgb: 0xd97757))
        case "codex": Color(UIColor(rgb: 0x2b2f33))
        case "gemini": Color(UIColor(rgb: 0x4b7be5))
        default: Color(UIColor(rgb: 0x324b34))
        }
    }

    static func mark(_ v: String) -> String {
        switch v {
        case "claude": "asterisk"
        case "codex": "chevron.left.forwardslash.chevron.right"
        case "gemini": "sparkle"
        default: "cpu"
        }
    }
}

private extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
    }
}

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry { SnapshotEntry(date: .now, snapshot: .preview) }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: .now, snapshot: context.isPreview ? .preview : SharedStore.load()))
    }

    // The app reloads the timelines when its snapshot changes; this is only a fallback.
    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        completion(Timeline(entries: [SnapshotEntry(date: .now, snapshot: SharedStore.load())], policy: .after(.now.addingTimeInterval(15 * 60))))
    }
}

// MARK: Shared pieces

private struct Header: View {
    let title: String
    let count: Int
    let tint: Color

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image("WidgetMark").resizable().frame(width: 14, height: 14).clipShape(RoundedRectangle(cornerRadius: 3))
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(W.muted).lineLimit(1)
            Spacer(minLength: 0)
            Text("\(count)").font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(count > 0 ? tint : W.faint)
        }
    }
}

private struct Footer: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        if snapshot.signedIn, snapshot.updated > .distantPast {
            Text(snapshot.updated, style: .relative).font(.system(size: 10)).foregroundStyle(W.faint)
        }
    }
}

private struct SignedOut: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Spacer()
            Text("Open Flow to sign in").font(.caption).foregroundStyle(W.muted)
        }
    }
}

private struct Dot: View {
    let state: String
    var body: some View {
        Circle().fill(state == "waiting" ? W.brick : state == "running" ? W.green : W.faint).frame(width: 7, height: 7)
    }
}

// MARK: Agents

struct AgentsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FlowAgents", provider: SnapshotProvider()) { entry in
            AgentsView(snapshot: entry.snapshot)
                .containerBackground(W.bg, for: .widget)
                .widgetURL(URL(string: "flowapp://agents"))
        }
        .configurationDisplayName("Agents")
        .description("What your agents are doing, and who's waiting on you.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular])
    }
}

struct AgentsView: View {
    @Environment(\.widgetFamily) private var family
    let snapshot: WidgetSnapshot

    var body: some View {
        let agents = snapshot.live ?? []
        let working = snapshot.liveWorking ?? 0, waiting = snapshot.liveWaiting ?? 0
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: "sparkles").font(.caption2)
                    Text("\(working + waiting)").font(.title3.bold())
                }
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Label("\(working) working · \(waiting) waiting", systemImage: "sparkles").font(.caption.weight(.semibold))
                Text(agents.first.map { "\($0.name): \($0.doing)" } ?? "No agents running").font(.caption2).lineLimit(2)
            }
        case .systemSmall:
            VStack(alignment: .leading, spacing: 8) {
                Header(title: "Agents", count: working + waiting, tint: W.accent)
                if !snapshot.signedIn { SignedOut() } else {
                    HStack(spacing: 10) {
                        stat(working, "working", W.green)
                        stat(waiting, "waiting", W.brick)
                    }
                    Spacer(minLength: 0)
                    if let a = agents.first {
                        Text(a.doing.isEmpty ? a.name : a.doing).font(.caption2).foregroundStyle(W.muted).lineLimit(2)
                    } else {
                        Text("No agents running").font(.caption2).foregroundStyle(W.faint)
                    }
                }
            }
        default:
            VStack(alignment: .leading, spacing: 8) {
                Header(title: "Agents", count: working + waiting, tint: W.accent)
                if !snapshot.signedIn { SignedOut() } else if agents.isEmpty {
                    Spacer()
                    Text("No agents running").font(.caption).foregroundStyle(W.faint)
                    Spacer()
                } else {
                    ForEach(agents.prefix(family == .systemLarge ? 6 : 3)) { a in
                        HStack(spacing: 8) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 5).fill(W.vendor(a.vendor)).frame(width: 22, height: 22)
                                Image(systemName: W.mark(a.vendor)).font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                            }
                            VStack(alignment: .leading, spacing: 0) {
                                Text(a.name).font(.caption.weight(.semibold)).foregroundStyle(W.ink).lineLimit(1)
                                Text(a.state == "waiting" ? "Needs you · \(a.doing)" : a.doing.isEmpty ? (a.state == "running" ? "Working" : "Idle") : a.doing)
                                    .font(.caption2).foregroundStyle(a.state == "waiting" ? W.brick : W.muted).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            Dot(state: a.state)
                        }
                    }
                    Spacer(minLength: 0)
                }
                Footer(snapshot: snapshot)
            }
        }
    }

    private func stat(_ n: Int, _ label: String, _ c: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(n)").font(.title2.weight(.semibold).monospacedDigit()).foregroundStyle(n > 0 ? c : W.faint)
            Text(label).font(.caption2).foregroundStyle(W.muted)
        }
    }
}

// MARK: Waiting on you

struct WaitingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FlowWaiting", provider: SnapshotProvider()) { entry in
            WaitingView(snapshot: entry.snapshot)
                .containerBackground(W.bg, for: .widget)
                .widgetURL(URL(string: "flowapp://inbox"))
        }
        .configurationDisplayName("Waiting on you")
        .description("Agents waiting on you and cards ready for you to test.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct WaitingView: View {
    @Environment(\.widgetFamily) private var family
    let snapshot: WidgetSnapshot

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: "tray").font(.caption)
                    Text("\(snapshot.waitingCount)").font(.title3.bold())
                }
            }
        case .accessoryInline:
            Label(snapshot.signedIn ? "\(snapshot.waitingCount) waiting on you" : "Flow", systemImage: "tray")
        case .accessoryRectangular:
            VStack(alignment: .leading) {
                Label("\(snapshot.waitingCount) waiting", systemImage: "tray").font(.headline)
                Text(snapshot.waiting.first?.title ?? "Nothing waiting").lineLimit(2)
            }
        default:
            ItemList(title: "Waiting on you", count: snapshot.waitingCount, items: snapshot.waiting, snapshot: snapshot,
                     empty: "Nothing waiting on you", tint: W.brick)
        }
    }
}

// MARK: Doing

struct DoingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FlowDoing", provider: SnapshotProvider()) { entry in
            ItemList(title: "Doing", count: entry.snapshot.doing, items: entry.snapshot.inProgress, snapshot: entry.snapshot,
                     empty: "Nothing in progress", tint: W.accent)
                .containerBackground(W.bg, for: .widget)
                .widgetURL(URL(string: "flowapp://inbox"))
        }
        .configurationDisplayName("Doing")
        .description("Your cards in progress.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct ItemList: View {
    @Environment(\.widgetFamily) private var family
    let title: String
    let count: Int
    let items: [WidgetSnapshot.Item]
    let snapshot: WidgetSnapshot
    let empty: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Header(title: title, count: count, tint: tint)
            if !snapshot.signedIn { SignedOut() } else if items.isEmpty {
                Spacer()
                Text(empty).font(.caption).foregroundStyle(W.faint)
                Spacer()
            } else {
                ForEach(items.prefix(family == .systemSmall ? 2 : 3)) { item in
                    Link(destination: URL(string: item.link) ?? URL(string: "flowapp://inbox")!) {
                        HStack(alignment: .top, spacing: 6) {
                            RoundedRectangle(cornerRadius: 1.5).fill(item.kind == .agent ? W.brick : item.kind == .uat ? W.warn : W.accent)
                                .frame(width: 3, height: family == .systemSmall ? 14 : 26)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.title).font(.caption.weight(.semibold)).foregroundStyle(W.ink).lineLimit(1)
                                if family != .systemSmall, !item.detail.isEmpty {
                                    Text(item.detail).font(.caption2).foregroundStyle(W.muted).lineLimit(1)
                                }
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            Footer(snapshot: snapshot)
        }
    }
}

#Preview("Agents", as: .systemMedium) {
    AgentsWidget()
} timeline: {
    SnapshotEntry(date: .now, snapshot: .preview)
}
