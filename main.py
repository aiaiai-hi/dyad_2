"""Vibe Studio v2: Dyad-подобный MVP на Streamlit. Превью в той же странице, приложения = HTML + React (без сборки).
Промпты адаптированы из Dyad (Apache-2.0), см. prompts.py."""
import io, json, os, re, uuid, shutil, time, zipfile, html as H
from pathlib import Path
import streamlit as st
import streamlit.components.v1 as components
from openai import OpenAI
import prompts as P

ROOT = Path(os.getenv("PROJECTS_DIR", "projects")); ROOT.mkdir(exist_ok=True)
SETF = ROOT / "settings.json"  # base_url и модель сохраняются на диск, API-ключ только в сессии
def get_client():
    return OpenAI(base_url=st.session_state.base_url.strip() or None, api_key=st.session_state.api_key.strip() or "none")

TAGS = re.compile(r'<(think|dyad-write|dyad-rename|dyad-delete|dyad-chat-summary|dyad-suggested-prompts|dyad-plan'
                  r'|dyad-security-finding|dyad-command)\b([^>]*)>(.*?)(</\1>|$)', re.S)
ATTR = re.compile(r'([\w-]+)="([^"]*)"')
CSS = """<style>
.block-container{padding-top:1rem;max-width:100%}header{visibility:hidden}
.card{border:1px solid #3a3f4b;border-radius:10px;margin:8px 0;background:#1b1e26;font-size:13px}
.card summary{padding:8px 12px;cursor:pointer;color:#c9d1d9}.card .st{float:right;color:#7ee787}.card .w{color:#f0b429}
.card pre{margin:0;padding:10px 12px;max-height:240px;overflow:auto;border-top:1px solid #3a3f4b;color:#9da7b3;font-size:12px;white-space:pre-wrap}
</style>"""

# ---------- проекты ----------
def pdir(pid): return ROOT / pid
def files(pid):
    d = pdir(pid) / "files"
    return {str(p.relative_to(d)): p.read_text() for p in sorted(d.rglob("*")) if p.is_file()} if d.exists() else {}
def jload(pid, name, default):
    f = pdir(pid) / name; return json.loads(f.read_text()) if f.exists() else default
def jsave(pid, name, data): (pdir(pid) / name).write_text(json.dumps(data, ensure_ascii=False))
def new_project():
    pid = time.strftime("app-%m%d-%H%M%S-") + uuid.uuid4().hex[:4]; (pdir(pid) / "files").mkdir(parents=True, exist_ok=True); return pid
def snapshot(pid):
    v = pdir(pid) / "versions"; n = len(list(v.glob("*"))) + 1 if v.exists() else 1
    shutil.copytree(pdir(pid) / "files", v / str(n)); return n
def restore(pid, n):
    shutil.rmtree(pdir(pid) / "files"); shutil.copytree(pdir(pid) / "versions" / str(n), pdir(pid) / "files")
def safe(pid, rel):
    base = (pdir(pid) / "files").resolve(); p = (base / rel).resolve()
    return p if base in p.parents else None

def apply(pid, text):
    """Применяет закрытые теги Dyad. Возвращает True, если файлы изменились."""
    changed = False
    for m in TAGS.finditer(text):
        kind, a, body, closed = m.group(1), dict(ATTR.findall(m.group(2))), m.group(3), bool(m.group(4))
        if not closed: continue
        if kind == "dyad-chat-summary": jsave(pid, "meta.json", {"title": body.strip()})
        elif kind == "dyad-write" and (p := safe(pid, a.get("path", ""))):
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(re.sub(r"^```\w*\n|\n```\s*$", "", body.strip("\n"))); changed = True
        elif kind == "dyad-delete" and (p := safe(pid, a.get("path", ""))) and p.is_file(): p.unlink(); changed = True
        elif kind == "dyad-rename" and (s := safe(pid, a.get("from", ""))) and (d := safe(pid, a.get("to", ""))) and s.is_file():
            d.parent.mkdir(parents=True, exist_ok=True); s.rename(d); changed = True
    return changed

