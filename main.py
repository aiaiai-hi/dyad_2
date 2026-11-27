"""Vibe Studio: Python-движок (Streamlit) + интерфейс на HTML/JS в папке frontend/ (компонент без сборки).
Промпты адаптированы из Dyad (Apache-2.0), см. prompts.py."""
import base64, io, json, os, re, shutil, threading, time, uuid, zipfile
from pathlib import Path
import streamlit as st
import streamlit.components.v1 as components
from openai import OpenAI
import prompts as P

HERE = Path(__file__).parent
ROOT = Path(os.getenv("PROJECTS_DIR", HERE / "projects")); ROOT.mkdir(exist_ok=True)
SETF = ROOT / "settings.json"
studio = components.declare_component("vibe_studio", path=str(HERE / "frontend"))
S = st.session_state

TAGS = re.compile(r'<(think|dyad-write|dyad-rename|dyad-delete|dyad-chat-summary|dyad-suggested-prompts|dyad-plan'
                  r'|dyad-security-finding|dyad-command)\b([^>]*)>(.*?)(</\1>|$)', re.S)
ATTR = re.compile(r'([\w-]+)="([^"]*)"')

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

def lint(fs):
    """Быстрые проверки того, что чаще всего ломает приложение: дубли имён и ссылки на несуществующие файлы."""
    issues, seen = [], {}
    for k, c in fs.items():
        if k.endswith((".js", ".jsx")):
            for m in re.finditer(r"^(const|let|class|function|var)\s+(\w+)", c, re.M): seen.setdefault(m.group(2), []).append((k, m.group(1)))
    for n, ds in seen.items():
        if len(ds) > 1 and any(d[1] in ("const", "let", "class") for d in ds):
            issues.append(f"`{n}` объявлено повторно ({', '.join(sorted({d[0] for d in ds}))}); оставь ровно одно объявление")
    nrm = lambda x: re.sub(r"^\.?/", "", x)
    for ref in re.findall(r'<(?:script[^>]*src|link[^>]*href)="([^"]+)"', fs.get("index.html", "")):
        if not ref.startswith(("http", "//", "data:")) and nrm(ref) not in fs: issues.append(f"index.html ссылается на несуществующий файл {ref}")
    return issues

# ---------- превью и экспорт ----------
CDN = ('<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>'
       '<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>'
       '<script src="https://unpkg.com/@babel/standalone@7.25.6/babel.min.js"></script>'
       '<script src="https://cdn.tailwindcss.com/3.4.17"></script>')
ERR = r"""<script>(function(){
function show(t){var d=document.getElementById('__err');if(!d){d=document.createElement('pre');d.id='__err';d.style.cssText='position:fixed;bottom:0;left:0;right:0;max-height:45%;overflow:auto;margin:0;background:#3b1219;color:#ffb3b3;padding:10px;font:12px monospace;z-index:99999;white-space:pre-wrap';document.body.appendChild(d)}d.textContent+=t+"\n"}
var ce=console.error;console.error=function(){try{show('ERROR: '+[].slice.call(arguments).map(function(a){return a&&a.message?a.message:String(a)}).join(' '))}catch(e){}ce.apply(console,arguments)};
addEventListener('error',function(e){if(e.message&&e.message!=='Script error.')show('ERROR: '+e.message+' ('+(e.filename||'').split('/').pop()+':'+e.lineno+')')});
addEventListener('unhandledrejection',function(e){show('ERROR: '+(e.reason&&e.reason.message||e.reason))});
addEventListener('DOMContentLoaded',function(){if(!window.Babel)return;document.querySelectorAll('script[type="text/babel"]').forEach(function(s){try{Babel.transform(s.textContent,{presets:['react']})}catch(e){show('SYNTAX ['+(s.getAttribute('data-name')||'index.html')+']: '+e.message)}})});
})();</script>"""
def runtime():
    v = Path("vendor")  # офлайн: vendor/react.js, react-dom.js, babel.js, tailwind.js
    if (v / "react.js").exists():
        return "".join(f"<script>{(v / n).read_text()}</script>" for n in ("react.js", "react-dom.js", "babel.js", "tailwind.js") if (v / n).exists()) + ERR
    return CDN + ERR
