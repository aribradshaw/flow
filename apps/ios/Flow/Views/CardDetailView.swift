import SwiftUI

// One card, from the board, the inbox, a notification or a widget.
struct CardDetailView: View {
    @Environment(AppModel.self) private var model
    let ref: CardRef
    let onChange: (FlowCard) -> Void
    @State private var card: FlowCard?
    @State private var meta = AppModel.EnvMeta()
    @State private var mover = CardMover()
    @State private var editing = false
    @State private var error: String?
    @State private var ticked = 0
    @State private var moved = 0
    @State private var moving = false

    init(ref: CardRef, initial: FlowCard? = nil, onChange: @escaping (FlowCard) -> Void = { _ in }) {
        self.ref = ref
        self.onChange = onChange
        _card = State(initialValue: initial)
    }

    var body: some View {
        Group {
            if let card {
                details(card)
            } else if let error {
                ContentUnavailableView("Can't open this card", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                details(.placeholder).redacted(reason: .placeholder).disabled(true)
            }
        }
        .background(Theme.bg)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let card {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Menu {
                        MoveMenu(card: card) { to in move(card, to) }
                        if let url = webURL(card) {
                            ShareLink(item: url) { Label("Share link", systemImage: "square.and.arrow.up") }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    Button("Edit") { editing = true }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let card, let next = BoardColumn(rawValue: card.column)?.nextStep {
                Button {
                    move(card, next.to)
                } label: {
                    Label(next.title, systemImage: next.systemImage)
                }
                .buttonStyle(.flow(.primary, large: true))
                .disabled(moving)
                .padding(.horizontal)
                .padding(.top, 8)
                .padding(.bottom, 4)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
                .background(Theme.bg.opacity(0.96))
            }
        }
        .sheet(isPresented: $editing) {
            if let card { CardEditorView(mode: .edit(env: ref.env, card: card)) { updated($0) } }
        }
        .cardMoveDialog(mover)
        .sensoryFeedback(.selection, trigger: ticked)
        .sensoryFeedback(.success, trigger: moved)
        .task {
            mover.onMoved = { updated($0); moved += 1 }
            await refresh()
            #if DEBUG
            // UI testing: `-editCard YES` opens the editor on the card that opened.
            if UserDefaults.standard.bool(forKey: "editCard"), card != nil { editing = true }
            #endif
        }
        .refreshable { await refresh() }
    }

    private func details(_ card: FlowCard) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let message = error ?? mover.error {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                        .cardSurface()
                }
                header(card)
                facts(card)
                if let text = card.description, !text.isEmpty {
                    section("Description") {
                        Text(markdown(text))
                            .font(.callout)
                            .foregroundStyle(Theme.ink)
                            .textSelection(.enabled)
                            .tint(Theme.accent)
                    }
                }
                if let items = card.checklist, !items.isEmpty { checklist(items) }
                if let links = card.links, !links.isEmpty { linksSection(links) }
            }
            .padding()
            .padding(.bottom, 12)
            .frame(maxWidth: 680)
            .frame(maxWidth: .infinity)
        }
    }

