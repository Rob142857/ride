from pathlib import Path

path = Path('c:/Users/RobertEvans/Downloads/Ride/public/trip.html')
src = path.read_text()

# Correct the remaining malformed CSS tokens currently in public/trip.html.
# Search strings are pulled from the file; replacement strings are fully valid CSS.

# 1. wordmark text-shadow line
src = src.replace(
    'text-shadow:01px0 rgba(255, 255,255, 0.55),0018px rgba(124,58,237, 0.18);',
    'text-shadow:01px 0 rgba(255,255,255,0.55), 0018px rgba(124, 58,237, 0.18);'
)

#2. wordmark drop-shadow
src = src.replace(
    'filter: drop-shadow(01px 1px rgba(0, 0, 0,0.12));',
    'filter: drop-shadow(01px1px rgba(0, 0, 0, 0.12));'
)

#3. about link background/border rgba spacing
src = src.replace(
    'border-bottom:1px solid rgba(0, 0, 0,0.12);',
    'border-bottom: 1px solid rgba(0, 0,0, 0.12);'
)

path.write_text(src)
print('Applied final footer CSS corrections.')