def bundle(fs):
    """Инлайнит локальные <script src> и <link href> проекта в один HTML."""
    h = re.sub(r'<script[^>]*src="https?://[^"]*(?:tailwindcss|react|babel)[^"]*"[^>]*></script>', "", fs.get("index.html", ""))
    n = lambda x: re.sub(r"^\.?/", "", x)
    h = re.sub(r'<script([^>]*?)\s+src="([^"]+)"([^>]*)></script>',
               lambda m: f'<script{m.group(1)}{m.group(3)} data-name="{n(m.group(2))}">{fs[n(m.group(2))]}</script>' if n(m.group(2)) in fs else m.group(0), h)
    h = re.sub(r'<link[^>]*href="([^"]+)"[^>]*>', lambda m: f"<style>{fs[n(m.group(1))]}</style>" if n(m.group(1)) in fs else m.group(0), h)
    return h.replace("<!--RUNTIME-->", runtime())
VENDOR = ("react.js", "react-dom.js", "babel.js", "tailwind.js")
RUNNER = r"""
import os, re
from pathlib import Path
import streamlit as st
import streamlit.components.v1 as components

SITE = Path(__file__).parent / "site"
st.set_page_config(page_title=TITLE, layout="wide", initial_sidebar_state="collapsed")
st.markdown("<style>.block-container{padding:0!important;max-width:100%!important}header,footer,#MainMenu{visibility:hidden}</style>",
            unsafe_allow_html=True)

def runtime():
    v = SITE / "vendor"
    names = [n for n in ("react.js", "react-dom.js", "babel.js", "tailwind.js") if (v / n).exists()]
    if names: return "".join(f"<script>{(v / n).read_text()}</script>" for n in names) + ERR
    return CDN + ERR

@st.cache_data
def build():
    fs = {p.relative_to(SITE).as_posix(): p.read_text() for p in SITE.rglob("*") if p.is_file() and "vendor" not in p.parts}
    n = lambda x: re.sub(r"^\.?/", "", x)
    h = re.sub(r'<script[^>]*src="https?://[^"]*(?:tailwindcss|react|babel)[^"]*"[^>]*></script>', "", fs.get("index.html", ""))
    h = re.sub(r'<script([^>]*?)\s+src="([^"]+)"([^>]*)></script>',
               lambda m: f'<script{m.group(1)}{m.group(3)} data-name="{n(m.group(2))}">{fs[n(m.group(2))]}</script>' if n(m.group(2)) in fs else m.group(0), h)
    h = re.sub(r'<link[^>]*href="([^"]+)"[^>]*>',
               lambda m: f"<style>{fs[n(m.group(1))]}</style>" if n(m.group(1)) in fs else m.group(0), h)
    return h.replace("<!--RUNTIME-->", runtime())

components.html(build(), height=int(os.getenv("APP_HEIGHT", "900")), scrolling=True)
"""

def export_zip(pid, fs):
    """Пакет для развёртывания через Streamlit: main.py + site/ (исходники приложения) + requirements + Dockerfile + README."""
    title = jload(pid, "meta.json", {}).get("title", pid)
    v = Path("vendor"); have = [n for n in VENDOR if (v / n).exists()]
    main = f"TITLE = {title!r}\nCDN = {CDN!r}\nERR = {ERR!r}\n" + RUNNER
    net = "" if have else ("\n> ⚠️ React, Babel и Tailwind грузятся с CDN (unpkg, cdn.tailwindcss.com), нужен интернет.\n"
                           "> Для закрытой сети положите react.js, react-dom.js, babel.js, tailwind.js в `site/vendor/`: они подхватятся сами.\n")
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("main.py", main)
        z.writestr("requirements.txt", "streamlit>=1.40\n")
        for k, c in fs.items(): z.writestr(f"site/{k}", c)  # index.html сохраняет <!--RUNTIME-->, main.py подставляет React
        for n in have: z.write(v / n, f"site/vendor/{n}")
        z.writestr("Dockerfile", 'FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN pip install --no-cache-dir -r requirements.txt\n'
                   'EXPOSE 8501\nCMD ["streamlit","run","main.py","--server.port=8501","--server.address=0.0.0.0"]\n')
        z.writestr("README.md", f"""# {title}
Приложение для Streamlit. `main.py` читает папку `site/` (index.html, *.jsx, styles.css), собирает в один HTML и показывает на странице.
Интерфейс (React) работает в браузере, Python отдаёт страницу.
{net}
## Streamlit Community Cloud / внутренний Streamlit
Загрузите содержимое архива в репозиторий (рядом `main.py`, `requirements.txt`, папка `site/`), главный файл: `main.py`.

## Локально
    pip install -r requirements.txt
    streamlit run main.py

## Docker
    docker build -t myapp . && docker run -p 8501:8501 myapp

## Настройки
- Высота области приложения: переменная `APP_HEIGHT` (по умолчанию 900 пикселей).
- Правки кода: меняйте файлы в `site/`, затем перезапустите Streamlit (результат кэшируется).
- Данные приложение хранит в localStorage браузера: у каждого пользователя свои.
""")
    return b.getvalue()

