import SwiftUI

// The timeline, natively: a roadmap (a lane per project, bars across the weeks, today in brick) and a
// list grouped by month for reading on a phone. Colors and status marks follow the web timeline.

@MainActor
@Observable
final class TimelineStore {
    private(set) var items: [TimelineItem] = []
    private(set) var projects: [String: FlowProject] = [:]
    private(set) var loadedEnv: String?
    private(set) var loading = false

    func load(_ api: FlowAPI, env: String) async throws {
        loading = true
        defer { loading = false }
        async let i = api.items(env: env)
        async let p = api.projects(env: env)
        let (items, projects) = try await (i, p)
        self.items = items.filter { $0.startDate != nil }.sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
        self.projects = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        loadedEnv = env
    }

    func color(_ item: TimelineItem) -> Color {
        item.projects.first.flatMap { projects[$0] }.map { Color(flow: $0.color) } ?? Theme.accent
    }

    // Lanes: one per project (in name order), then "No project".
    var lanes: [(id: String, name: String, color: Color, items: [TimelineItem])] {
        var byProject = [String: [TimelineItem]]()
        for i in items { byProject[i.projects.first ?? "", default: []].append(i) }
        var out = byProject.keys.filter { !$0.isEmpty }.compactMap { id -> (String, String, Color, [TimelineItem])? in
            guard let p = projects[id] else { return (id, "Unknown project", Theme.muted, byProject[id] ?? []) }
            return (id, p.name, Color(flow: p.color), byProject[id] ?? [])
        }.sorted { $0.1.localizedCaseInsensitiveCompare($1.1) == .orderedAscending }
        if let none = byProject[""], !none.isEmpty { out.append(("", "No project", Theme.muted, none)) }
        return out.map { (id: $0.0, name: $0.1, color: $0.2, items: $0.3) }
    }
}

enum TimelineMode: String, CaseIterable {
    case roadmap, list
    var title: String { self == .roadmap ? "Roadmap" : "List" }
}

struct StatusMark: View {
    let status: String

    var body: some View {
        switch status {
        case "active": Tag(text: "In progress", color: Theme.columnColor("doing"))
        case "risk": Tag(text: "At risk", color: Theme.warn, icon: "exclamationmark")
        case "blocked": Tag(text: "Blocked", color: Theme.danger)
        case "done": Tag(text: "Done", color: Theme.columnColor("done"), icon: "checkmark")
        case "cancelled": Tag(text: "Cancelled", color: Theme.faint)
        default: Tag(text: "Planned", color: Theme.muted)
        }
    }
}

// MARK: List

struct TimelineList: View {
    let store: TimelineStore
    let onSelect: (TimelineItem) -> Void

    var body: some View {
        let cal = Calendar.current
        let groups = Dictionary(grouping: store.items) { cal.dateInterval(of: .month, for: $0.startDate ?? .now)?.start ?? .now }
        let months = groups.keys.sorted()
        let thisMonth = cal.dateInterval(of: .month, for: .now)?.start ?? .now
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18, pinnedViews: [.sectionHeaders]) {
                    ForEach(months, id: \.self) { month in
                        Section {
                            VStack(spacing: 6) {
                                ForEach(groups[month] ?? []) { item in
                                    Button { onSelect(item) } label: { row(item) }.buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal)
                        } header: {
                            HStack {
                                Text(month.formatted(.dateTime.month(.wide).year()))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(month == thisMonth ? Theme.brick : Theme.ink)
                                if month == thisMonth { Tag(text: "This month", color: Theme.brick) }
                                Spacer()
                            }
                            .padding(.horizontal)
                            .padding(.vertical, 8)
                            .background(Theme.bg.opacity(0.96))
                        }
                        .id(month)
                    }
                }
                .padding(.vertical, 8)
            }
            .onAppear {
                if let target = months.first(where: { $0 >= thisMonth }) ?? months.last { proxy.scrollTo(target, anchor: .top) }
            }
        }
    }

    private func row(_ item: TimelineItem) -> some View {
        HStack(spacing: 0) {
            Rectangle().fill(store.color(item)).frame(width: 3)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: item.symbol).font(.caption).foregroundStyle(store.color(item))
                    Text(item.title).font(.subheadline.weight(.medium)).foregroundStyle(item.status == "cancelled" ? Theme.faint : Theme.ink)
                        .strikethrough(item.status == "cancelled").lineLimit(2).multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                }
                HStack(spacing: 8) {
                    Text(range(item)).font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
                    if let p = item.projects.first.flatMap({ store.projects[$0] }) { ProjectTag(project: p) }
                    Spacer(minLength: 0)
                    StatusMark(status: item.status)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
        }
        .background(Theme.surface)
        .clipShape(.rect(cornerRadius: Theme.corner))
        .overlay(RoundedRectangle(cornerRadius: Theme.corner).strokeBorder(Theme.line))
    }

    private func range(_ item: TimelineItem) -> String {
        guard let s = item.startDate else { return item.start }
        let f = Date.FormatStyle.dateTime.month(.abbreviated).day()
        guard let e = item.endDate, !item.isPoint, e != s else { return s.formatted(f) }
        return "\(s.formatted(f)) – \(e.formatted(f))"
    }
}

