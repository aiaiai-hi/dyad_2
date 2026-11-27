"use strict";
/* Интерфейс Vibe Studio: чистый HTML/JS без сборки. Работает как компонент Streamlit (протокол postMessage).
   Python присылает состояние (state), интерфейс отправляет события (emit). */
var st = null;
var ui = {tab: "preview", file: null, modal: false, mode: "Build", seen: false, lastDl: null, lastPrev: null,
          timer: null, keys: {}, reviewing: false, secBefore: ""};
var $ = function (s) { return document.querySelector(s); };

//<pure>
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function md(t) {
  var codes = [];
  t = esc(t).replace(/```[\w-]*\n?([\s\S]*?)```/g, function (m, c) { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  var out = [], list = false;
  t.split("\n").forEach(function (l) {
    var m = l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (m) { if (!list) { out.push("<ul>"); list = true; } out.push("<li>" + m[1] + "</li>"); }
    else { if (list) { out.push("</ul>"); list = false; } out.push(l.trim() ? "<p>" + l + "</p>" : ""); }
  });
  if (list) out.push("</ul>");
  return out.join("").replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\u0000(\d+)\u0000/g, function (m, i) { return '<pre class="code">' + codes[+i] + "</pre>"; });
}
var TAG = /<(think|dyad-write|dyad-rename|dyad-delete|dyad-chat-summary|dyad-suggested-prompts|dyad-plan|dyad-security-finding|dyad-command)\b([^>]*)>([\s\S]*?)(<\/\1>|$)/g;
function attrs(s) { var o = {}, m, r = /([\w-]+)="([^"]*)"/g; while ((m = r.exec(s))) o[m[1]] = m[2]; return o; }
function card(icon, title, sub, done, body, open) {
  return '<details class="card"' + (open ? " open" : "") + "><summary><span>" + icon + " <b>" + esc(title) + "</b> <i>" + esc(sub || "") +
    '</i></span><em class="' + (done ? "ok" : "wip") + '">' + (done ? "✓" : "⏳") + "</em></summary>" +
    (body ? "<pre>" + esc(body.slice(-2500)) + "</pre>" : "") + "</details>";
}
function renderMsg(text, streaming) {
  text = text.replace(/<[^>]*$/, "");
  var out = "", pos = 0, m, re = new RegExp(TAG.source, "g");
  while ((m = re.exec(text))) {
    var pre = text.slice(pos, m.index); if (pre.trim()) out += md(pre);
    pos = re.lastIndex;
    var k = m[1], a = attrs(m[2]), b = m[3], done = !!m[4];
    if (k === "think") out += card("💭", done ? "Размышления" : "Думаю…", "", done, b, !done);
    else if (k === "dyad-write") out += card("✏️", a.path || "?", a.description, done, b, !done);
    else if (k === "dyad-rename") out += card("🔁", (a.from || "") + " → " + (a.to || ""), "", done, "", false);
    else if (k === "dyad-delete") out += card("🗑", a.path || "?", "", done, "", false);
    else if (k === "dyad-plan") out += '<div class="plan"><b>📋 План реализации</b>' + md(b) + "</div>";
    else if (k === "dyad-security-finding") { var lv = a.level || "low"; out += '<div class="finding ' + esc(lv) + '"><b>' + esc(a.title || "") + '</b> <span class="lv">' + esc(lv) + "</span>" + md(b) + "</div>"; }
  }
  var tail = text.slice(pos);
  if (tail.trim() || streaming) out += md(tail) + (streaming ? '<span class="cursor"></span>' : "");
  return out;
}
function suggestions(t) {
  var m = /<dyad-suggested-prompts[^>]*>([\s\S]*?)<\/dyad-suggested-prompts>/.exec(t || "");
  return m ? m[1].split("\n").map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 3) : [];
}
//</pure>

function post(type, d) { window.parent.postMessage(Object.assign({isStreamlitMessage: true, type: type}, d || {}), "*"); }
function emit(o) { o.id = Date.now() + "-" + Math.random(); post("streamlit:setComponentValue", {value: o, dataType: "json"}); }
function toast(t) { var e = $("#toast"); e.textContent = t; e.style.display = "block"; clearTimeout(ui.tt); ui.tt = setTimeout(function () { e.style.display = "none"; }, 4000); }
function changed(k, v) { if (ui.keys[k] === v) return false; ui.keys[k] = v; return true; }

