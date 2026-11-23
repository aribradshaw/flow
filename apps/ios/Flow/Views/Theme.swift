import SwiftUI

// Flow's design language, from the web app (public/style.css, @flygon/styles): a quiet grey base,
// white surfaces with hairline borders, tight corners, dark green accents and a brick call to action.
// Dark mode uses the Flygon "Night" palette.
enum Theme {
    // Corners: cards and buttons 4, columns and panels 6 (the web's --r and .col).
    static let corner: CGFloat = 4
    static let panelCorner: CGFloat = 6

    static let bg = dyn(0xf6f7f6, 0x151719)          // --bg / night paper
    static let surface = dyn(0xffffff, 0x222529)     // cards
    static let hover = dyn(0xeef1ef, 0x2b2f34)       // --hover
    static let line = dyn(0xe3e7e5, 0x3a3f45)        // --line
    static let line2 = dyn(0xccd4d1, 0x4a5057)       // --line2
    static let ink = dyn(0x1d2725, 0xf1f3f4)         // --ink
    static let muted = dyn(0x66726e, 0xbbc1c7)       // --muted
    static let faint = dyn(0x98a39f, 0x8a9198)       // --faint
    static let danger = dyn(0xb4443a, 0xe8857b)      // --danger
    static let warn = dyn(0xc27a1a, 0xe0a552)        // --warn

    // Flygon brand.
    static let green = Color(hex: "#7cb980")!                 // --flygon-green: selection, active marks
    static let accent = dyn(0x324b34, 0xb7d9ae)               // --accent: text and icons
    static let accentWash = dyn(0xeef7e6, 0x23331f)           // --accent-2 / tint
    static let light = Color(hex: "#d1ecb0")!                 // --flygon-light
    static let brick = Color(hex: "#a8524c")!                 // --primary: the call to action
    static let person = dyn(0x3d6fb6, 0x7fa8e0)               // person cards' icon
    static let note = dyn(0xa8862b, 0xd9b75a)

    static let dots = dyn(0xc5cfcb, 0x33383d)                 // the canvas dot grid
    static let edge = dyn(0x4d6e62, 0x8fb3a4)                 // ownership lines
    static let edgeGroup = dyn(0x8f9c97, 0x6c757b)            // grouping lines

    static func columnColor(_ column: String) -> Color {
        switch column {
        case "doing": dyn(0x3d6fb6, 0x7fa8e0)
        case "blocked": danger
        case "uat": warn
        case "done": dyn(0x3f8a4a, 0x8fcf96)
        case "must": dyn(0x6a4fb0, 0xb3a0ea)
        case "nice": dyn(0x2f7f86, 0x7cc6cc)
        default: muted
        }
    }

    static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light) })
    }
}

extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
    }
}

// A Flow surface: white, a hairline border, 4px corners (the web's .card).
struct CardSurface: ViewModifier {
    var padding: CGFloat = 12
    var selected = false
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: .rect(cornerRadius: Theme.corner))
            .overlay(RoundedRectangle(cornerRadius: Theme.corner).strokeBorder(selected ? Theme.green : Theme.line, lineWidth: selected ? 1.5 : 1))
    }
}

extension View {
    func cardSurface(padding: CGFloat = 12, selected: Bool = false) -> some View { modifier(CardSurface(padding: padding, selected: selected)) }

    // A section title the way the web labels panels: small, semibold, muted.
    func flowSectionTitle() -> some View {
        font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted).textCase(nil)
    }
}

// Buttons: brick primary (white text), quiet outlined secondary, and a danger variant (the web's .txt).
struct FlowButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, danger, accent }
    var kind: Kind = .primary
    var large = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font((large ? Font.body : .subheadline).weight(.semibold))
            .padding(.horizontal, large ? 16 : 12)
            .frame(minHeight: large ? 48 : 36)
            .frame(maxWidth: large ? .infinity : nil)
            .foregroundStyle(foreground)
            .background(background(configuration.isPressed), in: .rect(cornerRadius: Theme.corner))
            .overlay {
                if kind == .secondary || kind == .danger {
                    RoundedRectangle(cornerRadius: Theme.corner).strokeBorder(kind == .danger ? Theme.danger.opacity(0.45) : Theme.line2)
                }
            }
            .opacity(enabled ? 1 : 0.45)
            .contentShape(.rect(cornerRadius: Theme.corner))
    }

    private var foreground: Color {
        switch kind {
        case .primary, .accent: .white
        case .secondary: Theme.ink
        case .danger: Theme.danger
        }
    }

    private func background(_ pressed: Bool) -> Color {
        switch kind {
        case .primary: pressed ? Color(hex: "#974a44")! : Theme.brick
        case .accent: pressed ? Theme.accent.opacity(0.85) : Theme.accent
        case .secondary, .danger: pressed ? Theme.hover : Theme.surface
        }
    }
}

extension ButtonStyle where Self == FlowButtonStyle {
    static func flow(_ kind: FlowButtonStyle.Kind = .primary, large: Bool = false) -> FlowButtonStyle { FlowButtonStyle(kind: kind, large: large) }
}