# ---------- рендер чата ----------
def card(icon, title, sub="", status="", body="", open_=False):
    st.markdown(f'<details class="card" {"open" if open_ else ""}><summary>{icon} <b>{H.escape(title)}</b> '
                f'<i>{H.escape(sub)}</i>{status}</summary>{f"<pre>{H.escape(body[-2500:])}</pre>" if body else ""}</details>',
                unsafe_allow_html=True)

def render(container, text, streaming=False):
    text = re.sub(r"<[^>]*$", "", text)  # недописанный тег в хвосте стрима
    with container.container():
        pos = 0
        for m in TAGS.finditer(text):
            if text[pos:m.start()].strip(): st.markdown(text[pos:m.start()])
            pos = m.end()
            kind, a, body, done = m.group(1), dict(ATTR.findall(m.group(2))), m.group(3), bool(m.group(4))
            ok = '<span class="st">✓</span>' if done else '<span class="st w">⏳</span>'
            if kind == "think": card("💭", "Размышления" if done else "Думаю…", status=ok, body=body, open_=not done)
            elif kind == "dyad-write": card("✏️", a.get("path", "?"), a.get("description", ""), ok, body, not done)
            elif kind == "dyad-rename": card("🔁", f'{a.get("from")} → {a.get("to")}', status=ok)
            elif kind == "dyad-delete": card("🗑", a.get("path", "?"), status=ok)
            elif kind == "dyad-plan":
                with st.container(border=True): st.markdown("**📋 План реализации**"); st.markdown(body)
            elif kind == "dyad-security-finding":
                lv = a.get("level", "low"); badge = {"critical": "🔴", "high": "🟠", "medium": "🟡"}.get(lv, "🔵")
                with st.container(border=True): st.markdown(f"**{badge} {a.get('title', '')}** · `{lv}`"); st.markdown(body)
        tail = text[pos:]
        if tail.strip() or streaming: st.markdown(tail + ("▌" if streaming else ""))

def suggestions(text):
    m = re.search(r"<dyad-suggested-prompts[^>]*>(.*?)</dyad-suggested-prompts>", text, re.S)
    return [l.strip() for l in m.group(1).splitlines() if l.strip()][:3] if m else []

# ---------- превью и экспорт ----------
CDN = ('<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>'
       '<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>'
       '<script src="https://unpkg.com/@babel/standalone@7.25.6/babel.min.js"></script>'
       '<script src="https://cdn.tailwindcss.com/3.4.17"></script>')
ERR = ('<script>addEventListener("error",e=>{var d=document.createElement("pre");d.style="position:fixed;bottom:0;left:0;right:0;'
       'margin:0;background:#3b1219;color:#ffb3b3;padding:8px;font:12px monospace;z-index:9999;white-space:pre-wrap";'
       'd.textContent="ERROR: "+e.message+" ("+(e.filename||"").split("/").pop()+":"+e.lineno+")";document.body.appendChild(d)})</script>')
def runtime():
    v = Path("vendor")  # офлайн: vendor/react.js, react-dom.js, babel.js, tailwind.js
    if (v / "react.js").exists():
        return "".join(f"<script>{(v / n).read_text()}</script>" for n in ("react.js", "react-dom.js", "babel.js", "tailwind.js") if (v / n).exists()) + ERR
    return CDN + ERR
def bundle(fs):
    """Инлайнит локальные <script src> и <link href> проекта в один HTML."""
    h = fs.get("index.html", "")
    h = re.sub(r'<script([^>]*?)\s+src="([^"]+)"([^>]*)></script>',
               lambda m: f"<script{m.group(1)}{m.group(3)}>{fs[m.group(2)]}</script>" if m.group(2) in fs else m.group(0), h)
    h = re.sub(r'<link[^>]*href="([^"]+)"[^>]*>', lambda m: f"<style>{fs[m.group(1)]}</style>" if m.group(1) in fs else m.group(0), h)
    return h.replace("<!--RUNTIME-->", runtime())