function build() {
  $("#app").innerHTML =
    '<aside class="side"><div class="brand"><div class="logo">V</div><div><b>Vibe Studio</b><small>AI-разработка приложений</small></div></div>' +
    '<button class="btn primary w" data-a="new">＋ Новое приложение</button><div class="lbl">Проекты</div><div id="plist"></div><div class="grow"></div>' +
    '<button class="btn ghost w" data-a="settings">⚙️ Настройки LLM</button></aside>' +
    '<section class="chat"><div id="msgs" class="msgs"></div><div id="sugg" class="sugg"></div>' +
    '<div class="composer"><div class="modes" id="modes"></div><textarea id="inp" rows="2" placeholder="Что построим или поправим?"></textarea>' +
    '<button id="go" class="send" data-a="send">➤</button></div></section>' +
    '<section class="work"><div class="tabs" id="tabs"></div><div class="pane">' +
    '<div class="sub" id="p-preview"><div class="bar"><button class="btn" data-a="refresh">🔄 Обновить превью</button></div>' +
    '<iframe id="pv" sandbox="allow-scripts allow-same-origin allow-modals allow-forms allow-popups"></iframe><div class="empty" id="pv-empty">Превью появится после первой генерации (режим Build).</div></div>' +
    '<div class="sub" id="p-code"></div><div class="sub" id="p-export"></div></div></section><div id="modal"></div><div id="toast"></div>';
  $("#inp").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send($("#inp").value); } });
}

function render() {
  var busy = st.busy, last = st.messages[st.messages.length - 1];
  $("#plist").innerHTML = st.projects.map(function (p) { return '<button class="proj' + (p.id === st.pid ? " on" : "") + '" data-a="select" data-v="' + esc(p.id) + '">' + esc(p.title) + "</button>"; }).join("");
  $("#modes").innerHTML = ["Build", "Ask", "Plan"].map(function (m) { return '<button class="pill' + (ui.mode === m ? " on" : "") + '" data-a="mode" data-v="' + m + '">' + {Build: "🛠 Build", Ask: "💬 Ask", Plan: "📋 Plan"}[m] + "</button>"; }).join("");
  $("#go").dataset.a = busy ? "stop" : "send"; $("#go").textContent = busy ? "■" : "➤";

  if (changed("msgs", JSON.stringify([st.messages, st.live, busy, st.pid]))) {
    var el = $("#msgs"), near = el.scrollHeight - el.scrollTop - el.clientHeight < 140, h = "";
    if (!st.messages.length && !busy) h += '<div class="hello"><h2>Что построим?</h2><div class="grid">' + st.inspiration.map(function (x, i) { return '<button class="insp" data-a="insp" data-v="' + i + '">' + esc(x[0]) + "</button>"; }).join("") + "</div></div>";
    st.messages.forEach(function (m) {
      h += '<div class="msg ' + m.role + '">' + (m.role === "user" ? "<p>" + esc(m.content).replace(/\n/g, "<br>") + "</p>" :
        renderMsg(m.content, false) + (m.version ? '<div class="ver">Версия ' + m.version + ' <button class="lnk" data-a="restore" data-v="' + m.version + '">↩ вернуть</button></div>' : "")) + "</div>";
    });
    if (busy) h += '<div class="msg assistant">' + (st.live ? renderMsg(st.live, true) : '<span class="dots">Думаю<span>.</span><span>.</span><span>.</span></span>') + "</div>";
    if (last && last.role === "assistant" && !busy && last.content.indexOf("<dyad-plan") >= 0) h += '<button class="btn primary" data-a="accept">✅ Принять план и реализовать</button>';
    el.innerHTML = h; if (near || ui.keys.first !== 1) { el.scrollTop = el.scrollHeight; ui.keys.first = 1; }
  }
  $("#sugg").innerHTML = (last && last.role === "assistant" && !busy ? suggestions(last.content) : []).map(function (s) { return '<button class="chip" data-a="sugg" data-v="' + esc(s) + '">💡 ' + esc(s) + "</button>"; }).join("");

  $("#tabs").innerHTML = [["preview", "👁 Превью"], ["code", "</> Код"], ["export", "⬇ Экспорт и проверка"]].map(function (t) { return '<button class="tab' + (ui.tab === t[0] ? " on" : "") + '" data-a="tab" data-v="' + t[0] + '">' + t[1] + "</button>"; }).join("");
  ["preview", "code", "export"].forEach(function (t) { $("#p-" + t).classList.toggle("on", ui.tab === t); });

  if (st.preview !== ui.lastPrev) { ui.lastPrev = st.preview; $("#pv").srcdoc = st.preview; }
  $("#pv").style.display = st.preview ? "block" : "none"; $("#pv-empty").style.display = st.preview ? "none" : "block";

  var names = Object.keys(st.files); if (names.indexOf(ui.file) < 0) ui.file = names[0] || null;
  if (changed("code", JSON.stringify([names, ui.file, ui.file && st.files[ui.file]]))) {
    $("#p-code").innerHTML = names.length ? '<div class="flist">' + names.map(function (n) { return '<button class="f' + (n === ui.file ? " on" : "") + '" data-a="file" data-v="' + esc(n) + '">' + esc(n) + "</button>"; }).join("") + '</div><pre class="src">' + esc(st.files[ui.file]) + "</pre>" : '<div class="empty">Файлов пока нет.</div>';
  }
  if (ui.reviewing && (st.sec !== ui.secBefore || st.notice)) ui.reviewing = false;
  if (changed("exp", JSON.stringify([names.length, st.sec, ui.reviewing]))) {
    $("#p-export").innerHTML = names.length ? '<div class="row"><button class="btn primary" data-a="export">⬇ Скачать набор (zip)</button><button class="btn" data-a="review">' + (ui.reviewing ? "⏳ Анализирую…" : "🛡 Security review") + "</button></div>" + (st.sec ? renderMsg(st.sec, false) : "") : '<div class="empty">Сначала сгенерируйте приложение.</div>';
  }
  if (st.dl && st.dl.id !== ui.lastDl) {
    ui.lastDl = st.dl.id; var bin = atob(st.dl.b64), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([u], {type: "application/zip"})); a.download = st.dl.name; document.body.appendChild(a); a.click(); a.remove();
  }
  if (st.notice) toast(st.notice);
  if (!ui.seenSettings) { ui.seenSettings = true; if (!st.settings.has_key && !st.settings.base_url) { ui.modal = true; } }
  if (changed("modal", JSON.stringify([ui.modal, st.models, st.settings]))) drawModal();
  if (busy && !ui.timer) ui.timer = setInterval(function () { emit({type: "poll"}); }, 700);
  if (!busy && ui.timer) { clearInterval(ui.timer); ui.timer = null; }
}

