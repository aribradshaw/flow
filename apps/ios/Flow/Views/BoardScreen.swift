import SwiftUI

struct BoardScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Binding var path: NavigationPath
    @State private var board = BoardStore()
    @State private var mover = CardMover()
    @State private var column: BoardColumn = .doing
    @State private var error: String?
    @State private var newCardColumn: BoardColumn?
    @State private var moved = 0

    private var meta: AppModel.EnvMeta { model.metas[model.envID ?? ""] ?? AppModel.EnvMeta() }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .background(Theme.bg)
                .navigationTitle(model.env?.name ?? "Board")
                .navigationBarTitleDisplayMode(.inline)
                .toolbarTitleMenu {
                    if model.envs.count > 1 {
                        Picker("Workspace", selection: Binding(get: { model.envID }, set: { model.envID = $0 })) {
                            ForEach(model.envs) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                }
                .navigationDestination(for: CardRef.self) { ref in
                    CardDetailView(ref: ref, initial: board.cards.first { $0.id == ref.id }) { board.replace($0) }
                }
                .toolbar { toolbar }
                .refreshable { await load() }
                .task(id: model.envID) { if !(board.isFresh && board.loadedEnv == model.envID) { await load() } }
                .onChange(of: board.projectFilter) { Task { await load() } }
                .onChange(of: scenePhase) { if scenePhase == .active && !board.isFresh { Task { await load() } } }
                .safeAreaInset(edge: .bottom) { banner }
                .cardMoveDialog(mover)
                .sensoryFeedback(.success, trigger: moved)
                .sheet(item: $newCardColumn) { col in
                    if let env = model.envID {
                        CardEditorView(mode: .create(env: env, column: col, project: board.projectFilter)) { card in
                            board.replace(card)
                            withAnimation { column = BoardColumn(rawValue: card.column) ?? column }
                        }
                    }
                }
                .onAppear { mover.onMoved = { card in board.replace(card); moved += 1 } }
        }
    }

    @ViewBuilder
    private var banner: some View {
        if let message = error ?? mover.error {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.regularMaterial, in: .rect(cornerRadius: 12))
                .padding(.horizontal)
                .padding(.bottom, 6)
                .onTapGesture { error = nil; mover.error = nil }
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.envsLoaded && model.envs.isEmpty {
            ContentUnavailableView {
                Label("No workspace yet", systemImage: "square.stack.3d.up")
            } description: {
                Text("A workspace holds your mind map, timeline and board.")
            } actions: {
                Button("Create a workspace") {
                    Task {
                        do { try await model.createEnvironment(named: "My workspace") } catch { self.error = error.localizedDescription }
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        } else if sizeClass == .regular {
            GeometryReader { geo in
                ScrollView([.horizontal, .vertical]) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(BoardColumn.allCases) { col in
                            ColumnView(board: board, meta: meta, column: col, onMove: requestMove, onAdd: { newCardColumn = col })
                                .frame(width: 292)
                        }
                    }
                    .padding(16)
                    .frame(minHeight: geo.size.height, alignment: .top)
                }
            }
        } else {
            VStack(spacing: 0) {
                ColumnStrip(board: board, column: $column)
                // A paging scroll view (not TabView's page style, which jumps when its pages change).
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 0) {
                        ForEach(BoardColumn.allCases) { col in
                            columnPage(col)
                                .containerRelativeFrame(.horizontal)
                                .id(col)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollIndicators(.hidden)
                .scrollPosition(id: Binding(get: { column }, set: { if let c = $0 { column = c } }))
            }
        }
    }

    private func columnPage(_ col: BoardColumn) -> some View {
        let cards = board.cards(in: col)
        return List {
            if !board.loadedOnce {
                ForEach(0..<4, id: \.self) { _ in
                    CardTile(card: .placeholder, meta: AppModel.EnvMeta())
                        .redacted(reason: .placeholder)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                }
            }
            ForEach(cards) { card in
                CardTile(card: card, meta: meta)
                    .background { NavigationLink(value: CardRef(env: model.envID ?? "", id: card.id)) { EmptyView() }.opacity(0) }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 3, leading: 16, bottom: 3, trailing: 16))
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    if let next = col.nextStep {
                        Button { requestMove(card, next.to) } label: { Label(next.title, systemImage: next.systemImage) }
                            .tint(Theme.columnColor(next.to.rawValue))
                    }
                }
                .swipeActions(edge: .trailing) {
                    if col != .blocked && col != .done {
                        Button { requestMove(card, .blocked) } label: { Label("Block", systemImage: "hand.raised.fill") }.tint(.red)
                    }
                    if col != .requests {
                        Button { requestMove(card, .requests) } label: { Label("Requests", systemImage: "tray") }.tint(.gray)
                    }
                }
                .contextMenu { MoveMenu(card: card) { requestMove(card, $0) } }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .overlay {
            if board.loadedOnce && cards.isEmpty {
                ContentUnavailableView {
                    Label("Nothing in \(col.shortTitle)", systemImage: col.systemImage)
                } description: {
                    Text(col == .doing ? "Swipe a card right to start it." : "")
                } actions: {
                    Button("New card", systemImage: "plus") { newCardColumn = col }
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { ProfileButton() }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Menu {
                Picker("Project", selection: $board.projectFilter) {
                    Label("All projects", systemImage: "square.grid.2x2").tag(String?.none)
                    ForEach(board.sortedProjects) { p in Text(p.name).tag(Optional(p.id)) }
                }
            } label: {
                Image(systemName: board.projectFilter == nil ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
            }
            .accessibilityLabel("Filter by project")
            Button("New card", systemImage: "plus") {
                newCardColumn = sizeClass == .regular ? .requests : column
            }
            .disabled(model.envID == nil)
        }
    }

    private func requestMove(_ card: FlowCard, _ to: BoardColumn) {
        guard let api = model.api, let env = model.envID else { return }
        Task { await mover.move(api, env: env, card: card, to: to, approve: card.column == BoardColumn.uat.rawValue && to == .done) }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            if model.envs.isEmpty || model.env == nil { try await model.loadEnvs() }
            guard let env = model.envID else { return }
            try await board.load(api, env: env)
            model.setMeta(env, projects: Array(board.projects.values), labels: Array(board.labels.values), people: board.people)
            withAnimation { error = nil }
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            model.handle(error)
            withAnimation { self.error = error.localizedDescription }
        }
    }
}

// The iPhone's column header: every column with its count, the current one highlighted; it follows swipes.
private struct ColumnStrip: View {
    let board: BoardStore
    @Binding var column: BoardColumn

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(BoardColumn.allCases) { col in
                        let selected = col == column
                        Button {
                            withAnimation(.easeInOut(duration: 0.25)) { column = col }
                        } label: {
                            HStack(spacing: 5) {
                                Circle().fill(Theme.columnColor(col.rawValue)).frame(width: 6, height: 6)
                                Text(col.shortTitle)
                                Text("\(board.cards(in: col).count)")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(Theme.faint)
                            }
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 10)
                            .frame(minHeight: 32)
                            .background {
                                if selected {
                                    RoundedRectangle(cornerRadius: 3).fill(Theme.surface)
                                        .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line2))
                                }
                            }
                            .foregroundStyle(selected ? Theme.ink : Theme.muted)
                        }
                        .buttonStyle(.plain)
                        .id(col)
                    }
                }
                .padding(2)
                .background(Theme.hover.opacity(0.6), in: .rect(cornerRadius: Theme.corner))
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .scrollClipDisabled()
            .onChange(of: column) { withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(column, anchor: .center) } }
        }
        .sensoryFeedback(.selection, trigger: column)
    }
}