// MARK: Roadmap

struct TimelineRoadmap: View {
    let store: TimelineStore
    let onSelect: (TimelineItem) -> Void
    @Environment(\.horizontalSizeClass) private var sizeClass

    private var day: CGFloat { sizeClass == .regular ? 22 : 15 }
    private let row: CGFloat = 30
    private let laneHeader: CGFloat = 28

    var body: some View {
        let cal = Calendar.current
        let today = cal.startOfDay(for: .now)
        let starts = store.items.compactMap(\.startDate), ends = store.items.compactMap(\.endDate)
        let first = cal.date(byAdding: .day, value: -14, to: min(starts.min() ?? today, today))!
        let last = cal.date(byAdding: .day, value: 45, to: max(ends.max() ?? today, today))!
        let origin = cal.dateInterval(of: .weekOfYear, for: first)?.start ?? first
        let days = max(60, min(900, cal.dateComponents([.day], from: origin, to: last).day ?? 60))
        let width = CGFloat(days) * day
        let x = { (d: Date) in CGFloat(cal.dateComponents([.day], from: origin, to: cal.startOfDay(for: d)).day ?? 0) * day }
        let lanes = store.lanes.map { lane in (lane, pack(lane.items)) }

        GeometryReader { geo in
        ScrollViewReader { proxy in
            ScrollView([.horizontal, .vertical]) {
                VStack(alignment: .leading, spacing: 0) {
                    axis(origin: origin, days: days, x: x)
                    ForEach(lanes, id: \.0.id) { lane, rows in
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 6) {
                                RoundedRectangle(cornerRadius: 2).fill(lane.color).frame(width: 9, height: 9)
                                Text(lane.name).font(.caption.weight(.semibold)).foregroundStyle(Theme.ink)
                                Text("\(lane.items.count)").font(.caption).foregroundStyle(Theme.faint)
                            }
                            .padding(.horizontal, 8)
                            .frame(height: laneHeader)
                            .background(Theme.bg.opacity(0.9), in: .rect(cornerRadius: 3))
                            .padding(.leading, 6)
                            ZStack(alignment: .topLeading) {
                                Color.clear.frame(width: width, height: CGFloat(rows.count) * row + 6)
                                ForEach(Array(rows.enumerated()), id: \.offset) { r, items in
                                    ForEach(items) { item in
                                        bar(item, lane.color, x: x)
                                            .offset(y: CGFloat(r) * row + 2)
                                    }
                                }
                            }
                        }
                        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
                    }
                }
                .frame(width: width, alignment: .leading)
                .frame(minHeight: geo.size.height, alignment: .top)
                .background(alignment: .topLeading) {
                    // Weekends shaded, today's line in brick.
                    ZStack(alignment: .topLeading) {
                        ForEach(0..<days, id: \.self) { i in
                            if let d = cal.date(byAdding: .day, value: i, to: origin), cal.isDateInWeekend(d) {
                                Rectangle().fill(Theme.hover.opacity(0.7)).frame(width: day).offset(x: CGFloat(i) * day)
                            }
                        }
                        Rectangle().fill(Theme.brick).frame(width: 2).offset(x: x(today) + day / 2 - 1).id("today")
                    }
                }
            }
            .onAppear { proxy.scrollTo("today", anchor: UnitPoint(x: 0.25, y: 0)) }
        }
        }
    }

    private func axis(origin: Date, days: Int, x: @escaping (Date) -> CGFloat) -> some View {
        let cal = Calendar.current
        let weeks = (0...(days / 7)).compactMap { cal.date(byAdding: .day, value: $0 * 7, to: origin) }
        return ZStack(alignment: .topLeading) {
            Color.clear.frame(height: 40)
            ForEach(weeks, id: \.self) { w in
                VStack(alignment: .leading, spacing: 1) {
                    if cal.component(.day, from: w) <= 7 || w == weeks.first {
                        // "November" (and the year in January or at the start).
                        let showYear = cal.component(.month, from: w) == 1 || w == weeks.first
                        Text(showYear ? w.formatted(.dateTime.month(.wide).year()) : w.formatted(.dateTime.month(.wide)))
                            .font(.caption2.weight(.bold)).foregroundStyle(Theme.ink).fixedSize()
                    } else {
                        Text(" ").font(.caption2)
                    }
                    Text(w.formatted(.dateTime.day())).font(.caption2.monospacedDigit()).foregroundStyle(Theme.muted)
                }
                .padding(.leading, 4)
                .frame(width: day * 7, alignment: .leading)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1) }
                .offset(x: x(w))
            }
        }
        .padding(.top, 4)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line2).frame(height: 1) }
    }

    @ViewBuilder
    private func bar(_ item: TimelineItem, _ color: Color, x: @escaping (Date) -> CGFloat) -> some View {
        let s = item.startDate ?? .now, e = item.endDate ?? s
        let left = x(s)
        if item.isPoint {
            Button { onSelect(item) } label: {
                HStack(spacing: 4) {
                    Image(systemName: "diamond.fill").font(.system(size: 11)).foregroundStyle(color)
                    Text(item.title).font(.caption.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
                }
                .frame(height: row - 6)
            }
            .buttonStyle(.plain)
            .offset(x: left + day / 2 - 6)
        } else {
            let w = max(day, x(e) - left + day)
            Button { onSelect(item) } label: {
                HStack(spacing: 4) {
                    if item.status == "risk" || item.status == "blocked" {
                        Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 9)).foregroundStyle(item.status == "blocked" ? Theme.danger : Theme.warn)
                    }
                    if item.status == "done" { Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)) }
                    Text(item.title).font(.caption.weight(.semibold)).lineLimit(1)
                }
                .foregroundStyle(item.status == "done" || item.status == "cancelled" ? Theme.muted : Theme.ink)
                .padding(.horizontal, 6)
                .frame(width: w, height: row - 6, alignment: .leading)
                .background(color.opacity(item.status == "planned" ? 0.16 : 0.28), in: .rect(cornerRadius: 3))
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(color.opacity(0.65), style: StrokeStyle(lineWidth: 1, dash: item.status == "planned" ? [3, 2] : [])))
            }
            .buttonStyle(.plain)
            .offset(x: left)
        }
    }

    // Items into as few rows as fit without overlapping (point items take a label's width).
    private func pack(_ items: [TimelineItem]) -> [[TimelineItem]] {
        var rows: [[TimelineItem]] = [], ends: [Date] = []
        let cal = Calendar.current
        for i in items {
            guard let s = i.startDate else { continue }
            let span = i.isPoint ? max(3, i.title.count / 3) : 0
            let e = cal.date(byAdding: .day, value: span, to: i.endDate ?? s) ?? s
            if let r = ends.firstIndex(where: { $0 < s }) { rows[r].append(i); ends[r] = e }
            else { rows.append([i]); ends.append(e) }
        }
        return rows
    }
}