function drawModal() {
  var cur = ui.modal && $("#s-url") ? {u: $("#s-url").value, k: $("#s-key").value, m: $("#s-model").value} : null;
  if (!ui.modal) { $("#modal").innerHTML = ""; return; }
  var s = st.settings;
  $("#modal").innerHTML = '<div class="overlay"><div class="dlg"><h3>⚙️ Настройки LLM</h3>' +
    '<label>Base URL<input id="s-url" placeholder="https://api.openai.com/v1"></label>' +
    '<label>API key<input id="s-key" type="password" placeholder="' + (s.has_key ? "сохранён (оставьте пустым, чтобы не менять)" : "sk-...") + '"></label>' +
    '<label>Модель<input id="s-model" list="mlist" placeholder="gpt-4o"></label><datalist id="mlist">' + st.models.map(function (m) { return '<option value="' + esc(m) + '">'; }).join("") + "</datalist>" +
    '<div><button class="btn" data-a="models">Загрузить список моделей</button></div>' +
    '<div class="row end"><button class="btn" data-a="close">Закрыть</button><button class="btn primary" data-a="save">Сохранить</button></div></div></div>';
  $("#s-url").value = cur ? cur.u : s.base_url; $("#s-key").value = cur ? cur.k : ""; $("#s-model").value = cur ? cur.m : s.model;
}
function form() { return {base_url: $("#s-url").value, api_key: $("#s-key").value, model: $("#s-model").value}; }

function send(text) {
  text = (text || "").trim(); if (!text) return;
  if (st.busy) return toast("Дождитесь окончания генерации");
  emit({type: "send", text: text, mode: ui.mode}); $("#inp").value = "";
}
function act(a, v) {
  var lock = {new: 1, select: 1, restore: 1, export: 1, review: 1};
  if (st.busy && lock[a]) return toast("Дождитесь окончания генерации");
  if (a === "new") emit({type: "new"});
  else if (a === "select") emit({type: "select", pid: v});
  else if (a === "settings") { ui.modal = true; drawModal(); ui.keys.modal = JSON.stringify([ui.modal, st.models, st.settings]); }
  else if (a === "close") { ui.modal = false; drawModal(); ui.keys.modal = JSON.stringify([ui.modal, st.models, st.settings]); }
  else if (a === "save") { var f = form(); f.type = "settings"; emit(f); ui.modal = false; }
  else if (a === "models") { var g = form(); g.type = "models"; emit(g); }
  else if (a === "mode") { ui.mode = v; render(); }
  else if (a === "send") send($("#inp").value);
  else if (a === "stop") emit({type: "stop"});
  else if (a === "insp") { ui.mode = "Build"; send(st.inspiration[+v][1]); }
  else if (a === "sugg") { ui.mode = "Build"; send(v); }
  else if (a === "accept") { ui.mode = "Build"; send("План принят. Реализуй его."); }
  else if (a === "restore") emit({type: "restore", version: v});
  else if (a === "tab") { ui.tab = v; render(); }
  else if (a === "file") { ui.file = v; render(); }
  else if (a === "export") emit({type: "export"});
  else if (a === "review") { ui.reviewing = true; ui.secBefore = st.sec; ui.keys.exp = ""; render(); emit({type: "review"}); }
  else if (a === "refresh") { var p = $("#pv"); p.srcdoc = ""; setTimeout(function () { p.srcdoc = st.preview; }, 30); }
}
document.addEventListener("click", function (e) { var b = e.target.closest("[data-a]"); if (b) act(b.dataset.a, b.dataset.v); });

window.addEventListener("message", function (e) {
  if (!e.data || e.data.type !== "streamlit:render") return;
  st = e.data.args.state; if (!ui.seen) { ui.seen = true; build(); }
  render();
});
post("streamlit:componentReady", {apiVersion: 1});
post("streamlit:setFrameHeight", {height: 800});
