// SVG used as the Windows taskbar overlay badge when there are unread messages.
// Returned as a string so the renderer/main can convert it via nativeImage.
export function overlayBadgeSvg(count: number): string | null {
  if (count <= 0) return null;
  const text = count > 99 ? '99+' : String(count);
  const fontSize = text.length > 2 ? 24 : 32;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">
    <circle cx="24" cy="24" r="22" fill="#DE5D83"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
          fill="#fff" font-family="-apple-system,Segoe UI,Roboto,sans-serif"
          font-size="${fontSize}" font-weight="700">${text}</text>
  </svg>`;
}
