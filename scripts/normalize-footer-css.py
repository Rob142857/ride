from pathlib import Path
import re

path = Path('c:/Users/RobertEvans/Downloads/Ride/public/trip.html')
src = path.read_text()

# Insert space between hex colour and percentage stop
src = re.sub(r'(?<=#[0-9a-fA-F]{6})(\d+%)', r' \1', src)

# Missing-space typos discovered in the footer block
src = re.sub(r'transform\s*0\.4s', 'transform 0.4s', src)
src = re.sub(r'transform\s*0\.2s', 'transform 0.2s', src)
src = re.sub(r'box-shadow\s*0\.2s', 'box-shadow 0.2s', src)
src = re.sub(r'background-size\s*:\s*220%\s*220%', 'background-size: 220%220%', src)
src = re.sub(r'background-position\s*:\s*0%', 'background-position: 0%', src)
src = re.sub(r'background-position\s*:\s*220%\s+center', 'background-position: 220% center', src)
src = re.sub(r'padding\s*:\s*12px\s*24px', 'padding: 12px 24px', src)
src = re.sub(r'padding\s*:\s*6px\s*14px', 'padding: 6px 14px', src)
src = re.sub(r'margin-bottom\s*:\s*24px', 'margin-bottom: 24px', src)
src = re.sub(r'border\s*:\s*1px\s+solid', 'border:1px solid', src)
src = re.sub(r'border-bottom\s*:\s*1px\s+solid', 'border-bottom: 1px solid', src)
src = re.sub(r'width\s*:\s*40px', 'width: 40px', src)
src = re.sub(r'font-size\s*:\s*0\.82rem', 'font-size: 0.82rem', src)
src = re.sub(r'animation-duration\s*:\s*2s', 'animation-duration: 2s', src)
src = re.sub(r'animation\s*:\s*wordmark-shimmer\s*6s', 'animation: wordmark-shimmer6s', src)
src = re.sub(r'wordmark-shimmer6s', 'wordmark-shimmer 6s', src)
src = re.sub(r'drop-shadow\s*\(\s*0\s*1px\s*1px', 'drop-shadow(0 1px 1px', src)
src = re.sub(r'drop-shadow\s*\(\s*0\s*0\s*10px', 'drop-shadow(0010px', src)
src = re.sub(r'text-shadow\s*:\s*0\s*1px0', 'text-shadow:01px 0', src)
src = re.sub(r',\s*0+\s*18px\s+rgba', ',0018px rgba', src)

path.write_text(src)
print('Normalized footer CSS spacing and malformed tokens.')