// MARK: An item

struct ItemSheet: View {
    let item: TimelineItem
    let store: TimelineStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 8) {
                        Image(systemName: item.symbol).foregroundStyle(store.color(item))
                        Text(item.kind.capitalized).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.muted)
                        Spacer()
                        StatusMark(status: item.status)
                    }
                    Text(item.title).font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
                    VStack(spacing: 0) {
                        fact("Starts", item.startDate?.formatted(date: .abbreviated, time: .omitted) ?? item.start)
                        if !item.isPoint, let e = item.endDate, e != item.startDate {
                            Divider().overlay(Theme.line)
                            fact("Ends", e.formatted(date: .abbreviated, time: .omitted))
                        }
                        if !item.projects.isEmpty {
                            Divider().overlay(Theme.line)
                            HStack {
                                Text("Project").foregroundStyle(Theme.muted)
                                Spacer()
                                ForEach(item.projects.compactMap { store.projects[$0] }) { ProjectTag(project: $0, font: .subheadline) }
                            }
                            .padding(.vertical, 10)
                        }
                        if let owner = item.owner, !owner.isEmpty {
                            Divider().overlay(Theme.line)
                            fact("Owner", owner)
                        }
                        if let p = item.priority, !p.isEmpty {
                            Divider().overlay(Theme.line)
                            fact("Priority", p.capitalized)
                        }
                    }
                    .padding(.horizontal, 12)
                    .background(Theme.surface, in: .rect(cornerRadius: Theme.corner))
                    .overlay(RoundedRectangle(cornerRadius: Theme.corner).strokeBorder(Theme.line))
                    if let notes = item.notes, !notes.isEmpty {
                        Text(notes).font(.callout).foregroundStyle(Theme.ink).textSelection(.enabled).cardSurface()
                    }
                    if let link = item.link, let url = URL(string: link) {
                        Link(destination: url) { Label(LinkInfo(url).title, systemImage: "link") }
                            .buttonStyle(.flow(.secondary))
                    }
                }
                .padding()
            }
            .background(Theme.bg)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Theme.muted)
            Spacer()
            Text(value).foregroundStyle(Theme.ink)
        }
        .font(.subheadline)
        .padding(.vertical, 10)
    }
}
