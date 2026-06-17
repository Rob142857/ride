import re

# 1. Update public/index.html remaining old waypointsHelpModal block
with open('public/index.html','r',encoding='utf-8') as f:
    html = f.read()

new_help_block = '''    <!-- Waypoints help modal -->
    <div id="waypointsHelpModal" class="modal hidden">
      <div class="modal-content">
        <div class="modal-header">
          <h3>How to use Waypoints</h3>
          <button type="button" class="modal-close" data-close aria-label="Close">×</button>
        </div>
        <div class="waypoints-help-body waypoints-help-body--elegant">
          <div class="help-step">
            <strong>Add stops</strong>
            <span>Tap <em>Drop</em> or <em>Search</em> to build your route, or press anywhere on the map.</span>
          </div>
          <div class="help-step">
            <strong>Tour via a diamond</strong>
            <span>Drag a via diamond to a spot you wish to tour to, and a new waypoint will be added in the right sequence.</span>
          </div>
          <div class="help-step">
            <strong>Reorder & remove</strong>
            <span>Open a stop to edit, drag the handle to reorder, or delete one you no longer need.</span>
          </div>
          <div class="help-step">
            <strong>Undo & fit</strong>
            <span>Use the toolbar to undo or redo changes, and tap <em>Fit trip</em> to see your whole route.</span>
          </div>
          <div class="modal-actions">
            <button type="button" class="primary-btn" data-close>Got it</button>
          </div>
        </div>
      </div>
    </div>'''

# Pattern matches the old long-copy block (existing first block may already be updated)
pattern = re.compile(r'<!-- Waypoints help modal -->\s*<div id="waypointsHelpModal" class="modal hidden">\s*<div class="modal-content">\s*<div class="modal-header">\s*<h3>How to use Waypoints</h3>\s*<button type="button" class="modal-close" data-close aria-label="Close">×</button>\s*</div>\s*<div class="waypoints-help-body">.*?\s*</div>\s*</div>\s*</div>', re.DOTALL)
matches = list(pattern.finditer(html))
if len(matches) < 1:
    print('WARNING: no old modal block found; may already be updated')
    matches = []
else:
    target_match = matches[-1]
    html = html[:target_match.start()] + new_help_block + html[target_match.end():]
    with open('public/index.html','w',encoding='utf-8') as f:
        f.write(html)
    print('index.html updated')

# 2. Update body font in public/css/app.css
with open('public/css/app.css','r',encoding='utf-8') as f:
    css = f.read()

old_body_font = "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;"
new_body_font = "font-family: var(--font-sans);"
if old_body_font not in css:
    print('WARNING: expected body font stack not found; checking if already updated')
    if new_body_font not in css:
        print('ERROR: could not find either old or new body font stack in app.css')
        raise SystemExit(1)
else:
    css = css.replace(old_body_font, new_body_font, 1)
    print('app.css body font updated')

# 3. Append elegant styles after .waypoints-help-body .modal-actions rule
append_css = '''

/* Compact elegant help modal layout: fits one mobile screen */
.waypoints-help-body--elegant {
  gap:12px;
}

.help-step {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.help-step strong {
  color: var(--text-primary);
  font-weight: 600;
  font-size: 0.95rem;
}

.help-step span {
  color: var(--text-secondary);
  font-size: 0.9rem;
  line-height: 1.35;
}

@media (max-width: 380px) {
  .waypoints-help-body--elegant {
    gap: 10px;
  }
  .help-step span {
    font-size: 0.86rem;
    line-height: 1.3;
  }
}'''

anchor = '.waypoints-help-body .modal-actions {'
if anchor not in css:
    print('ERROR: .waypoints-help-body .modal-actions anchor not found')
    raise SystemExit(1)
idx = css.rfind(anchor)
block_end = css.find('}', idx)
if block_end == -1:
    print('ERROR: could not find end of anchor rule')
    raise SystemExit(1)
insert_pos = block_end + 1
if append_css.strip() not in css:
    css = css[:insert_pos] + append_css + css[insert_pos:]
    print('app.css elegant help styles added')
else:
    print('app.css elegant help styles already present')

with open('public/css/app.css','w',encoding='utf-8') as f:
    f.write(css)
print('app.css saved')
