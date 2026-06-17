import re

with open('public/index.html','r',encoding='utf-8') as f:
    html = f.read()

# Find first waypoints help modal already ends gracefully.
# Remove the duplicate/stale second block plus any stray trailing </div> before Toast.
marker_start = '\n\n        <!-- Waypoints help modal -->'
marker_end = '\n\n    <!-- Toast notifications -->'

start = html.find(marker_start)
if start !=-1:
    end = html.find(marker_end, start)
    if end !=-1:
        html = html[:start] + marker_end + html[end + len(marker_end):]
        print('duplicate waypoints help modal removed')
    else:
        print('ERROR: toast marker not found after second modal')
        raise SystemExit(1)
else:
    print('second modal block not found; already clean')

with open('public/index.html','w',encoding='utf-8') as f:
    f.write(html)
print('saved')