# ---------- LLM ----------
def system_for(mode, fs):
    ctx = ("\n\nТекущие файлы проекта:\n" + "\n".join(f'<file path="{k}">\n{v}\n</file>' for k, v in fs.items())) if fs else "\n\nПроект пока пуст."
    base = {"Build": P.THINKING + "\n" + P.BUILD_PREFIX + "\n\n" + P.AI_RULES + "\n\n" + P.BUILD_POSTFIX, "Ask": P.ASK, "Plan": P.PLAN}[mode]
    return base + ctx

def preview_html(fs, pid):
    """HTML для превью; localStorage приложения изолируется по проекту (общий origin компонента)."""
    ns = ('<script>(function(){var p=%s+":",o=Storage.prototype,g=o.getItem,s=o.setItem,r=o.removeItem;'
          'o.getItem=function(k){return g.call(this,p+k)};o.setItem=function(k,v){return s.call(this,p+k,v)};'
          'o.removeItem=function(k){return r.call(this,p+k)}})()</script>') % json.dumps(pid)
    h = bundle(fs)
    return h.replace("<head>", "<head>" + ns, 1) if "<head>" in h else ns + h

# ---------- задачи LLM: поток идёт в фоне, интерфейс опрашивает состояние ----------
@st.cache_resource
def jobs(): return {}

def client(): return OpenAI(base_url=S.base_url.strip() or None, api_key=S.api_key.strip() or "none")

def run_llm(job, cl, model, system, history):
    try:
        for ch in cl.chat.completions.create(model=model, stream=True, messages=[{"role": "system", "content": system}] + history):
            if job["stop"]: break
            if ch.choices: job["text"] += ch.choices[0].delta.content or ""
    except Exception as e:
        job["text"] += f"\n\n⚠️ Ошибка LLM: {e}"
    job["done"] = True

def current_job():
    j = jobs().get(S.get("job"))
    if not j: S.job = None
    return j

def start_job(pid, mode, prompt):
    msgs = jload(pid, "chat.json", []) + [{"role": "user", "content": prompt}]; jsave(pid, "chat.json", msgs)
    job = {"text": "", "done": False, "stop": False, "pid": pid, "mode": mode, "prompt": prompt}
    jid = uuid.uuid4().hex; jobs()[jid] = job; S.job = jid
    hist = [{"role": m["role"], "content": m["content"]} for m in msgs]
    threading.Thread(target=run_llm, daemon=True, args=(job, client(), S.model, system_for(mode, files(pid)), hist)).start()

def finalize():
    """Если фоновая генерация закончилась: применить файлы, сохранить версию, при необходимости запустить автоисправление."""
    job = current_job()
    if not job or not job["done"]: return
    pid, acc = job["pid"], job["text"]
    changed = apply(pid, acc) if job["mode"] == "Build" else False
    msgs = jload(pid, "chat.json", [])
    if not jload(pid, "meta.json", {}).get("title"): jsave(pid, "meta.json", {"title": msgs[0]["content"][:40]})
    msgs.append({"role": "assistant", "content": acc, "version": snapshot(pid) if changed else None}); jsave(pid, "chat.json", msgs)
    jobs().pop(S.job, None); S.job = None
    issues = lint(files(pid)) if changed else []
    if issues and not job["prompt"].startswith("Автопроверка"):   # одна автоматическая попытка исправления
        start_job(pid, "Build", "Автопроверка нашла проблемы, исправь:\n- " + "\n- ".join(issues))

