// GET /api/qr?room=123456  ->  SVG QR code linking to /play?room=123456
import QRCode from 'qrcode';

// The link the QR code points to. On Vercel the proxy sets x-forwarded-*; the
// local dev server has no proxy, so fall back to the real socket scheme (http)
// instead of assuming https, which phones can't reach on `npm run dev`.
export function joinUrl(req) {
  const url = new URL(req.url, 'http://local');
  const room = (url.searchParams.get('room') || '').replace(/\D/g, '').slice(0, 6);
  const first = (v) => String(v || '').split(',')[0].trim();
  const host = first(req.headers['x-forwarded-host']) || req.headers.host;
  const proto = first(req.headers['x-forwarded-proto']) || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}/play${room ? `?room=${room}` : ''}`;
}

export default async function handler(req, res) {
  const svg = await QRCode.toString(joinUrl(req), {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
  res.setHeader('content-type', 'image/svg+xml');
  res.setHeader('cache-control', 'public, max-age=3600');
  res.end(svg);
}
