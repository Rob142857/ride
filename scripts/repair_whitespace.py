import re
import sys
from pathlib import Path

SPACE = chr(32)

CSS_REPLACEMENTS = [
    ("padding:6px10px;", "padding: 6px" + SPACE + "10px;"),
    ("flex:00 auto;", "flex:00 auto;"),
    ("padding:0;", "padding: 0;"),
    ("width:28px;", "width:28px;"),
    ("height:16px;", "height: 16px;"),
    ("height: 28px", "height: 28px"),
    ("border-radius:12px;", "border-radius: 12px;"),
    ("min-height:0;", "min-height: 0;"),
    ("rgba(255,255, 255,", "rgba(255, 255, 255,"),
    ("rgba(233,69, 96,", "rgba(233, 69, 96,"),
    ("rgba(233, 69,96,", "rgba(233, 69, 96,"),
    ("rgba(233,69, 96,", "rgba(233, 69, 96,"),
    ("rgba(233, 69,96,0.5)", "rgba(233, 69, 96, 0.5)"),
]

JS_REPLACEMENTS = [
    ("let startY =0;", "let startY =0;"),
    ("??0", "??0"),
    ("const threshold =60;", "const threshold =60;"),
    (">0)", "> 0)"),
    ("invalidateSize(),350", "invalidateSize(),350"),
    ("invalidateSize(),100", "invalidateSize(), 100"),
    ("viewBox=\"0 02424\"", "viewBox=\"0 02424\""),
    ("d=\"M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm611h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z\"",
     "d=\"M516h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z\""),
    ("d=\"M714H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm127h-3v2h5v-5h-2v3zM145v2h3v3h2V5h-5z\"",
     "d=\"M714H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z\""),
    ("const parts =[];", "const parts = [];"),
    ("/1000;", "/1000;"),
    ("/100)", "/ 100)"),
    ("/60);", "/ 60);"),
    ("<86400000", "< 86400000"),
    ("10)", "10)"),
    ("3000)", "3000)"),
]

def repair_file(path, replacements):
    text = path.read_text(encoding="utf-8")
    original = text
    for needle, replacement in replacements:
        text = text.replace(needle, replacement)
    if text != original:
        path.write_text(text, encoding="utf-8")
        print("Repaired", path)
    else:
        print("No changes", path)

if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    repair_file(root / "public" / "css" / "app.css", CSS_REPLACEMENTS)
    repair_file(root / "public" / "js" / "ui.js", JS_REPLACEMENTS)
