"use strict";
/* Интерфейс Vibe Studio: чистый HTML/JS без сборки. Работает как компонент Streamlit (протокол postMessage).
   Python присылает состояние (state), интерфейс отправляет события (emit). */
var st = null;
var ui = {tab: "preview", file: null, modal: false, mode: "Build", side: true, fs: false, cw: null, att: [], editing: false,
          seen: false, lastDl: null, lastPrev: null, timer: null, keys: {}, reviewing: false, secBefore: "", drag: false};
var MODES = {Build: "🛠 Завайбкодить", Ask: "💬 Спросить ИИ", Plan: "📋 Создать план"};
var PLACE = {Build: "Опишите, что построить или поправить…", Ask: "Задайте вопрос по приложению или коду…", Plan: "Опишите задачу, составим план…"};
var $ = function (s) { return document.querySelector(s); };
var IC_EXP = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';
var IC_CMP = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/></svg>';

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
var TAG = /<(think|dyad-write|dyad-rename|dyad-delete|dyad-chat-summary|dyad-suggested-prompts|dyad-plan|dyad-security-finding|dyad-command|dyad-tasks|dyad-step|dyad-questionnaire)\b([^>]*)>([\s\S]*?)(<\/\1>|$)/g;
function attrs(s) { var o = {}, m, r = /([\w-]+)="([^"]*)"/g; while ((m = r.exec(s))) o[m[1]] = m[2]; return o; }
function card(icon, title, sub, done, body, open) {
  return '<details class="card"' + (open ? " open" : "") + "><summary><span>" + icon + " <b>" + esc(title) + "</b> <i>" + esc(sub || "") +
    '</i></span><em class="' + (done ? "ok" : "wip") + '">' + (done ? "✓" : "⏳") + "</em></summary>" +
    (body ? "<pre>" + esc(body.slice(-2500)) + "</pre>" : "") + "</details>";
}
function taskItems(b) { return b.split("\n").map(function (x) { return x.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim(); }).filter(Boolean); }
function planProgress(t) { var cur = 0, m, r = /<dyad-step\s+n="(\d+)"/g; while ((m = r.exec(t))) cur = Math.max(cur, +m[1]); return cur; }
function tasksCard(items, cur, fin) {
  var n = items.length, done = fin ? n : Math.max(0, cur - 1);
  var h = '<div class="tasks"><div class="th">' + (fin ? "✅ Все этапы выполнены" : "🛠 Выполнение плана") + " <span>(" + done + "/" + n + ")</span></div>";
  items.forEach(function (t, i) { var k = i + 1, c = fin || k < cur ? "done" : (k === cur ? "cur" : "todo"); h += '<div class="ti ' + c + '"><i>' + (c === "done" ? "✓" : c === "cur" ? "▶" : "○") + "</i>" + esc(t) + "</div>"; });
  return h + "</div>";
}
function parseQs(b) { var out = [], m, r = /<q\s+type="(\w+)"\s+text="([^"]*)"\s*>([\s\S]*?)<\/q>/g; while ((m = r.exec(b))) out.push({t: m[1], q: m[2], o: m[3].split("|").map(function (x) { return x.trim(); }).filter(Boolean)}); return out; }
function qaForm(qs, inter) {
  if (!inter) return '<div class="qa done"><div class="th">❓ Уточняющие вопросы <span>(' + qs.length + ")</span></div>" + qs.map(function (q) { return '<div class="qq">• ' + esc(q.q) + "</div>"; }).join("") + "</div>";
  return '<div class="qa" id="qa"><div class="th">❓ Уточняющие вопросы</div>' + qs.map(function (q, i) {
    var inner = q.t === "text" ? '<textarea class="qx" rows="2" placeholder="Ваш ответ"></textarea>' :
      q.o.map(function (o) { return '<label><input type="' + (q.t === "checkbox" ? "checkbox" : "radio") + '" name="q' + i + '" value="' + esc(o) + '"> ' + esc(o) + "</label>"; }).join("") + '<input class="qx" placeholder="Другое / комментарий">';
    return '<div class="q" data-q="' + esc(q.q) + '"><b>' + (i + 1) + ". " + esc(q.q) + "</b>" + inner + "</div>";
  }).join("") + '<button class="btn primary" data-a="answer">Отправить ответы</button></div>';
}
function renderMsg(text, streaming, inter) {
  text = text.replace(/<[^>]*$/, "");
  var out = "", pos = 0, m, re = new RegExp(TAG.source, "g"), cur = planProgress(text), total = 0;
  var tm = /<dyad-tasks[^>]*>([\s\S]*?)(<\/dyad-tasks>|$)/.exec(text); if (tm) total = taskItems(tm[1]).length;
  while ((m = re.exec(text))) {
    var pre = text.slice(pos, m.index); if (pre.trim()) out += md(pre);
    pos = re.lastIndex;
    var k = m[1], a = attrs(m[2]), b = m[3], done = !!m[4];
    if (k === "think") out += card("💭", done ? "Размышления" : "Думаю…", "", done, b, !done);
    else if (k === "dyad-write") out += card("✏️", a.path || "?", a.description, done, b, !done);
    else if (k === "dyad-rename") out += card("🔁", (a.from || "") + " → " + (a.to || ""), "", done, "", false);
    else if (k === "dyad-delete") out += card("🗑", a.path || "?", "", done, "", false);
    else if (k === "dyad-tasks") out += tasksCard(taskItems(b), cur, !streaming);
    else if (k === "dyad-step") out += '<div class="step">▶ Этап ' + esc(a.n || "") + (total ? " из " + total : "") + ": " + esc(b.trim()) + "</div>";
    else if (k === "dyad-questionnaire") out += qaForm(parseQs(b), inter && done);
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
function userMsg(c) {
  var chips = [], t = c.replace(/<attachment name="([^"]*)">[\s\S]*?<\/attachment>/g, function (m, n) { chips.push(n); return ""; }).trim();
  return (t ? "<p>" + esc(t).replace(/\n/g, "<br>") + "</p>" : "") + chips.map(function (n) { return '<span class="att">📎 ' + esc(n) + "</span>"; }).join("");
}
function statusBox(m, ord, isLast, busy) {
  if (!m.status) return "";
  var ch = m.changes || [];
  var h = '<div class="status' + (m.undone ? " un" : "") + '"><div class="sh">' + (m.undone ? "↩ Изменения отменены" : (m.status === "created" ? "✅ Приложение создано" : "✅ Приложение обновлено")) +
    " <span>· Версия " + ord + " · файлов: " + ch.length + "</span></div>";
  h += '<div class="fl">' + ch.map(function (c) { return '<div><b class="s' + c.status + '">' + c.status + "</b> " + esc(c.path) + '<span class="df">' + (c.add ? '<u class="pl">+' + c.add + "</u>" : "") + (c.del ? '<u class="mi">−' + c.del + "</u>" : "") + "</span></div>"; }).join("") + "</div>";
  if (!m.undone) h += isLast && !busy ? '<div class="acts"><button class="btn" data-a="undo">↩ Отменить</button><button class="btn" data-a="retry">⟳ Повторить</button></div>'
    : (!isLast ? '<div class="acts"><button class="lnk" data-a="restore" data-v="' + m.version + '">↩ вернуть эту версию</button></div>' : "");
  return h + "</div>";
}
//</pure>

function post(type, d) { window.parent.postMessage(Object.assign({isStreamlitMessage: true, type: type}, d || {}), "*"); }
function emit(o) { o.id = Date.now() + "-" + Math.random(); post("streamlit:setComponentValue", {value: o, dataType: "json"}); }
function toast(t) { var e = $("#toast"); e.textContent = t; e.style.display = "block"; clearTimeout(ui.tt); ui.tt = setTimeout(function () { e.style.display = "none"; }, 4000); }
function changed(k, v) { if (ui.keys[k] === v) return false; ui.keys[k] = v; return true; }

function build() {
  $("#app").innerHTML =
    '<aside class="side"><div class="brand"><div class="logo">V</div><div><b>Vibe Studio</b><small>AI-разработка приложений</small></div>' +
    '<button class="ibtn collapse" data-a="side" title="Свернуть меню">«</button></div>' +
    '<button class="btn primary w" data-a="new">＋ Новое приложение</button><div class="lbl">Проекты</div><div id="plist"></div><div class="grow"></div>' +
    '<button class="btn ghost w" data-a="settings">⚙️ Настройки LLM</button></aside>' +
    '<section class="chat"><div class="chead"><button class="ibtn" data-a="side" title="Меню" style="line-height:1;font-size:18px">☰</button><div id="ttl" class="ttl"></div></div>' +
    '<div id="msgs" class="msgs"></div><div id="sugg" class="sugg"></div>' +
    '<div class="composer" id="comp"><div class="attrow" id="atts"></div><div class="modes" id="modes"></div><textarea id="inp" rows="2"></textarea>' +
    '<button class="clip" data-a="attach" title="Прикрепить файл (csv, json, txt, md…)">📎</button><button id="go" class="send" data-a="send">➤</button>' +
    '<input type="file" id="fin" multiple hidden></div></section>' +
    '<div class="split" id="split" title="Потяните, чтобы изменить ширину"></div>' +
    '<section class="work"><div class="tabs"><span id="tabs" style="display:flex;gap:4px"></span><span class="grow"></span><button class="ibtn" id="fsb" data-a="fs" title="На весь экран"></button></div><div class="pane">' +
    '<div class="sub" id="p-preview"><div class="bar"><button class="btn" data-a="refresh">🔄 Обновить превью</button></div>' +
    '<iframe id="pv" sandbox="allow-scripts allow-same-origin allow-modals allow-forms allow-popups allow-downloads"></iframe><div class="empty" id="pv-empty">Превью появится после первой генерации (режим «Завайбкодить»).</div></div>' +
    '<div class="sub" id="p-code"></div><div class="sub" id="p-export"></div></div></section><div id="modal"></div><div id="toast"></div>';
  $("#inp").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send($("#inp").value); } });
  $("#fin").addEventListener("change", function (e) { addFiles(e.target.files); e.target.value = ""; });
  var comp = $("#comp");
  comp.addEventListener("dragover", function (e) { e.preventDefault(); comp.classList.add("over"); });
  comp.addEventListener("dragleave", function () { comp.classList.remove("over"); });
  comp.addEventListener("drop", function (e) { e.preventDefault(); comp.classList.remove("over"); addFiles(e.dataTransfer.files); });
  var sp = $("#split");
  sp.addEventListener("pointerdown", function (e) { ui.drag = true; sp.setPointerCapture(e.pointerId); document.body.classList.add("drag"); });
  sp.addEventListener("pointermove", function (e) {
    if (!ui.drag) return; var left = $(".chat").getBoundingClientRect().left;
    ui.cw = Math.max(300, Math.min(e.clientX - left, window.innerWidth - left - 330)); layout();
  });
  sp.addEventListener("pointerup", function () { ui.drag = false; document.body.classList.remove("drag"); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && ui.fs) { ui.fs = false; layout(); render(); } });
}
function layout() {
  var a = $("#app"); a.classList.toggle("fs", ui.fs); a.classList.toggle("nosb", !ui.side);
  a.style.gridTemplateColumns = ui.fs ? "1fr" : (ui.side ? "230px " : "0px ") + (ui.cw ? ui.cw + "px" : "36%") + " 10px 1fr";
}
function addFiles(list) {
  Array.prototype.forEach.call(list, function (f) {
    if (f.size > 200000) return toast("Файл «" + f.name + "» больше 200 КБ");
    var r = new FileReader();
    r.onload = function () {
      if (/\u0000/.test(String(r.result).slice(0, 2000))) return toast("Поддерживаются текстовые файлы (csv, json, txt, md…): " + f.name);
      ui.att.push({name: f.name, text: r.result}); drawAtts();
    };
    r.readAsText(f);
  });
}
function drawAtts() { $("#atts").innerHTML = ui.att.map(function (a, i) { return '<span class="att">📎 ' + esc(a.name) + ' <button data-a="unatt" data-v="' + i + '">×</button></span>'; }).join(""); }
function drawTitle() {
  var p = st.projects.filter(function (x) { return x.id === st.pid; })[0] || {title: ""};
  if (ui.editing) {
    $("#ttl").innerHTML = '<input id="ttl-in" class="tin" maxlength="60">'; var i = $("#ttl-in"); i.value = p.title; i.focus(); i.select();
    i.addEventListener("keydown", function (e) { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") { ui.editing = false; ui.keys.ttl = ""; render(); } });
    i.addEventListener("blur", saveTitle);
  } else $("#ttl").innerHTML = "<b>" + esc(p.title) + '</b><button class="ibtn" data-a="rename" title="Переименовать приложение">✎</button>';
}
function saveTitle() {
  if (!ui.editing) return; var v = $("#ttl-in").value.trim(); ui.editing = false;
  if (v) emit({type: "rename", pid: st.pid, title: v}); ui.keys.ttl = ""; render();
}

function render() {
  var busy = st.busy, last = st.messages[st.messages.length - 1];
  layout();
  $("#plist").innerHTML = st.projects.map(function (p) { return '<button class="proj' + (p.id === st.pid ? " on" : "") + '" data-a="select" data-v="' + esc(p.id) + '">' + esc(p.title) + "</button>"; }).join("");
  if (changed("ttl", JSON.stringify([st.pid, st.projects.map(function (p) { return p.title; }), ui.editing]))) drawTitle();
  $("#modes").innerHTML = ["Build", "Ask", "Plan"].map(function (m) { return '<button class="pill' + (ui.mode === m ? " on" : "") + '" data-a="mode" data-v="' + m + '">' + MODES[m] + "</button>"; }).join("");
  $("#inp").placeholder = PLACE[ui.mode];
  $("#go").dataset.a = busy ? "stop" : "send"; $("#go").textContent = busy ? "■" : "➤";
  $("#fsb").innerHTML = ui.fs ? IC_CMP : IC_EXP; $("#fsb").title = ui.fs ? "Выйти из полного экрана (Esc)" : "На весь экран";

  if (changed("msgs", JSON.stringify([st.messages, st.live, busy, st.pid]))) {
    var el = $("#msgs"), near = el.scrollHeight - el.scrollTop - el.clientHeight < 140, h = "", ord = 0;
    if (!st.messages.length && !busy) h += '<div class="hello"><h2>Что построим?</h2><div class="grid">' + st.inspiration.map(function (x, i) { return '<button class="insp" data-a="insp" data-v="' + i + '">' + esc(x[0]) + "</button>"; }).join("") + "</div></div>";
    st.messages.forEach(function (m, i) {
      var isLast = i === st.messages.length - 1; if (m.version) ord++;
      h += '<div class="msg ' + m.role + '">' + (m.role === "user" ? userMsg(m.content) : renderMsg(m.content, false, isLast && !busy) + statusBox(m, ord, isLast, busy)) + "</div>";
    });
    if (busy) h += '<div class="msg assistant">' + (st.live ? renderMsg(st.live, true, false) : '<span class="dots">Думаю<span>.</span><span>.</span><span>.</span></span>') + "</div>";
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
    $("#p-export").innerHTML = names.length ? '<div class="row"><button class="btn primary" data-a="export">⬇ Скачать набор (zip)</button><button class="btn" data-a="review">' + (ui.reviewing ? "⏳ Анализирую…" : "🛡 Security review") + "</button></div>" + (st.sec ? renderMsg(st.sec, false, false) : "") : '<div class="empty">Сначала сгенерируйте приложение.</div>';
  }
  if (st.dl && st.dl.id !== ui.lastDl) {
    ui.lastDl = st.dl.id; var bin = atob(st.dl.b64), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([u], {type: "application/zip"})); a.download = st.dl.name; document.body.appendChild(a); a.click(); a.remove();
  }
  if (st.notice) toast(st.notice);
  if (!ui.seenSettings) { ui.seenSettings = true; if (!st.settings.has_key && !st.settings.base_url) ui.modal = true; }
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
function setModal(v) { ui.modal = v; drawModal(); ui.keys.modal = JSON.stringify([ui.modal, st.models, st.settings]); }

function send(text) {
  text = (text || "").trim();
  if (!text && !ui.att.length) return;
  if (st.busy) return toast("Дождитесь окончания генерации");
  if (!text) text = "Используй приложенные файлы.";
  var full = text + ui.att.map(function (a) { return '\n\n<attachment name="' + a.name.replace(/"/g, "'") + '">\n' + a.text + "\n</attachment>"; }).join("");
  emit({type: "send", text: full, mode: ui.mode}); $("#inp").value = ""; ui.att = []; drawAtts();
}
function collect() {
  var out = [];
  document.querySelectorAll("#qa .q").forEach(function (el, i) {
    var v = []; el.querySelectorAll("input:checked").forEach(function (x) { v.push(x.value); });
    var x = el.querySelector(".qx"); if (x && x.value.trim()) v.push(x.value.trim());
    out.push((i + 1) + ". " + el.dataset.q + " — " + (v.join("; ") || "(без ответа)"));
  });
  return out.join("\n");
}
function act(a, v) {
  var lock = {new: 1, select: 1, restore: 1, export: 1, review: 1, undo: 1, retry: 1};
  if (st.busy && lock[a]) return toast("Дождитесь окончания генерации");
  if (a === "new") emit({type: "new"});
  else if (a === "select") emit({type: "select", pid: v});
  else if (a === "side") { ui.side = !ui.side; layout(); }
  else if (a === "fs") { ui.fs = !ui.fs; layout(); render(); }
  else if (a === "rename") { ui.editing = true; ui.keys.ttl = ""; render(); }
  else if (a === "settings") setModal(true);
  else if (a === "close") setModal(false);
  else if (a === "save") { var f = form(); f.type = "settings"; emit(f); setModal(false); }
  else if (a === "models") { var g = form(); g.type = "models"; emit(g); }
  else if (a === "mode") { ui.mode = v; render(); }
  else if (a === "attach") $("#fin").click();
  else if (a === "unatt") { ui.att.splice(+v, 1); drawAtts(); }
  else if (a === "send") send($("#inp").value);
  else if (a === "stop") emit({type: "stop"});
  else if (a === "insp") { ui.mode = "Build"; send(st.inspiration[+v][1]); }
  else if (a === "sugg") { ui.mode = "Build"; send(v); }
  else if (a === "accept") { ui.mode = "Build"; send("План принят. Реализуй его."); }
  else if (a === "answer") send("Ответы на уточняющие вопросы:\n" + collect());
  else if (a === "undo") emit({type: "undo"});
  else if (a === "retry") emit({type: "retry"});
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