// The web's segmented control (.seg): a grey track, the selected segment white with a hairline.
struct FlowSegmented<T: Hashable>: View {
    let options: [T]
    @Binding var selection: T
    let title: (T) -> String
    var count: ((T) -> Int?)? = nil

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.self) { o in
                let on = o == selection
                Button {
                    withAnimation(.snappy(duration: 0.2)) { selection = o }
                } label: {
                    HStack(spacing: 4) {
                        Text(title(o))
                        if let n = count?(o) { Text("\(n)").foregroundStyle(on ? Theme.muted : Theme.faint).monospacedDigit() }
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(on ? Theme.ink : Theme.muted)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 30)
                    .background {
                        if on {
                            RoundedRectangle(cornerRadius: 3).fill(Theme.surface)
                                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line2))
                        }
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Theme.bg, in: .rect(cornerRadius: Theme.corner))
        .overlay(RoundedRectangle(cornerRadius: Theme.corner).strokeBorder(Theme.line))
        .sensoryFeedback(.selection, trigger: selection)
    }
}

// A tag (the web's .tag): 3px corners, a 14% wash of its color with dark text.
struct Tag: View {
    let text: String
    let color: Color
    var icon: String?

    var body: some View {
        HStack(spacing: 3) {
            if let icon { Image(systemName: icon).font(.system(size: 9, weight: .bold)) }
            Text(text)
        }
        .font(.caption2.weight(.semibold))
        .lineLimit(1)
        .padding(.horizontal, 6)
        .frame(height: 18)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: .rect(cornerRadius: 3))
    }
}

// A column as a tag with its color: "● Doing".
struct ColumnPill: View {
    let column: String

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(Theme.columnColor(column)).frame(width: 6, height: 6)
            Text(BoardColumn(rawValue: column)?.shortTitle ?? column)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 7)
        .frame(height: 22)
        .foregroundStyle(Theme.columnColor(column))
        .background(Theme.columnColor(column).opacity(0.12), in: .rect(cornerRadius: 3))
    }
}

// A project: its color dot and name.
struct ProjectTag: View {
    let project: FlowProject?
    var font: Font = .caption

    var body: some View {
        if let project {
            HStack(spacing: 5) {
                RoundedRectangle(cornerRadius: 2).fill(Color(flow: project.color)).frame(width: 8, height: 8)
                Text(project.name).lineLimit(1)
            }
            .font(font)
            .foregroundStyle(Theme.muted)
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
        .overlay(Circle().strokeBorder(Theme.surface, lineWidth: size > 24 ? 2 : 1.5))
        .accessibilityLabel(name)
    }

    private var initials: some View {
        // "Ann Example" -> AE; an email uses its local part: "joseph.basrawi@…" -> JB, "dev@…" -> D.
        let base = name.contains("@") ? String(name.split(separator: "@").first ?? "") : name
        let parts = base.split(whereSeparator: { " ._-".contains($0) }).prefix(2)
        let letters = parts.compactMap(\.first).map(String.init).joined().uppercased()
        return ZStack {
            Circle().fill(Avatar.color(for: name))
            Text(letters.isEmpty ? "?" : letters)
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(.white)
        }
    }

    // Muted, Flow-like colors (never neon).
    static func color(for name: String) -> Color {
        let palette: [UInt32] = [0x3d6fb6, 0x513595, 0x7a2854, 0x8e5a1f, 0x145866, 0x2f3d8f, 0x3f6e46, 0x5c3a1e]
        let sum = name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xffff }
        return Color(UIColor(rgb: palette[sum % palette.count]))
    }

    private static func decode(_ s: String) -> Data? {
        guard s.hasPrefix("data:image/"), let comma = s.firstIndex(of: ",") else { return nil }
        return Data(base64Encoded: String(s[s.index(after: comma)...]))
    }
}

struct AvatarStack: View {
    let people: [FlowPerson]
    var size: CGFloat = 20

    var body: some View {
        HStack(spacing: -size * 0.3) {
            ForEach(people.prefix(3)) { Avatar(name: $0.name, image: $0.image, size: size) }
            if people.count > 3 {
                Text("+\(people.count - 3)")
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(Theme.muted)
                    .frame(width: size, height: size)
                    .background(Theme.hover, in: .circle)
            }
        }
    }
}

// "Today", "Tomorrow", "Friday", "3d overdue", "Dec 1"; danger when overdue, warn when today or tomorrow.
struct DueLabel: View {
    let due: String
    var done = false

    var body: some View {
        if let info = DueLabel.describe(due) {
            HStack(spacing: 3) {
                Image(systemName: info.days < 0 ? "exclamationmark.circle" : "calendar").imageScale(.small)
                Text(info.text)
            }
            .font(.caption.weight(info.days <= 1 ? .semibold : .regular))
            .foregroundStyle(done ? Theme.faint : info.days < 0 ? Theme.danger : info.days <= 1 ? Theme.warn : Theme.muted)
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

struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

// Checklist progress: "☑ 2/5", green when complete.
struct ChecklistProgress: View {
    let done: Int
    let total: Int

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: done == total ? "checkmark.square.fill" : "checkmark.square").imageScale(.small)
            Text("\(done)/\(total)")
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(done == total ? Theme.accent : Theme.muted)
    }
}

// The brand mark (the app icon artwork).
struct FlowMark: View {
    var size: CGFloat = 72

    var body: some View {
        Image("Logo")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
    }
}

extension BoardColumn {
    var shortTitle: String {
        switch self {
        case .must: "Must Have"
        case .nice: "Nice to Have"
        case .requests: "Requests"
        default: title
        }
    }

    // The one obvious next step from this column, shown as the card's main button.
    var nextStep: (title: String, to: BoardColumn, systemImage: String)? {
        switch self {
        case .requests, .must, .nice: ("Start", .doing, "play.fill")
        case .doing: ("Send to UAT", .uat, "checkmark.seal")
        case .blocked: ("Unblock", .doing, "arrow.uturn.forward")
        case .uat: ("Approve", .done, "checkmark")
        case .done: nil
        }
    }
}
