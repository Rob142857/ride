from pathlib import Path

path = Path('c:/Users/RobertEvans/Downloads/Ride/public/trip.html')
src = path.read_text()

start = src.find('.footer-brand-text {')
end = src.find('.footer-credits {')
if start ==-1 or end ==-1:
    print('markers not found')
    raise SystemExit

new_block = """    .footer-brand-text {
      font-family: 'Playfair Display', Georgia, 'Times New Roman', serif;
      font-style: italic;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.03em;
      color: #312e81;
      background: linear-gradient(
       105deg,
        #4338ca 0%, #5b21b6 18%, #4f46e5 34%,
        #7c3aed52%, #4338ca 70%, #4338ca 100%
      );
      background-size: 220% auto;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      -webkit-text-stroke: 0.45px rgba(67, 56, 202, 0.28);
      text-shadow: 01px0 rgba(255,255, 255, 0.55),0018px rgba(124, 58, 237, 0.18);
      filter: drop-shadow(01px1px rgba(0, 0, 0, 0.12));
      animation: wordmark-shimmer 6s ease-in-out infinite;
      transition: filter 0.4s ease, transform0.4s ease;
    }

    .footer-brand-text:hover {
      animation-duration: 2s;
      filter: drop-shadow(0010px rgba(124, 58, 237, 0.25));
      transform: scale(1.05);
    }

    @keyframes wordmark-shimmer {
0%   { background-position: -220% center; }
     100% { background-position: 220% center; }
    }

    .footer-tagline {
      color: var(--text-muted);
      font-size: 14px;
      margin-bottom:24px;
    }

    .footer-cta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      position: relative;
      background: linear-gradient(90deg, #ff5f7a 0%, #a855f730%, #3b82f655%, #22c55e 78%, #f59e0b 100%);
      background-size: 220%220%;
      background-position:0% 50%;
      color: #fff;
      border:1px solid rgba(0, 0, 0, 0.08);
      padding: 12px24px;
      border-radius: var(--radius-btn);
      font-weight: 600;
      text-decoration: none;
      transition: background-position 0.35s ease, transform 0.2s ease, box-shadow0.2s ease;
      box-shadow: none;
      overflow: hidden;
    }

    .footer-cta::after {
      content: '';
      position: absolute;
      inset: -2px;
      background: linear-gradient(120deg, transparent 0%, rgba(255, 255, 255, 0.35) 25%, transparent 50%);
      transform: translateX(-120%);
      transition: transform 0.5s ease;
      pointer-events: none;
    }

    .footer-cta:hover {
      transform: none;
      box-shadow: none;
      background-position: 100% 50%;
    }

    .footer-cta:hover::after {
      transform: translateX(120%);
    }

    .footer-open-source {
      position: relative;
      margin-top: 28px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding:6px14px;
      border-radius: 999px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    .footer-open-source::before {
      content: '';
      position: absolute;
      top: -14px;
      left: 50%;
      transform: translateX(-50%);
      width:40px;
      height: 1px;
      background: var(--border);
    }

    .footer-open-source a {
      color: var(--text-muted);
      text-decoration: none;
      border-bottom:1px solid rgba(0, 0, 0, 0.12);
      padding-bottom: 1px;
      transition: all 0.2s ease;
    }

    .footer-open-source a:hover {
      color: var(--text-primary);
      border-color: var(--text-primary);
    }

"""

src = src[:start] + new_block + src[end:]
path.write_text(src)
print('Rewrote clean footer CSS block in public/trip.html')
