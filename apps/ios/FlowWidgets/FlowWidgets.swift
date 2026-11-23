import SwiftUI
import WidgetKit

// Home and lock screen widgets. They read the snapshot the app writes (Shared/WidgetSnapshot.swift)
// and never talk to Flow themselves. Tapping one opens the app (flowapp:// links).

@main
struct FlowWidgetBundle: WidgetBundle {
    var body: some Widget {
        WaitingWidget()
        DoingWidget()
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
        completion(Timeline(entries: [SnapshotEntry(date: .now, snapshot: SharedStore.load())], policy: .after(.now.addingTimeInterval(30 * 60))))
    }
}

// MARK: Waiting on you

struct WaitingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FlowWaiting", provider: SnapshotProvider()) { entry in
            WaitingView(snapshot: entry.snapshot)
                .containerBackground(.fill.tertiary, for: .widget)
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
            ListView(title: "Waiting on you", count: snapshot.waitingCount, items: snapshot.waiting, snapshot: snapshot,
                     empty: "Nothing waiting on you", tint: .orange)
        }
    }
}

// MARK: Doing

struct DoingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FlowDoing", provider: SnapshotProvider()) { entry in
            ListView(title: "Doing", count: entry.snapshot.doing, items: entry.snapshot.inProgress, snapshot: entry.snapshot,
                     empty: "Nothing in progress", tint: .green)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(URL(string: "flowapp://inbox"))
        }
        .configurationDisplayName("Doing")
        .description("Your cards in progress.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: Shared layout

struct ListView: View {
    @Environment(\.widgetFamily) private var family
    let title: String
    let count: Int
    let items: [WidgetSnapshot.Item]
    let snapshot: WidgetSnapshot
    let empty: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline).lineLimit(1)
                Spacer()
                Text("\(count)").font(.title2.bold()).foregroundStyle(tint)
            }
            if !snapshot.signedIn {
                Spacer()
                Text("Open Flow to sign in").font(.caption).foregroundStyle(.secondary)
            } else if items.isEmpty {
                Spacer()
                Text(empty).font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(items.prefix(family == .systemSmall ? 2 : 3)) { item in
                    Link(destination: URL(string: item.link) ?? URL(string: "flowapp://inbox")!) {
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: icon(item.kind)).foregroundStyle(tint).font(.caption)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.title).font(.caption.weight(.semibold)).lineLimit(1)
                                if family != .systemSmall, !item.detail.isEmpty {
                                    Text(item.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            if snapshot.signedIn {
                Text(snapshot.updated, style: .relative).font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }

    private func icon(_ kind: WidgetSnapshot.Item.Kind) -> String {
        switch kind {
        case .agent: "hand.raised.fill"
        case .uat: "checkmark.seal"
        case .doing: "hammer"
        case .blocked: "hand.raised"
        case .other: "circle"
        }
    }
}

#Preview("Waiting", as: .systemMedium) {
    WaitingWidget()
} timeline: {
    SnapshotEntry(date: .now, snapshot: .preview)
}
