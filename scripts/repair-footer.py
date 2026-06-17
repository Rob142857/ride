from pathlib import Path
import re

path = Path('c:/Users/RobertEvans/Downloads/Ride/public/trip.html')
src = path.read_text()

# Generic fixes for malformed footer CSS in public/trip.html.
# These patterns insert missing spaces without copying broken values back in.

#1. Hex colour immediately followed by percentage stop -> space
src = re.sub(r'(?<=#[0-9a-fA-F]{6})(\d+%)', r' \1', src)

# 2. Missing space between adjacent dims/durations: e.g. "12px24px", "6px14px"
src = re.sub(r'(\d)(px|em|rem|vh|vw|s|ms)\s*(\d)', r'\1\2 \3', src)

# 3. No-space construction phrases in transition/animation properties
src = re.sub(r'transform\s*(0\.\d+s)', r'transform \1', src)
src = re.sub(r'box-shadow\s*(0\.\d+s)', r'box-shadow \1', src)
src = re.sub(r'background-position\s*:\s*(0%|50%|100%)', r'background-position: \1', src)

# 4. drop-shadow missing space between offset values
src = re.sub(r'drop-shadow\(\s*(0)\s+(1px)(\d+px)', r'drop-shadow(\1 \2 \3', src)

# 5. rgba comma spacing: rgba(124,58,237 -> rgba(124, 58,237
src = re.sub(r'rgba\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})', r'rgba(\1, \2, \3', src)

# 6. text-shadow comma missing space after comma (specific current line)
src = re.sub(r'(rgba\([^)]+\)),\s*(\d)', r'\1, \2', src)

# 7. background-size 220% 220% ensure single space already ok, but remove double spaces generally
src = re.sub(r' {2,}', ' ', src)

# 8. Missing space after colon when value starts at column immediately after colon
# Only for common properties in footer, leave others alone
for prop in ['width', 'height', 'margin-top', 'padding', 'font-size', 'font-weight', 'border']:
    src = re.sub(rf'({prop}): ', r'\1: ', src)
    src = re.sub(rf'({prop}):(\S)', r'\1: \2', src)

# 9. Missing space between percentage and comma in gradient stop lists
src = re.sub(r'(\d+%),', r'\1,', src)

# 10. Missing space between value and unit adjacent to comma: e.g. "#22c55e 78%, #f59e0b100%"
src = re.sub(r'(\d)% ', r'\1% ', src)

path.write_text(src)
print('Repaired footer CSS spacing.')