# ---------- состояние для интерфейса и обработка событий ----------
def plist(): return sorted([p.name for p in ROOT.iterdir() if p.is_dir() and ((p / "chat.json").exists() or p.name == S.pid)], reverse=True)

def build_state():
    pid = S.pid; fs = files(pid); job = current_job()
    return dict(projects=[{"id": p, "title": jload(p, "meta.json", {}).get("title", p)} for p in plist()], pid=pid,
                messages=jload(pid, "chat.json", []), files=fs, preview=preview_html(fs, pid) if fs.get("index.html") else "",
                busy=bool(job), live=job["text"] if job else "", inspiration=P.INSPIRATION, models=S.get("models", []),
                settings={"base_url": S.base_url, "model": S.model, "has_key": bool(S.api_key)},
                sec=S.get(f"sec_{pid}", ""), dl=S.pop("dl", None), notice=S.pop("notice", None))

def handle(ev):
    """Возвращает True, если состояние изменилось и интерфейс нужно перерисовать."""
    t, pid = ev.get("type"), S.pid
    if t == "poll": return False
    if t == "stop":
        if current_job(): current_job()["stop"] = True
        return True
    if t in ("settings", "models"):
        S.base_url, S.model = ev.get("base_url", S.base_url), ev.get("model", S.model) or S.model
        if ev.get("api_key"): S.api_key = ev["api_key"]
        SETF.write_text(json.dumps({"base_url": S.base_url, "model": S.model}))
        if t == "models":
            try: S.models = sorted(m.id for m in client().models.list())
            except Exception as e: S.models = []; S.notice = f"Не удалось получить список моделей: {e}"
        else: S.notice = "Настройки сохранены"
        return True
    if current_job(): return False                       # во время генерации остальные события игнорируются
    if t == "send": S.mode = ev["mode"]; start_job(pid, ev["mode"], ev["text"])
    elif t == "new": S.pid = new_project()
    elif t == "select": S.pid = ev["pid"]
    elif t == "restore": restore(pid, int(ev["version"]))
    elif t == "export": S.dl = {"id": uuid.uuid4().hex, "name": f"{pid}.zip", "b64": base64.b64encode(export_zip(pid, files(pid))).decode()}
    elif t == "review":
        try:
            ctx = "\n".join(f'<file path="{k}">\n{v}\n</file>' for k, v in files(pid).items())
            r = client().chat.completions.create(model=S.model, messages=[{"role": "system", "content": P.SECURITY + "\n\n" + ctx}, {"role": "user", "content": "Run the security review."}])
            S[f"sec_{pid}"] = r.choices[0].message.content
        except Exception as e: S.notice = f"Ошибка security review: {e}"
    return True

# ---------- запуск ----------
st.set_page_config(page_title="Vibe Studio", page_icon="🌿", layout="wide", initial_sidebar_state="collapsed")
st.markdown("""<style>header[data-testid="stHeader"],footer,#MainMenu{display:none!important}
.block-container{padding:0!important;max-width:100%!important}.stApp{background:#f3faf5}
[data-testid="stCustomComponentV1"] iframe,iframe[title*="vibe_studio"]{width:100%;height:100vh!important;border:0}</style>""", unsafe_allow_html=True)
_s = json.loads(SETF.read_text()) if SETF.exists() else {}
S.setdefault("base_url", _s.get("base_url", os.getenv("LLM_BASE_URL", ""))); S.setdefault("model", _s.get("model", os.getenv("LLM_MODEL", "gpt-4o")))
S.setdefault("api_key", os.getenv("LLM_API_KEY", "")); S.setdefault("mode", "Build")
if "pid" not in S:
    old = sorted([p.name for p in ROOT.iterdir() if p.is_dir() and (p / "chat.json").exists()], reverse=True)
    S.pid = old[0] if old else new_project()
finalize()
ev = studio(state=build_state(), key="studio", default=None)
if ev and ev.get("id") != S.get("last_ev"):
    S.last_ev = ev["id"]
    if handle(ev): st.rerun()
