// Draws macOS system symbols as square alpha masks so the renderer can tint them with CSS.
// Usage: aplos-symbols <scale> <name>:<box>:<point>:<weight> ...
// Prints one JSON object mapping each request to a PNG data URL; unknown symbols are omitted.
import AppKit

let weights: [String: NSFont.Weight] = [
  "ultralight": .ultraLight, "thin": .thin, "light": .light, "regular": .regular,
  "medium": .medium, "semibold": .semibold, "bold": .bold, "heavy": .heavy, "black": .black,
]

let args = Array(CommandLine.arguments.dropFirst())
guard let scaleText = args.first, let scale = Double(scaleText), scale > 0, scale <= 4 else {
  FileHandle.standardError.write("usage: aplos-symbols <scale> name:box:point:weight ...\n".data(using: .utf8)!)
  exit(2)
}

var out: [String: String] = [:]
for request in args.dropFirst() {
  let parts = request.split(separator: ":").map(String.init)
  guard parts.count == 4, let box = Double(parts[1]), let point = Double(parts[2]), box > 0, box <= 128, point > 0, point <= 128,
        let weight = weights[parts[3]] else { continue }
  let config = NSImage.SymbolConfiguration(pointSize: point, weight: weight, scale: .medium)
  guard let symbol = NSImage(systemSymbolName: parts[0], accessibilityDescription: nil)?.withSymbolConfiguration(config) else { continue }
  let pixels = Int((box * scale).rounded())
  guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                   bytesPerRow: 0, bitsPerPixel: 0) else { continue }
  rep.size = NSSize(width: box, height: box)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let size = symbol.size
  let rect = NSRect(x: (box - size.width) / 2, y: (box - size.height) / 2, width: size.width, height: size.height)
  symbol.draw(in: rect)
  NSColor.black.set()
  rect.fill(using: .sourceAtop)
  NSGraphicsContext.restoreGraphicsState()
  guard let png = rep.representation(using: .png, properties: [:]) else { continue }
  out[request] = "data:image/png;base64," + png.base64EncodedString()
}

let json = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
FileHandle.standardOutput.write(json)