// A column on iPad: header with count and +, then its cards; cards drag between columns.
private struct ColumnView: View {
    @Environment(AppModel.self) private var model
    let board: BoardStore
    let meta: AppModel.EnvMeta
    let column: BoardColumn
    let onMove: (FlowCard, BoardColumn) -> Void
    let onAdd: () -> Void
    @State private var targeted = false

    var body: some View {
        let cards = board.cards(in: column)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Circle().fill(Theme.columnColor(column.rawValue)).frame(width: 7, height: 7)
                Text(column.shortTitle).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Text("\(cards.count)").font(.caption.monospacedDigit()).foregroundStyle(Theme.faint)
                Spacer()
                Button(action: onAdd) {
                    Image(systemName: "plus").font(.subheadline.weight(.medium)).foregroundStyle(Theme.muted).frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add a card to \(column.title)")
            }
            .padding(.leading, 6)
            VStack(spacing: 5) {
                    ForEach(cards) { card in
                        NavigationLink(value: CardRef(env: model.envID ?? "", id: card.id)) {
                            CardTile(card: card, meta: meta)
                        }
                        .buttonStyle(.plain)
                        .contextMenu { MoveMenu(card: card) { onMove(card, $0) } }
                        .draggable(card.id)
                    }
                    Button(action: onAdd) {
                        HStack(spacing: 6) {
                            Image(systemName: "plus").font(.caption.weight(.semibold))
                            Text("Add a card")
                        }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, minHeight: 36)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
            }
        }
        .padding(6)
        .background(targeted ? Theme.accentWash : Theme.bg, in: .rect(cornerRadius: Theme.panelCorner))
        .overlay(RoundedRectangle(cornerRadius: Theme.panelCorner).strokeBorder(targeted ? Theme.green : Theme.line))
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first, let card = board.cards.first(where: { $0.id == id }), card.column != column.rawValue else { return false }
            onMove(card, column)
            return true
        } isTargeted: { targeted = $0 }
    }
}

// One card on the board or in the inbox.
struct CardTile: View {
    let card: FlowCard
    let meta: AppModel.EnvMeta

    var body: some View {
        let labels = (card.labels ?? []).compactMap { meta.labels[$0] }
        let people = meta.assignees(card)
        let items = card.checklist ?? []
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(card.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(card.column == "done" ? Theme.muted : Theme.ink)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                Text(card.numberText).font(.caption2.monospacedDigit()).foregroundStyle(Theme.faint)
            }
            // The details wrap onto a second line rather than squeezing; people stay on the right.
            HStack(alignment: .bottom, spacing: 8) {
                FlowLayout(spacing: 8) {
                    ProjectTag(project: card.project.flatMap { meta.projects[$0] }).fixedSize()
                    ForEach(labels.prefix(2)) { LabelChip(label: $0).fixedSize() }
                    if labels.count > 2 { Text("+\(labels.count - 2)").font(.caption2).foregroundStyle(Theme.faint) }
                    if let due = card.due, !due.isEmpty { DueLabel(due: due, done: card.column == "done").fixedSize() }
                    if !items.isEmpty { ChecklistProgress(done: items.filter(\.done).count, total: items.count).fixedSize() }
                }
                Spacer(minLength: 0)
                if !people.isEmpty { AvatarStack(people: people) }
            }
        }
        .cardSurface(padding: 10)
        .contentShape(.rect(cornerRadius: Theme.corner))
    }
}

extension FlowCard {
    static let placeholder = FlowCard(id: UUID().uuidString, number: 12, title: "A card title that is loading", description: nil, column: "doing",
                                      project: nil, labels: nil, points: nil, due: "2026-12-01", assignees: nil, checklist: nil, links: nil, updated: nil, snoozedUntil: nil)
}