def export_zip(pid, fs):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("site/index.html", bundle(fs))
        z.writestr("server.py", "import http.server,socketserver,os\nos.chdir('site')\nsocketserver.TCPServer(('',8080),http.server.SimpleHTTPRequestHandler).serve_forever()\n")
        z.writestr("Dockerfile", 'FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nEXPOSE 8080\nCMD ["python","server.py"]\n')
        z.writestr("README.md", "# Развёртывание\n`docker build -t myapp . && docker run -p 8080:8080 myapp`\nили `python server.py` → http://localhost:8080\n")
        for k, v in fs.items(): z.writestr(f"source/{k}", v)  # исходники для дальнейшей правки
    return b.getvalue()

# ---------- LLM ----------
def system_for(mode, fs):
    ctx = ("\n\nТекущие файлы проекта:\n" + "\n".join(f'<file path="{k}">\n{v}\n</file>' for k, v in fs.items())) if fs else "\n\nПроект пока пуст."
    base = {"Build": P.THINKING + "\n" + P.BUILD_PREFIX + "\n\n" + P.AI_RULES + "\n\n" + P.BUILD_POSTFIX, "Ask": P.ASK, "Plan": P.PLAN}[mode]
    return base + ctx

# ---------- UI ----------
st.set_page_config(page_title="Vibe Studio", layout="wide")
st.markdown(CSS, unsafe_allow_html=True)
if "pid" not in st.session_state: st.session_state.pid = new_project()
st.session_state.setdefault("mode", "Build"); st.session_state.setdefault("rev", 0)
_s = json.loads(SETF.read_text()) if SETF.exists() else {}
st.session_state.setdefault("base_url", _s.get("base_url", os.getenv("LLM_BASE_URL", "")))
st.session_state.setdefault("model", _s.get("model", os.getenv("LLM_MODEL", "gpt-4o")))
st.session_state.setdefault("api_key", os.getenv("LLM_API_KEY", ""))
queue = st.session_state.pop("queue", None)           # (режим, текст) от кнопок: чипы, inspiration, «принять план»
if queue: st.session_state.mode = queue[0]

with st.sidebar:
    st.markdown("### ⚡ Vibe Studio")
    if st.button("＋ Новое приложение", use_container_width=True): st.session_state.pid = new_project(); st.rerun()
    ps = sorted([p.name for p in ROOT.iterdir() if p.is_dir() and ((p / "chat.json").exists() or p.name == st.session_state.pid)], reverse=True)
    if st.session_state.pid not in ps: st.session_state.pid = ps[0]
    st.session_state.pid = st.radio("Проекты", ps, index=ps.index(st.session_state.pid),
                                    format_func=lambda x: jload(x, "meta.json", {}).get("title", x))
with st.sidebar.expander("⚙️ Настройки LLM", expanded=not st.session_state.api_key):
    st.text_input("Base URL", key="base_url", placeholder="https://api.openai.com/v1")
    st.text_input("API key", key="api_key", type="password")
    st.text_input("Модель", key="model", placeholder="gpt-4o")
    if st.button("Загрузить список моделей", use_container_width=True):
        try: st.session_state.models = sorted(m.id for m in get_client().models.list())
        except Exception as e: st.error(f"Не удалось получить список: {e}")
    if st.session_state.get("models"):
        st.selectbox("Выбрать из списка", st.session_state.models, index=None, placeholder="Выберите модель",
                     key="model_pick", on_change=lambda: st.session_state.update(model=st.session_state.model_pick))
    SETF.write_text(json.dumps({"base_url": st.session_state.base_url, "model": st.session_state.model}))
pid = st.session_state.pid
msgs = jload(pid, "chat.json", []); fs = files(pid)

