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
  function typeText(el, text) {
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
    replyStreamEl.innerHTML = "";
    // 重建问题卡默认结构（summary 屏会覆盖 innerHTML，重测时需复原）
    quizCardEl.innerHTML = '<div class="q-index" id="qIdx"></div><div class="q-cat" id="qCat"></div><h2 id="qText"></h2><div id="qOptions" class="options"></div>';
    quizCardEl.classList.remove("dissolve", "enter");
    show("quiz");
    renderQuestion(0);
  }
  function renderQuestion(idx) {
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
  }
  function chooseOption(idx, opt) {
    if (quizLocked) return; // 防重复点击/穿透，避免跳题或重来
    quizLocked = true;
    answers.push(opt);
    // 把这句回复淡入上移到顶部回复流
    const item = document.createElement("div");
    item.className = "reply-item";
    item.textContent = opt.reply || "好，记下了~";
    replyStreamEl.appendChild(item);
    requestAnimationFrame(() => item.classList.add("in"));
    replyStreamEl.scrollTop = replyStreamEl.scrollHeight;
    // 当前问题卡溶解（放慢节奏，给一点呼吸感）
    quizCardEl.classList.add("dissolve");
    setTimeout(() => {
      if (idx + 1 < QUIZ_N) {
        renderQuestion(idx + 1);
      } else {
        $("#progressBar").style.width = "100%";
        renderSummary();
      }
      quizLocked = false;
    }, 800);
  }
  function renderSummary() {
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

  /* AI 全盘解读：直接调用 agnes-ai（暂用通用 key；生产建议走服务端代理避免泄露） */
  const AGNES = {
    base: "https://apihub.agnes-ai.com/v1",
    key: "sk-0A9xpNX1MgK5hqMWZZcUGYRfYMiW1bapWk7j3RRDQQgKXwSp",
    model: "agnes-2.5-flash",
  };
  $("#aiBtn").onclick = async () => {
    if (aiLoading) return; // 防重复点击/并发，避免重复请求
    aiLoading = true;
    const W = window.Match.aggregate(answers);
    const answersText = quizQs.map((q, i) => `${i + 1}. ${q.question} → ${answers[i] ? answers[i].text : ""}`).join("\n");
    const prompt = window.Match.buildInterpretPrompt(answersText, current);
    const pre = $("#aiPrompt");
    pre.hidden = false;
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    pre.classList.remove("typing");
    requestAnimationFrame(() => pre.classList.add("show"));
    pre.classList.add("loading");
    pre.textContent = "正在探究你的内心，请稍后…";
    // 强制把画面拉到最下，确保解读框（在内容下方）立即可见
    requestAnimationFrame(() => { pre.scrollIntoView({ behavior: "smooth", block: "end" }); scrollResultBottom(); });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const MIN_LEN = 18; // 低于此长度视为被截断/异常短，触发重试
    let text = "";
    let lastErr = "";
    const MAX = 3;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 30000); // 30s 超时，避免悬挂
        const resp = await fetch(AGNES.base + "/chat/completions", {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + AGNES.key },
          body: JSON.stringify({
            model: AGNES.model,
            temperature: 0.8,
            max_tokens: 900, // 调大，避免较长解读被服务端截断
            messages: [
              { role: "system", content: "你是「不良少女放映组」的观影向导，懂电影也懂人心。用温暖、像朋友一样的语气写一段中文解读，可以带一点点不羁、漫不经心的酷劲儿——但别太用力，保持真诚自然。不要使用任何 markdown 格式。" },
              { role: "user", content: prompt },
            ],
          }),
        });
        clearTimeout(to);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        let data;
        try { data = await resp.json(); }
        catch (e) { throw new Error("返回数据解析失败（疑似被截断）"); }
        let t = (data.choices && data.choices[0] && data.choices[0].message.content) || "";
        t = t.trim();
        // 疑似截断 / 异常短：视为不稳定，重试
        if (t.length < MIN_LEN) {
          lastErr = "内容过短（疑似截断）";
          if (attempt < MAX) { pre.textContent = "信号有点飘，我再探一次…"; await sleep(1000); continue; }
          t = ""; // 用尽重试仍过短 → 当作空处理
        }
        text = t;
        break;
      } catch (e) {
        lastErr = e.name === "AbortError" ? "请求超时" : e.message;
        if (attempt < MAX) { pre.textContent = "网络打了个嗝，重新连一下…"; await sleep(1200); continue; }
      }
    }

    if (!text) {
      // 空 / 全部失败：温柔话术，提示可再次点击重新生成
      pre.classList.remove("loading", "typing");
      pre.textContent = "心灵太封闭了，深呼吸，我再看一次。\n（点「✦ 不良有话说」再试一回）";
      aiLoading = false;
      return;
    }
    // 兜底：无论返回如何，结尾必带「今晚就它了。」
    if (!/今晚就它了[。\.！!]?$/.test(text.replace(/\s+$/, ""))) {
      text = text.replace(/\s+$/, "") + "\n\n今晚就它了。";
    }
    // 逐字打字机呈现（打字过程中每 tick 钉底，确保最新字可见）
    typeText(pre, text);
    aiLoading = false;
  };

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
