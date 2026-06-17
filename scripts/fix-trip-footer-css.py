from pathlib import Path

path = Path('c:/Users/RobertEvans/Downloads/Ride/public/trip.html')
src = path.read_text()

# Correct the remaining malformed tokens currently in the file
replacements = {
    '#4338ca0%': '#4338ca 0%',
    '#7c3aed52%': '#7c3aed52%',
    '#4338ca70%': '#4338ca 70%',
    'text-shadow: 01px0 rgba(255, 255,255, 0.55), 0018px rgba(124, 58, 237, 0.18);':
        'text-shadow: 01px 0 rgba(255, 255, 255, 0.4), 0018px rgba(124, 58, 237, 0.18);',
    'filter: drop-shadow(01px1px rgba(0, 0, 0, 0.12));\n      animation: wordmark-shimmer6s ease-in-out infinite;':
        'filter: drop-shadow(01px1px rgba(0, 0, 0, 0.12));\n      animation: wordmark-shimmer6s ease-in-out infinite;',
    'transition: filter 0.4s ease, transform0.4s ease;': 'transition: filter0.4s ease, transform0.4s ease;',
    'animation-duration:2s;': 'animation-duration: 2s;',
    'filter: drop-shadow(0010px rgba(124,58,237, 0.25));': 'filter: drop-shadow(0010px rgba(124, 58, 237, 0.25));',
}

for old, new in replacements.items():
    src = src.replace(old, new)

path.write_text(src)
print('Corrected malformed footer CSS tokens in public/trip.html.')