    private func header(_ card: FlowCard) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ColumnPill(column: card.column)
                Text(card.numberText).font(.caption.monospacedDigit()).foregroundStyle(Theme.faint)
                if let snoozed = card.snoozedUntil, let d = ISO8601DateFormatter().date(from: snoozed), d > .now {
                    Tag(text: "Snoozed", color: Theme.muted, icon: "moon.zzz")
                }
                Spacer()
            }
            Text(card.title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .textSelection(.enabled)
            let labels = (card.labels ?? []).compactMap { meta.labels[$0] }
            if !labels.isEmpty {
                FlowLayout(spacing: 6) { ForEach(labels) { LabelChip(label: $0) } }
            }
        }
    }

    private func facts(_ card: FlowCard) -> some View {
        let people = meta.assignees(card)
        let roles = Dictionary((card.assignees ?? []).map { ($0.node, $0.role ?? "developer") }, uniquingKeysWith: { a, _ in a })
        return VStack(spacing: 0) {
            if let p = card.project.flatMap({ meta.projects[$0] }) {
                factRow { icon("folder") } label: { Text("Project").foregroundStyle(Theme.ink) } value: { ProjectTag(project: p, font: .subheadline) }
                Divider().overlay(Theme.line).padding(.leading, 40)
            }
            if !people.isEmpty {
                ForEach(people) { person in
                    factRow {
                        Avatar(name: person.name, image: person.image, size: 24, ring: false)
                    } label: {
                        Text(person.name).foregroundStyle(Theme.ink)
                    } value: {
                        Text((roles[person.id] ?? "developer").capitalized).foregroundStyle(Theme.muted)
                    }
                    Divider().overlay(Theme.line).padding(.leading, 40)
                }
            }
            if let due = card.due, !due.isEmpty {
                factRow { icon("calendar") } label: { Text("Due").foregroundStyle(Theme.ink) } value: {
                    HStack(spacing: 6) {
                        // "Tomorrow · Dec 1": the relative words only when they say more than the date.
                        if let info = DueLabel.describe(due), (-1...6).contains(info.days) || info.days < -1 {
                            DueLabel(due: due, done: card.column == "done")
                            Text("·").foregroundStyle(Theme.faint)
                        }
                        if let d = DueLabel.parser.date(from: due) { Text(d.formatted(.dateTime.month(.abbreviated).day().year())).foregroundStyle(Theme.muted) }
                    }
                }
                Divider().overlay(Theme.line).padding(.leading, 40)
            }
            if let points = card.points {
                factRow { icon("gauge.with.needle") } label: { Text("Points").foregroundStyle(Theme.ink) } value: { Text(points.formatted()).foregroundStyle(Theme.muted) }
                Divider().overlay(Theme.line).padding(.leading, 40)
            }
            factRow { icon("clock") } label: { Text("Updated").foregroundStyle(Theme.ink) } value: {
                if let u = card.updated, let d = ISO8601DateFormatter.withFraction.date(from: u) ?? ISO8601DateFormatter().date(from: u) {
                    Text(d, format: .relative(presentation: .named)).foregroundStyle(Theme.muted)
                } else {
                    Text("—").foregroundStyle(Theme.muted)
                }
            }
        }
        .padding(.horizontal, 12)
        .background(Theme.surface, in: .rect(cornerRadius: Theme.corner))
        .overlay(RoundedRectangle(cornerRadius: Theme.corner).strokeBorder(Theme.line))
    }

    private func factRow<I: View, L: View, V: View>(@ViewBuilder icon: () -> I, @ViewBuilder label: () -> L, @ViewBuilder value: () -> V) -> some View {
        HStack(spacing: 10) {
            icon().frame(width: 28)
            label().font(.subheadline)
            Spacer()
            value().font(.subheadline)
        }
        .padding(.vertical, 9)
    }

    private func icon(_ name: String, _ color: Color = Theme.muted) -> some View {
        Image(systemName: name)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(color)
    }

    private func section<C: View>(_ title: String, trailing: String? = nil, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).flowSectionTitle()
                Spacer()
                if let trailing { Text(trailing).font(.footnote.monospacedDigit()).foregroundStyle(Theme.faint) }
            }
            .padding(.horizontal, 2)
            content().cardSurface()
        }
    }

    private func checklist(_ items: [FlowCard.ChecklistItem]) -> some View {
        let done = items.filter(\.done).count
        return section("Checklist", trailing: "\(done) of \(items.count)") {
            VStack(alignment: .leading, spacing: 12) {
                ProgressView(value: Double(done), total: Double(max(items.count, 1)))
                    .tint(Theme.green)
                ForEach(items) { item in
                    Button {
                        Task { await toggle(item) }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: item.done ? "checkmark.square.fill" : "square")
                                .foregroundStyle(item.done ? Theme.accent : Theme.faint)
                                .font(.body)
                                .contentTransition(.symbolEffect(.replace))
                            Text(item.text)
                                .font(.subheadline)
                                .strikethrough(item.done, color: Theme.faint)
                                .foregroundStyle(item.done ? Theme.muted : Theme.ink)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func linksSection(_ links: [FlowCard.CardLink]) -> some View {
        section("Links") {
            VStack(spacing: 12) {
                ForEach(links, id: \.url) { link in
                    if let url = URL(string: link.url) {
                        Link(destination: url) {
                            HStack(spacing: 12) {
                                icon(link.kind == "pr" ? "arrow.triangle.pull" : link.kind == "commit" ? "smallcircle.filled.circle" : "link", Theme.accent)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(LinkInfo(url).title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(1)
                                    Text(LinkInfo(url).subtitle).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
                            }
                        }
                    }
                }
            }
        }
    }

    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    private func webURL(_ card: FlowCard) -> URL? {
        guard let n = card.number else { return nil }
        return URL(string: "/#devops/card/\(n)", relativeTo: model.server)?.absoluteURL
    }

    private func move(_ card: FlowCard, _ to: BoardColumn) {
        guard let api = model.api else { return }
        moving = true
        Task {
            await mover.move(api, env: ref.env, card: card, to: to, approve: card.column == BoardColumn.uat.rawValue && to == .done)
            moving = false
        }
    }

    private func updated(_ fresh: FlowCard) {
        withAnimation(.snappy) { card = fresh }
        error = nil
        onChange(fresh)
    }

    private func refresh() async {
        guard let api = model.api else { return }
        meta = await model.meta(ref.env)
        do {
            updated(try await api.card(env: ref.env, card: ref.id))
        } catch {
            model.handle(error)
            if card == nil || (error as? FlowError)?.status == 404 { self.error = error.localizedDescription }
        }
    }

    // Ticks one item at once (optimistically), sending the whole list with ifUpdated.
    private func toggle(_ item: FlowCard.ChecklistItem) async {
        guard let api = model.api, let card else { return }
        ticked += 1
        let list = (card.checklist ?? []).map { CardPatch.ChecklistEdit(id: $0.id, text: $0.text, done: $0.id == item.id ? !$0.done : $0.done) }
        do {
            updated(try await api.updateCard(env: ref.env, card: card.id, CardPatch(checklist: list, ifUpdated: card.updated)))
        } catch let e as FlowError where e.code == "card_changed" {
            error = "This card changed somewhere else, so it was reloaded. Try again."
            await refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// GitHub links read as "PR #12" / "repo", anything else as its host and path.
struct LinkInfo {
    let title: String
    let subtitle: String

    init(_ url: URL) {
        let parts = url.pathComponents.filter { $0 != "/" }
        if url.host?.hasSuffix("github.com") == true, parts.count >= 4 {
            let repo = "\(parts[0])/\(parts[1])"
            switch parts[2] {
            case "pull": title = "Pull request #\(parts[3])"; subtitle = repo; return
            case "issues": title = "Issue #\(parts[3])"; subtitle = repo; return
            case "commit": title = "Commit \(parts[3].prefix(7))"; subtitle = repo; return
            default: break
            }
        }
        title = url.host ?? url.absoluteString
        subtitle = url.path.isEmpty ? url.absoluteString : url.path
    }
}

// Wraps chips onto as many lines as they need.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width { y += row + spacing; x = 0; row = 0 }
            x += s.width + spacing; row = max(row, s.height); widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX { y += row + spacing; x = bounds.minX; row = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing; row = max(row, s.height)
        }
    }
}

extension ISO8601DateFormatter {
    static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
