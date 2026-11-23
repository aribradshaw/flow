import SwiftUI

// The app's small design system: Flow's green as the accent on native iOS surfaces.
enum Theme {
    static let corner: CGFloat = 14
    static let green = Color.accentColor

    static func columnColor(_ column: String) -> Color {
        switch column {
        case "doing": .blue
        case "blocked": .red
        case "uat": .orange
        case "done": .green
        case "must": .purple
        case "nice": .teal
        default: .gray
        }
    }
}

// A card surface: grouped background, soft corners, a hairline in dark mode.
struct CardSurface: ViewModifier {
    var padding: CGFloat = 14
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: Theme.corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.corner, style: .continuous).strokeBorder(Color.primary.opacity(0.06)))
    }
}

extension View {
    func cardSurface(padding: CGFloat = 14) -> some View { modifier(CardSurface(padding: padding)) }
}

// A column as a small colored capsule: "● Doing".
struct ColumnPill: View {
    let column: String

    var body: some View {
        let col = BoardColumn(rawValue: column)
        HStack(spacing: 5) {
            Circle().fill(Theme.columnColor(column)).frame(width: 7, height: 7)
            Text(col?.shortTitle ?? column)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(Theme.columnColor(column).opacity(0.14), in: .capsule)
        .foregroundStyle(Theme.columnColor(column))
    }
}

// A project: its color dot and name.
struct ProjectTag: View {
    let project: FlowProject?
    var font: Font = .caption

    var body: some View {
        if let project {
            HStack(spacing: 5) {
                Circle().fill(Color(flow: project.color)).frame(width: 8, height: 8)
                Text(project.name).lineLimit(1)
            }
            .font(font)
            .foregroundStyle(.secondary)
        }
    }
}

// People: a photo when they have one, else initials on a color derived from their name.
struct Avatar: View {
    let name: String
    var image: String?
    var size: CGFloat = 22

    var body: some View {
        Group {
            if let image, let url = URL(string: image), url.scheme == "https" {
                AsyncImage(url: url) { phase in
                    if let img = phase.image { img.resizable().scaledToFill() } else { initials }
                }
            } else if let image, let data = Avatar.decode(image), let ui = UIImage(data: data) {
                Image(uiImage: ui).resizable().scaledToFill()
            } else {
                initials
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(Color(.systemBackground), lineWidth: size > 24 ? 2 : 1.5))
        .accessibilityLabel(name)
    }

    private var initials: some View {
        // "Ann Example" -> AE; an email uses its local part: "joseph.basrawi@…" -> JB, "dev@…" -> D.
        let base = name.contains("@") ? String(name.split(separator: "@").first ?? "") : name
        let parts = base.split(whereSeparator: { " ._-".contains($0) }).prefix(2)
        let letters = parts.compactMap(\.first).map(String.init).joined().uppercased()
        return ZStack {
            Circle().fill(Avatar.color(for: name).gradient)
            Text(letters.isEmpty ? "?" : letters)
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
        }
    }

    static func color(for name: String) -> Color {
        let palette: [Color] = [.blue, .purple, .pink, .orange, .teal, .indigo, .green, .brown]
        let sum = name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xffff }
        return palette[sum % palette.count]
    }

    private static func decode(_ s: String) -> Data? {
        guard s.hasPrefix("data:image/"), let comma = s.firstIndex(of: ",") else { return nil }
        return Data(base64Encoded: String(s[s.index(after: comma)...]))
    }
}

struct AvatarStack: View {
    let people: [FlowPerson]
    var size: CGFloat = 22

    var body: some View {
        HStack(spacing: -size * 0.3) {
            ForEach(people.prefix(3)) { Avatar(name: $0.name, image: $0.image, size: size) }
            if people.count > 3 {
                Text("+\(people.count - 3)")
                    .font(.system(size: size * 0.4, weight: .semibold))
                    .frame(width: size, height: size)
                    .background(Color(.tertiarySystemFill), in: .circle)
            }
        }
    }
}

// "Today", "Tomorrow", "in 3 days", "Overdue · 2d", "Dec 1"; red when overdue, orange when soon.
struct DueLabel: View {
    let due: String
    var done = false

    var body: some View {
        if let info = DueLabel.describe(due) {
            Label(info.text, systemImage: info.days < 0 ? "exclamationmark.circle" : "calendar")
                .labelStyle(TightLabel())
                .font(.caption.weight(info.days <= 1 ? .semibold : .regular))
                .foregroundStyle(done ? .secondary : info.days < 0 ? Color.red : info.days <= 1 ? Color.orange : Color.secondary)
        }
    }

    static let parser: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func describe(_ due: String) -> (text: String, days: Int)? {
        guard let date = parser.date(from: due) else { return nil }
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: .now), to: cal.startOfDay(for: date)).day ?? 0
        let text: String
        switch days {
        case 0: text = "Today"
        case 1: text = "Tomorrow"
        case -1: text = "Yesterday"
        case ..<(-1): text = "\(-days)d overdue"
        case 2...6: text = date.formatted(.dateTime.weekday(.wide))
        default: text = date.formatted(.dateTime.month(.abbreviated).day())
        }
        return (text, days)
    }
}

// Icon and text close together (Label's default gap is wide in rows).
struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

// Checklist progress: a small ring and "2/5".
struct ChecklistProgress: View {
    let done: Int
    let total: Int

    var body: some View {
        HStack(spacing: 4) {
            ZStack {
                Circle().stroke(Color.secondary.opacity(0.25), lineWidth: 2)
                Circle().trim(from: 0, to: total == 0 ? 0 : CGFloat(done) / CGFloat(total))
                    .stroke(done == total ? Color.green : Theme.green, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 11, height: 11)
            Text("\(done)/\(total)")
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(done == total ? Color.green : Color.secondary)
    }
}

// The brand mark (the app icon artwork) for the welcome screen.
struct FlowMark: View {
    var size: CGFloat = 88

    var body: some View {
        Image("Logo")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 12, y: 6)
    }
}

extension BoardColumn {
    var shortTitle: String {
        switch self {
        case .must: "Must Have"
        case .nice: "Nice to Have"
        default: title
        }
    }

    // The one obvious next step from this column, shown as the card's main button.
    var nextStep: (title: String, to: BoardColumn, systemImage: String)? {
        switch self {
        case .requests, .must, .nice: ("Start", .doing, "play.fill")
        case .doing: ("Send to UAT", .uat, "checkmark.seal")
        case .blocked: ("Unblock", .doing, "arrow.uturn.forward")
        case .uat: ("Approve", .done, "checkmark.circle.fill")
        case .done: nil
        }
    }
}
