import ast, os, re, sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)  # this file lives in src/, project root is one up
DEFAULT_OUT = os.path.join(PROJECT_ROOT, "REPOMAP.md")

ROOT = sys.argv[1] if len(sys.argv) > 1 else PROJECT_ROOT
OUT = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT

def short_doc(node):
    doc = ast.get_docstring(node)
    if not doc:
        return ""
    first_line = " ".join(doc.strip().split())
    if len(first_line) > 90:
        first_line = first_line[:87].rstrip() + "..."
    return f" — {first_line}"

def fmt_args(args: ast.arguments):
    parts = []
    defaults = [None] * (len(args.args) - len(args.defaults)) + list(args.defaults)
    for a, d in zip(args.args, defaults):
        name = a.arg
        if a.annotation:
            name += f": {ast.unparse(a.annotation)}"
        if d is not None:
            name += f" = {ast.unparse(d)}"
        parts.append(name)
    if args.vararg:
        parts.append("*" + args.vararg.arg)
    if args.kwonlyargs:
        for a, d in zip(args.kwonlyargs, args.kw_defaults):
            name = a.arg
            if a.annotation:
                name += f": {ast.unparse(a.annotation)}"
            if d is not None:
                name += f" = {ast.unparse(d)}"
            parts.append(name)
    if args.kwarg:
        parts.append("**" + args.kwarg.arg)
    return ", ".join(parts)

def ret_ann(node):
    if node.returns:
        return f" -> {ast.unparse(node.returns)}"
    return ""

def process_file(path, rel):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError as e:
        return f"### {rel}\n(parse error: {e})\n"

    lines = [f"### {rel}"]

    mod_doc = ast.get_docstring(tree)
    if mod_doc:
        lines.append(f"> {mod_doc.strip().splitlines()[0].strip()}")

    imports = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            imports += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            imports.append(mod)
    local_imports = sorted(set(i for i in imports if not _is_stdlib(i)))
    if local_imports:
        lines.append(f"deps: {', '.join(local_imports)}")

    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            bases = ", ".join(ast.unparse(b) for b in node.bases) if node.bases else ""
            head = f"class {node.name}" + (f"({bases})" if bases else "")
            lines.append(f"- {head}{short_doc(node)}")
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if sub.name == "__init__":
                        continue
                    prefix = "async def" if isinstance(sub, ast.AsyncFunctionDef) else "def"
                    lines.append(
                        f"    - {prefix} {sub.name}({fmt_args(sub.args)}){ret_ann(sub)}{short_doc(sub)}"
                    )
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
            lines.append(
                f"- {prefix} {node.name}({fmt_args(node.args)}){ret_ann(node)}{short_doc(node)}"
            )

    return "\n".join(lines) + "\n"

def process_html(path, rel):
    with open(path, encoding="utf-8") as f:
        src = f.read()

    lines = [f"### {rel}"]

    # --- CSS: just selectors from <style> blocks ---
    style_blocks = re.findall(r"<style[^>]*>(.*?)</style>", src, re.S | re.I)
    selectors = []
    for block in style_blocks:
        block = re.sub(r"/\*.*?\*/", "", block, flags=re.S)  # strip comments
        for m in re.finditer(r"([^{}]+)\{", block):
            sel = " ".join(m.group(1).split())
            if sel and not sel.startswith("@"):
                selectors.append(sel)
    if selectors:
        uniq = sorted(set(selectors))
        lines.append(f"CSS selectors ({len(uniq)}): " + ", ".join(uniq[:40]) +
                     (" ..." if len(uniq) > 40 else ""))

    # --- HTML markup: elements carrying id/class, deduped, no full attrs ---
    tags = re.findall(r"<(\w+)((?:\s+[\w-]+=\"[^\"]*\")*)\s*/?>", src)
    markup = []
    for tag, attrs in tags:
        if tag.lower() in ("script", "style", "meta", "link", "br"):
            continue
        id_m = re.search(r'id="([^"]+)"', attrs)
        class_m = re.search(r'class="([^"]+)"', attrs)
        label = f"<{tag}"
        if id_m:
            label += f" id={id_m.group(1)}"
        if class_m:
            label += f" class=\"{class_m.group(1)}\""
        label += ">"
        if id_m or class_m:
            markup.append(label)
    if markup:
        uniq_markup = list(dict.fromkeys(markup))  # dedupe, keep order
        lines.append(f"Key elements ({len(uniq_markup)}): " + ", ".join(uniq_markup[:40]) +
                     (" ..." if len(uniq_markup) > 40 else ""))

    # --- JS: function signatures from <script> blocks (non-src) ---
    script_blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", src, re.S | re.I)
    js_funcs = []
    for block in script_blocks:
        # function foo(a, b) {
        js_funcs += re.findall(r"function\s+(\w+)\s*\(([^)]*)\)", block)
        # const foo = (a, b) => {   /   const foo = function(a,b){
        js_funcs += [
            (name, args) for name, args in
            re.findall(r"(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>", block)
        ]
        js_funcs += [
            (name, args) for name, args in
            re.findall(r"(?:const|let|var)\s+(\w+)\s*=\s*function\s*\(([^)]*)\)", block)
        ]
    if js_funcs:
        seen = set()
        sigs = []
        for name, args in js_funcs:
            if name in seen:
                continue
            seen.add(name)
            args_clean = " ".join(args.split())
            sigs.append(f"{name}({args_clean})")
        lines.append(f"JS functions ({len(sigs)}): " + ", ".join(sigs))

    if not style_blocks and not tags and not script_blocks:
        lines.append("(no CSS/markup/JS detected)")

    return "\n".join(lines) + "\n"

STDLIB = {
    "os","sys","json","time","datetime","logging","threading","asyncio","re","math",
    "collections","itertools","functools","typing","pathlib","subprocess","socket",
    "queue","dataclasses","enum","abc","io","csv","struct","traceback","argparse",
    "signal","copy","random","uuid","hashlib","shutil","glob","warnings","contextlib",
}
def _is_stdlib(mod):
    top = mod.split(".")[0]
    return top in STDLIB or top == ""

def main():
    py_files, html_files = [], []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in (".git", "__pycache__", "vendor", "node_modules")]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT)
            if fn.endswith(".py"):
                py_files.append((full, rel))
            elif fn.endswith((".html", ".htm")):
                html_files.append((full, rel))
    py_files.sort(key=lambda x: x[1])
    html_files.sort(key=lambda x: x[1])

    out = ["# Repo Map\n"]
    # tree
    out.append("## Structure")
    out.append("```")
    for _, rel in py_files + html_files:
        out.append(rel)
    out.append("```\n")

    if py_files:
        out.append("## Python Symbols\n")
        for full, rel in py_files:
            out.append(process_file(full, rel))

    if html_files:
        out.append("## Web Files (HTML/CSS/JS)\n")
        for full, rel in html_files:
            out.append(process_html(full, rel))

    text = "\n".join(out)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"wrote {OUT} ({len(text)} chars, ~{len(text)//4} tokens)")

if __name__ == "__main__":
    main()
