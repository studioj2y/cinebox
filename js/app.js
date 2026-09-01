/* app.js - 交互流程 */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const MOVIES = window.MOVIES || [];
  const QUESTIONS = window.QUESTIONS || [];

  const screens = {
    wall: $("#wall"),
    quiz: $("#quiz"),
    result: $("#result"),
  };
  let typeTimer = null;
  // 逐字打字时，把结果屏滚动容器钉在底部，确保用户始终看到最新浮现的内容
  function scrollResultBottom() {
    const r = $("#result");
    if (r) r.scrollTop = r.scrollHeight;
  }
  function typeText(el, text, onDone) {
    if (typeTimer) clearInterval(typeTimer);
    el.textContent = "";
    el.classList.remove("loading");
    el.classList.add("typing");
    let i = 0;
    typeTimer = setInterval(() => {
      el.textContent += text.charAt(i) || "";
      i++;
      el.scrollTop = el.scrollHeight;
      scrollResultBottom();
      if (i >= text.length) {
        clearInterval(typeTimer);
        typeTimer = null;
        el.classList.remove("typing");
        if (typeof onDone === "function") onDone();
      }
    }, 28);
  }
  function show(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
    if (name !== "wall") window.scrollTo(0, 0);
  }

  /* ---------------- 海报墙 ---------------- */
  const GRAD = [
    ["#ff7e5f", "#feb47b"], ["#6a11cb", "#2575fc"], ["#11998e", "#38ef7d"],
    ["#fc466b", "#3f5efb"], ["#f7971e", "#ffd200"], ["#c33764", "#1d2671"],
    ["#00c6ff", "#0072ff"], ["#f857a6", "#ff5858"],
  ];
  function posterEl(m) {
    const el = document.createElement("div");
    el.className = "poster";
    if (m.poster) {
      const img = document.createElement("img");
      img.src = m.poster;
      img.alt = m.title;
      img.loading = "lazy";
      img.onerror = () => renderFallback(el, m);
      el.appendChild(img);
    } else {
      renderFallback(el, m);
    }
    return el;
  }
  function renderFallback(el, m) {
    const [c1, c2] = GRAD[m.id % GRAD.length];
    el.style.setProperty("--c1", c1);
    el.style.setProperty("--c2", c2);
    el.innerHTML = `<div class="ph"><div class="t">${m.title}</div><div class="y">${m.year || ""}</div></div>`;
  }
  function buildWall() {
    const rows = 4;
    const rowEls = [];
    const per = Math.ceil(MOVIES.length / rows);
    const wall = $("#wallRows");
    for (let r = 0; r < rows; r++) {
      const subset = MOVIES.slice(r * per, (r + 1) * per);
      if (!subset.length) continue;
      const row = document.createElement("div");
      row.className = "wall-row r" + (r + 1);
      // 复制一份实现无缝滚动
      const seq = subset.concat(subset);
      seq.forEach((m) => row.appendChild(posterEl(m)));
      wall.appendChild(row);
    }
  }

  /* ---------------- 答题 ---------------- */
  const QUIZ_N = 5;
  let quizQs = [];
  let answers = [];
  let ranked = [];
  let current = null;
  let quizCardEl = null;
  let replyStreamEl = null;
  let ghostLayerEl = null; // 回复「幽灵」浮现层
  let quizLocked = false; // 防止溶解/过场期间的重复点击导致跳题
  let aiLoading = false;  // 防止「不良有话说」重复点击/并发请求

  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function startQuiz() {
    quizQs = shuffle(QUESTIONS).slice(0, QUIZ_N);
    answers = [];
    quizLocked = false;
    quizCardEl = $("#quizCard");
    replyStreamEl = $("#replyStream");
    ghostLayerEl = $("#ghostLayer");
    replyStreamEl.innerHTML = "";
    if (ghostLayerEl) ghostLayerEl.innerHTML = "";
    // 重建问题卡默认结构（summary 屏会覆盖 innerHTML，重测时需复原）
    quizCardEl.innerHTML = '<div class="q-index" id="qIdx"></div><div class="q-cat" id="qCat"></div><h2 id="qText"></h2><div id="qOptions" class="options"></div>';
    quizCardEl.classList.remove("dissolve", "enter");
    show("quiz");
    renderQuestion(0);
  }
  function renderQuestion(idx) {
    if (ghostLayerEl) ghostLayerEl.innerHTML = ""; // 清掉上一题残留的「幽灵」回复
    const q = quizQs[idx];
    $("#qIdx").innerHTML = '第 <b>' + (idx + 1) + '</b> / ' + QUIZ_N + ' 题';
    $("#qCat").textContent = q.category || "";
    $("#qText").textContent = q.question;
    $("#qNow").textContent = idx + 1;
    $("#qTotal").textContent = QUIZ_N;
    $("#progressBar").style.width = ((idx) / QUIZ_N) * 100 + "%";
    quizCardEl.classList.remove("dissolve");
    const box = $("#qOptions");
    box.innerHTML = "";
    q.options.forEach((opt) => {
      const b = document.createElement("button");
      b.className = "opt";
      b.textContent = opt.text;
      b.onclick = () => chooseOption(idx, opt);
      box.appendChild(b);
    });
    // 选项错落淡入，整体节奏更舒缓
    box.querySelectorAll(".opt").forEach((b, i) => setTimeout(() => b.classList.add("in"), 120 + i * 120));
    // 问题卡进场：从下方淡入
    quizCardEl.classList.remove("enter");
    void quizCardEl.offsetWidth;
    quizCardEl.classList.add("enter");
    // 入场动画结束后自动脱离 .enter：cardIn 的 fill-mode:both 会锁定 opacity:1，
    // 若不脱离，后续 chooseOption 加 .dissolve 时其 transition 目标会被动画覆盖 → 问题卡不消散
    quizCardEl.addEventListener("animationend", function onCardIn(e) {
      if (e.animationName === "cardIn") quizCardEl.classList.remove("enter");
    }, { once: true });
  }
  function chooseOption(idx, opt) {
    if (quizLocked) return; // 防重复点击/穿透，避免跳题或重来
    quizLocked = true;
    answers.push(opt);
    const reply = opt.reply || "好，记下了~";

    // 先解除入场动画（cardIn 的 fill-mode:both 会锁定 opacity:1，覆盖 dissolve 的过渡目标），
    // 否则问题卡不会消散。强制重排后再加 .dissolve，让过渡从可见态平滑淡出
    quizCardEl.classList.remove("enter");
    void quizCardEl.offsetWidth;
    // 阶段①（t0）：当前问题卡溶解模糊、缓缓上浮消散
    quizCardEl.classList.add("dissolve");

    // 阶段②（t≈520ms，趁溶解进行中）：在模糊处，回复「幽灵」由模糊逐渐清晰形成
    setTimeout(() => {
      const ghost = document.createElement("div");
      ghost.className = "reply-ghost";
      ghost.textContent = reply;
      ghostLayerEl.appendChild(ghost);
      requestAnimationFrame(() => ghost.classList.add("form"));
    }, 520);

    // 阶段③（形成后停留片刻）：回复上浮淡出，同时真正落入顶部回复流（淡入上移）
    const T_LIFT = 520 + 950 + 260; // form 时长 .95s + 停留 .26s
    setTimeout(() => {
      const ghost = ghostLayerEl.querySelector(".reply-ghost");
      if (ghost) ghost.classList.add("lift");
      const item = document.createElement("div");
      item.className = "reply-item";
      item.textContent = reply;
      replyStreamEl.appendChild(item);
      requestAnimationFrame(() => item.classList.add("in"));
      replyStreamEl.scrollTop = replyStreamEl.scrollHeight;
    }, T_LIFT);

    // 阶段④（回复上浮完成后稍作停顿）：新问题从屏幕底部由外向内上浮入场
    const T_NEXT = T_LIFT + 800 + 320; // lift 时长 .8s + 停顿 .32s
    setTimeout(() => {
      if (idx + 1 < QUIZ_N) {
        renderQuestion(idx + 1);
      } else {
        $("#progressBar").style.width = "100%";
        renderSummary();
      }
      quizLocked = false;
    }, T_NEXT);
  }
  function renderSummary() {
    if (ghostLayerEl) ghostLayerEl.innerHTML = ""; // 清掉最后一题残留的「幽灵」回复
    const replies = answers.map((a) => a.reply || "好，记下了~").filter(Boolean);
    quizCardEl.innerHTML =
      '<div class="summary">' +
        '<div class="summary-kicker">你刚才说——</div>' +
        '<div class="summary-replies">' + replies.map((r) => '<span class="sr">' + r + '</span>').join("") + '</div>' +
        '<p class="summary-line">聊完啦。现在，让一部电影<br>替今晚收个尾。</p>' +
        '<button id="revealBtn" class="reveal-btn">揭晓今晚的电影 →</button>' +
      '</div>';
    quizCardEl.classList.remove("dissolve");
    void quizCardEl.offsetWidth;
    quizCardEl.classList.add("enter");
    // 回复胶囊错落淡入
    const pills = quizCardEl.querySelectorAll(".sr");
    pills.forEach((p, i) => setTimeout(() => p.classList.add("in"), 160 + i * 120));
    $("#revealBtn").onclick = finishQuiz;
  }
  function finishQuiz() {
    ranked = window.Match.recommend(answers, MOVIES, { poolSize: 8 });
    pickResult();
  }
  function pickResult() {
    const pick = window.Match.pickOne(ranked);
    current = pick ? pick.m : null;
    if (!current) {
      alert("片库为空，请先运行 scripts/fetch_movies.py 生成数据。");
      return;
    }
    renderResult();
    show("result");
    // 结果屏错落入场
    const rw = $(".result-wrap");
    rw.classList.remove("anim");
    void rw.offsetWidth;
    rw.classList.add("anim");
  }
  function renderResult() {
    const m = current;
    const W = window.Match.aggregate(answers);
    const img = $("#rPoster");
    const fb = $("#rFallback");
    if (m.poster) {
      img.src = m.poster;
      img.decoding = "async";
      img.style.display = "block";
      fb.classList.remove("show");
      img.onerror = () => { img.style.display = "none"; fb.classList.add("show"); fb.innerHTML = `<div class="t">${m.title}</div><div class="y">${m.year || ""}</div>`; };
    } else {
      img.style.display = "none";
      fb.classList.add("show");
      fb.innerHTML = `<div class="t">${m.title}</div><div class="y">${m.year || ""}</div>`;
    }
    $("#rTitle").textContent = m.title + (m.original ? ` · ${m.original}` : "");
    $("#rMeta").textContent = [m.year, (m.genres || []).join("/")].filter(Boolean).join("  ·  ");
    renderRatings(m);
    const tags = window.Match.topTags(m, W, 5);
    $("#rTags").innerHTML = tags.map((t) => `<span>${t}</span>`).join("");
    $("#rOverview").textContent = m.overview || "";
    $("#rReason").textContent = window.Match.buildReason(m, W);
    const pre = $("#aiPrompt");
    pre.classList.remove("show");
    pre.hidden = true;
    // 切到新电影时，重置二维码与打字计时器，避免旧二维码残留
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    pre.classList.remove("typing", "loading");
    const qrCta = $("#qrCta");
    if (qrCta) { qrCta.classList.remove("show"); qrCta.hidden = true; }
    // 切到新电影时，重置分享海报（避免旧海报/状态残留）
    const pa = $("#posterArea");
    if (pa) { pa.hidden = true; }
    const ps = $("#posterStatus");
    if (ps) { ps.hidden = true; ps.textContent = ""; ps.className = "poster-status"; }
    const pi = $("#posterImg");
    if (pi) { pi.hidden = true; pi.removeAttribute("src"); }
  }

  /* ---------------- 事件 ---------------- */
  $("#startBtn").onclick = startQuiz;
  $("#backBtn").onclick = () => show("wall");
  $("#retestBtn").onclick = startQuiz;
  $("#againBtn").onclick = () => {
    // 换一部: 从候选池里挑一个不同于当前的
    const others = ranked.filter((x) => x.m !== current);
    const pool = others.length ? others : ranked;
    const pick = window.Match.pickOne(pool);
    current = pick ? pick.m : current;
    renderResult();
  };
  /* 评分徽章：只展示 TMDB 评分（恢复最简状态）。 */
  function renderRatings(m) {
    const v = m.tmdb_rating || m.rating;
    if (v) $("#rRatings").innerHTML = `<span class="rt rt-tmdb">TMDB ★ ${v}</span>`;
    else $("#rRatings").innerHTML = "";
  }

  /* AI 全盘解读：改为调用本站 /api/interpret（Vercel Serverless 代理）
     多 key 轮转 + 多提供方故障转移 + 缓存 都在服务端完成，前端不再持有任何 key */
  $("#aiBtn").onclick = async () => {
    if (aiLoading) return; // 防重复点击/并发，避免重复请求
    aiLoading = true;
    const answersText = quizQs.map((q, i) => `${i + 1}. ${q.question} → ${answers[i] ? answers[i].text : ""}`).join("\n");
    const prompt = window.Match.buildInterpretPrompt(answersText, current);
    const pre = $("#aiPrompt");
    const qrCta = $("#qrCta");
    // 每次重新点击：先隐藏二维码，等新解读完成后再浮现
    qrCta.classList.remove("show");
    qrCta.hidden = true;
    pre.hidden = false;
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    pre.classList.remove("typing");
    requestAnimationFrame(() => pre.classList.add("show"));
    pre.classList.add("loading");
    pre.textContent = "正在探究你的内心，请稍后…";
    // 强制把画面拉到最下，确保解读框（在内容下方）立即可见
    requestAnimationFrame(() => { pre.scrollIntoView({ behavior: "smooth", block: "end" }); scrollResultBottom(); });

    // 解读完成（含空态）后浮现二维码，并把窗口钉到底
    function revealQR() {
      qrCta.hidden = false;
      requestAnimationFrame(() => {
        qrCta.classList.add("show");
        requestAnimationFrame(() => {
          qrCta.scrollIntoView({ behavior: "smooth", block: "end" });
          scrollResultBottom();
        });
      });
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let text = "";
    let lastErr = "";
    const MAX = 2; // 服务端已做 key 轮转+提供方故障转移，这里仅作网络层兜底
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 30000); // 30s 超时，避免悬挂
        const resp = await fetch("/api/interpret", {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            movieId: current.id,
            title: current.title,
            answers: quizQs.map((q, i) => ({ question: q.question, text: answers[i] ? answers[i].text : "" })),
            prompt: prompt,
          }),
        });
        clearTimeout(to);
        if (!resp.ok) {
          let msg = "HTTP " + resp.status;
          try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (e) {}
          throw new Error(msg);
        }
        const data = await resp.json();
        if (!data || !data.text || !data.text.trim()) throw new Error("返回为空");
        text = data.text.trim();
        break;
      } catch (e) {
        lastErr = e.message;
        if (attempt < MAX) { pre.textContent = "网络打了个嗝，重新连一下…"; await sleep(1200); continue; }
      }
    }

    if (!text) {
      // 空 / 全部失败：温柔话术，提示可再次点击重新生成
      pre.classList.remove("loading", "typing");
      pre.textContent = "心灵太封闭了，深呼吸，我再看一次。\n（点「✦ 不良有话说」再试一回）";
      aiLoading = false;
      revealQR();
      return;
    }
    // 兜底：无论返回如何，结尾必带「今晚就它了。」（服务端已确保，这里双保险）
    if (!/今晚就它了[。\.！!]?$/.test(text.replace(/\s+$/, ""))) {
      text = text.replace(/\s+$/, "") + "\n\n今晚就它了。";
    }
    // 逐字打字机呈现（打字过程中每 tick 钉底，确保最新字可见；打完后浮现二维码）
    typeText(pre, text, revealQR);
    aiLoading = false;
  };

  /* 生成分享海报：把问答回顾 + 电影信息 + 双二维码合成一张可保存的图
     内容从上到下：所有问题/答案/回复（含 AI 解读，若有）→ 电影海报与基本信息 → 两个对齐二维码
     微信/手机浏览器无法触发文件下载，改为在结果页最下方直接渲染成 <img>，用户可长按保存/分享 */
  $("#posterBtn").onclick = generatePoster;
  function generatePoster() {
    const btn = $("#posterBtn");
    if (btn.disabled) return;
    const m = current;
    if (!m) { alert("还没有选出电影，先完成测试吧~"); return; }
    const W = window.Match.aggregate(answers);
    const rating = (m.tmdb_rating || m.rating) ? "TMDB ★ " + (m.tmdb_rating || m.rating) : "";
    const tags = window.Match.topTags(m, W, 5).map((t) => "#" + t).join("  ");
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

    const qa = quizQs.map((q, i) => `
      <div style="margin:8px 0;padding-left:11px;border-left:3px solid #ff5e9c;">
        <div style="font:600 13px/1.35 system-ui;color:#ffffff;">${i + 1}. ${esc(q.question)}</div>
        <div style="font:12px/1.3 system-ui;color:#ffb6d4;margin-top:3px;">▸ ${esc(answers[i] ? answers[i].text : "")}</div>
        <div style="font:12px/1.4 system-ui;color:#d9c4e6;margin-top:3px;">“${esc(answers[i] ? answers[i].reply : "")}”</div>
      </div>`).join("");

    // 海报不再包含「不良有话说」AI 解读（太占空间）

    const root = document.createElement("div");
    root.id = "posterRoot";
    root.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;z-index:-1;background:#140b1c;color:#fff;font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;";
    root.innerHTML = `
      <div style="padding:24px 24px 14px;background:linear-gradient(180deg,#1c0f29,#140b1c);">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font:700 14px/1 system-ui;letter-spacing:2px;color:#ff7eb6;">CINE<b style="color:#ffd1e6;">BOX</b></span>
          <span style="font:13px system-ui;color:#c9a9d6;">· 不良陪你选电影</span>
        </div>
        <div style="margin-top:13px;font:600 19px/1.3 system-ui;color:#ffffff;">今晚为你选出</div>
      </div>
      <div style="padding:6px 24px 10px;">${qa}</div>
      <div style="display:flex;padding:16px 24px 6px;background:linear-gradient(180deg,#180d24,#140b1c);">
        <img class="poster-cap" src="${esc(m.poster)}" crossorigin="anonymous" style="width:162px;height:234px;object-fit:cover;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.5);flex:0 0 auto;background:#2a1838;" />
        <div style="flex:1;min-width:0;margin-left:16px;">
          <div style="font:700 18px/1.3 system-ui;color:#ffffff;">${esc(m.title)}</div>
          <div style="font:13px system-ui;color:#c9a9d6;margin-top:6px;">${esc([m.year, (m.genres || []).join("/")].filter(Boolean).join("  ·  "))}</div>
          ${rating ? `<div style="font:13px system-ui;color:#ffd1a8;margin-top:5px;">${esc(rating)}</div>` : ""}
          ${tags ? `<div style="font:13px system-ui;color:#b9e3ff;margin-top:6px;">${esc(tags)}</div>` : ""}
          <div style="font:600 13px/1.4 system-ui;color:#ff7eb6;margin-top:11px;letter-spacing:1px;">不良推荐：<br/>为什么是它</div>
          <div style="font:13px/1.6 system-ui;color:#d9c4e6;margin-top:5px;">${esc(window.Match.buildReason(m, W))}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:center;padding:18px 22px 6px;">
        <div style="text-align:center;margin:0 13px;">
          <img src="images/qrcode.jpg" style="width:120px;height:120px;border-radius:10px;background:#fff;padding:6px;box-sizing:border-box;" />
          <div style="font:12px/1.45 system-ui;color:#ffb6d4;margin-top:7px;">扫码关注 <b style="color:#ff5e9c;">不良少女放映组</b><br/>陪你一起看电影</div>
        </div>
        <div style="text-align:center;margin:0 13px;">
          <img src="images/qrcode-domain.png" style="width:120px;height:120px;border-radius:10px;background:#fff;padding:6px;box-sizing:border-box;" />
          <div style="font:12px/1.45 system-ui;color:#b6d4ff;margin-top:7px;">我也要测 <b style="color:#ff5e9c;">不良陪你选电影</b><br/>生成我的专属海报</div>
        </div>
      </div>
      <div style="text-align:center;font:11px system-ui;color:#8a6f99;padding:10px 0 18px;">CINEBOX · 不良少女放映组</div>
    `;
    document.body.appendChild(root);

    // 结果页最下方的海报展示区与状态提示
    const area = $("#posterArea");
    const statusEl = $("#posterStatus");
    const imgEl = $("#posterImg");

    // 海报图加载失败时的兜底（避免 html2canvas 捕获到破图/taint）
    const cap = root.querySelector(".poster-cap");
    const imgs = Array.from(root.querySelectorAll("img"));
    const loadImg = (img) => new Promise((res) => {
      let done = false; const fin = () => { if (!done) { done = true; res(); } };
      img.onload = fin; img.onerror = fin;
      if (img.complete) fin();
    });
    btn.disabled = true; const old = btn.textContent; btn.textContent = "生成中…";

    // 点开后立刻在最下方显示「正在生成」提示
    area.hidden = false;
    statusEl.hidden = false;
    statusEl.textContent = "正在为您生成海报，请稍后…";
    statusEl.className = "poster-status loading";
    imgEl.hidden = true;
    area.scrollIntoView({ behavior: "smooth", block: "end" });

    Promise.all(imgs.map(loadImg)).then(() => {
      if (cap && !cap.naturalWidth) {
        const fb = document.createElement("div");
        fb.style.cssText = "width:162px;height:234px;border-radius:12px;background:#2a1838;display:flex;align-items:center;justify-content:center;text-align:center;font:600 14px system-ui;color:#d9c4e6;padding:10px;box-sizing:border-box;flex:0 0 auto;";
        fb.textContent = m.title || "";
        cap.replaceWith(fb);
      }
      return new Promise((r) => setTimeout(r, 250));
    }).then(() => {
      if (typeof html2canvas === "undefined") throw new Error("海报组件未加载（请检查网络后重试）");
      return html2canvas(root, { useCORS: true, backgroundColor: "#140b1c", scale: 2, logging: false });
    }).then((canvas) => {
      // 不触发下载：转成 dataURL 直接渲染成 <img>，便于手机/微信长按保存或分享
      const url = canvas.toDataURL("image/png");
      imgEl.src = url;
      imgEl.hidden = false;
      statusEl.textContent = "已完成，可长按保存或分享";
      statusEl.className = "poster-status done";
      area.scrollIntoView({ behavior: "smooth", block: "end" });
      btn.textContent = "📸 重新生成海报";
    }).catch((e) => {
      statusEl.textContent = "海报生成失败：" + (e && e.message ? e.message : e) + "（可重试）";
      statusEl.className = "poster-status error";
    }).finally(() => {
      root.remove();
      btn.disabled = false;
      // 生成成功则提示可重新生成；失败/未完成则恢复初始文案，便于重试
      btn.textContent = imgEl.hidden ? old : "📸 重新生成海报";
    });
  }

  /* ---------------- 启动 ---------------- */
  buildWall();

  /* 跟随鼠标的辉光 */
  const fxCursor = document.getElementById("fxCursor");
  if (fxCursor && window.matchMedia("(pointer:fine)").matches) {
    window.addEventListener("mousemove", (e) => {
      fxCursor.style.setProperty("--mx", e.clientX + "px");
      fxCursor.style.setProperty("--my", e.clientY + "px");
      document.body.classList.add("cursor-on");
    });
    document.addEventListener("mouseleave", () => document.body.classList.remove("cursor-on"));
  }
})();
