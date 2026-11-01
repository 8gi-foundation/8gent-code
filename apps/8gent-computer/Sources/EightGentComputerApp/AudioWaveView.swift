import SwiftUI

/// Static placeholder waveform. Real animation arrives in Phase 2.4.
/// Bars use neutral / amber tones (no hue 270 to 350 per BRAND.md).
struct AudioWaveView: View {
    private let heights: [CGFloat] = [0.35, 0.65, 0.45, 0.85, 0.55, 0.95, 0.50, 0.70, 0.40]
    private let barWidth: CGFloat = 4
    private let barSpacing: CGFloat = 4

    var body: some View {
        GeometryReader { geo in
            HStack(alignment: .center, spacing: barSpacing) {
                ForEach(heights.indices, id: \.self) { i in
                    Capsule()
                        .fill(barColor(for: i))
                        .frame(width: barWidth, height: max(2, geo.size.height * heights[i]))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .center)
        }
        .accessibilityHidden(true)
    }

    private func barColor(for index: Int) -> Color {
        // Warm amber / gold palette. No purple / pink / violet.
        let palette: [Color] = [
            Color(red: 0.93, green: 0.71, blue: 0.27),
            Color(red: 0.86, green: 0.55, blue: 0.18),
            Color(red: 0.78, green: 0.46, blue: 0.13)
        ]
        return palette[index % palette.count].opacity(0.85)
    }
}
