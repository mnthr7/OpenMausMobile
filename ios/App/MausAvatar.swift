// The bot's face.
//
// The desktop draws SupaMaus mascots; this is the phone's small, static
// cousin — a coloured blob with two eyes, at whatever size the row needs.
// The palette is copied verbatim from `src/lib/mascot.ts` rather than
// approximated, because a bot the user knows as "the orange one" should be
// the same orange on both screens.
import SwiftUI

enum MausPalette {
    /// src/lib/mascot.ts — MAUS_COLORS
    private static let hex: [String: String] = [
        "green": "#009957",
        "blue": "#377FE6",
        "red": "#D94B52",
        "orange": "#E78531",
        "purple": "#8057C8",
        "cyan": "#0EA5C6",
        "pink": "#D84F8B",
        "yellow": "#D8A729",
        "teal": "#01A492",
        "coral": "#E5634E",
    ]

    static func color(_ name: String) -> Color {
        Color(hex: hex[name] ?? "#8E8E93")
    }
}

extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&value)
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }
}

struct MausAvatar: View {
    let color: String
    var size: CGFloat = 52

    var body: some View {
        ZStack {
            Circle().fill(MausPalette.color(color))

            // The eyes are holes, not dark shapes: punching them out lets
            // whatever is behind show through, so the face reads correctly
            // in light and dark without needing to know which it is.
            HStack(spacing: size * 0.17) {
                eye
                eye
            }
            .offset(y: -size * 0.02)
            .blendMode(.destinationOut)
        }
        .compositingGroup()
        .frame(width: size, height: size)
    }

    private var eye: some View {
        Capsule()
            .frame(width: size * 0.115, height: size * 0.2)
    }
}

/// The person, rather than a bot — the roster's top-left button.
struct ProfileAvatar: View {
    let name: String
    var size: CGFloat = 34

    var body: some View {
        Circle()
            .fill(MausPalette.color("green"))
            .frame(width: size, height: size)
            .overlay {
                Text(initial)
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(.white)
            }
    }

    private var initial: String {
        String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
    }
}