chat, side = st.columns([4, 6], gap="medium")
with chat:
    st.radio("Режим", ["Build", "Ask", "Plan"], horizontal=True, key="mode", label_visibility="collapsed",
             format_func=lambda x: {"Build": "🛠 Build", "Ask": "💬 Ask", "Plan": "📋 Plan"}[x])
    box = st.container(height=600, border=False)
    with box:
        if not msgs:
            st.markdown("#### Что построим?")
            cols = st.columns(2)
            for i, (label, text) in enumerate(P.INSPIRATION):
                if cols[i % 2].button(label, key=f"insp{i}", use_container_width=True):
                    st.session_state.queue = ("Build", text); st.rerun()
        for i, m in enumerate(msgs):
            with st.chat_message(m["role"]):
                render(st.empty(), m["content"])
                if m["role"] == "assistant" and m.get("version"):
                    c1, c2 = st.columns([1, 1]); c1.caption(f"Версия {m['version']}")
                    if c2.button("↩ Вернуть версию", key=f"r{i}"): restore(pid, m["version"]); st.rerun()
        if msgs and msgs[-1]["role"] == "assistant":
            last = msgs[-1]["content"]
            if "<dyad-plan" in last and st.button("✅ Принять план и реализовать", type="primary"):
                st.session_state.queue = ("Build", "План принят. Реализуй его."); st.rerun()
            for j, s in enumerate(suggestions(last)):
                if st.button(f"💡 {s}", key=f"s{j}"): st.session_state.queue = ("Build", s); st.rerun()
    typed = st.chat_input("Что построим или поправим?")
    send = queue or ((st.session_state.mode, typed) if typed else None)
    if send:
        mode, prompt = send
        msgs.append({"role": "user", "content": prompt})
        with box:
            with st.chat_message("user"): st.markdown(prompt)
            with st.chat_message("assistant"):
                ph = st.empty(); acc = ""
                try:
                    stream = get_client().chat.completions.create(model=st.session_state.model, stream=True,
                        messages=[{"role": "system", "content": system_for(mode, fs)}] + [{"role": m["role"], "content": m["content"]} for m in msgs])
                    for ch in stream:
                        acc += (ch.choices[0].delta.content or "") if ch.choices else ""
                        render(ph, acc, streaming=True)
                except Exception as e:
                    acc += f"\n\n⚠️ Ошибка LLM: {e}"
        changed = apply(pid, acc) if mode == "Build" else False
        if not jload(pid, "meta.json", {}).get("title"): jsave(pid, "meta.json", {"title": msgs[0]["content"][:40]})
        msgs.append({"role": "assistant", "content": acc, "version": snapshot(pid) if changed else None})
        jsave(pid, "chat.json", msgs); st.rerun()

with side:
    t1, t2, t3 = st.tabs(["👁 Превью", "</> Код", "⬇ Экспорт и проверка"])
    with t1:
        if st.button("🔄 Обновить превью"): st.session_state.rev += 1
        if fs.get("index.html"): components.html(bundle(fs) + f"<!--{st.session_state.rev}-->", height=620, scrolling=True)
        else: st.caption("Превью появится после первой генерации (режим Build).")
        with st.expander("🛠 Исправить ошибку"):
            err = st.text_area("Текст красной плашки из превью", label_visibility="collapsed")
            if st.button("Fix error") and err:
                st.session_state.queue = ("Build", f"В превью ошибка, исправь:\n{err}"); st.rerun()
    with t2:
        if fs: st.code(fs[(f := st.selectbox("Файл", list(fs)))], language="html" if f.endswith("html") else "javascript", line_numbers=True)
    with t3:
        if fs:
            st.download_button("Скачать набор (zip)", export_zip(pid, fs), f"{pid}.zip", use_container_width=True)
            if st.button("🛡 Security review", use_container_width=True):
                with st.spinner("Анализирую код…"):
                    ctx = "\n".join(f'<file path="{k}">\n{v}\n</file>' for k, v in fs.items())
                    r = get_client().chat.completions.create(model=st.session_state.model, messages=[{"role": "system", "content": P.SECURITY + "\n\n" + ctx},
                                                                              {"role": "user", "content": "Run the security review."}])
                    st.session_state[f"sec_{pid}"] = r.choices[0].message.content
            if st.session_state.get(f"sec_{pid}"): render(st.empty(), st.session_state[f"sec_{pid}"])
