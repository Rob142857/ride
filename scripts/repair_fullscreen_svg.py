from pathlib import Path

file = Path(__file__).resolve().parent.parent / 'public' / 'js' / 'ui.js'
text = file.read_text(encoding='utf-8')

S = chr(32)  # literal ASCII space

# Target strings currently in the file (spaces preserved exactly as they appear)
old_exit = f'btn.innerHTML = \'<svg viewBox="0{S}024{S}24"><path d="M516h3v3h2v-5H5v2.zm3-8H5v2h5V5H8v3.zm6{S}11h2v-3h3v-2h-5v5.zm2-11V5h-2v5h5V8h-3.z"/></svg>\';'
old_enter = f'btn.innerHTML = \'<svg viewBox="0{S}024{S}24"><path d="M7{S}14H5v5h5v-2H7v-3.zm-2-4h2V7h3V5H5v5.zm12{S}7h-3v2h5v-5h-2v3.zM145v2h3v3h2V5h-5.z"/></svg>\';'

# Corrected SVG strings
new_exit = f'btn.innerHTML = \'<svg viewBox="0{S}0{S}24{S}24"><path d="M5{S}16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6{S}11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>\';'
new_enter = f'btn.innerHTML = \'<svg viewBox="0{S}0{S}24{S}24"><path d="M7{S}14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12{S}7h-3v2h5v-5h-2v3zM14{S}5v2h3v3h2V5h-5z"/></svg>\';'

assert old_exit in text, 'old_exit not found in ui.js'
assert old_enter in text, 'old_enter not found in ui.js'

text = text.replace(old_exit, new_exit)
text = text.replace(old_enter, new_enter)

file.write_text(text, encoding='utf-8')
print('Repaired fullscreen SVG strings in', file)
