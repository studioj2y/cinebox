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
    quizCardEl = $("#quizCard");
    replyStreamEl = $("#replyStream");
    replyStreamEl.innerHTML = "";
    // 重建问题卡默认结构（summary 屏会覆盖 innerHTML，重测时需复原）
    quizCardEl.innerHTML = '<div class="q-cat" id="qCat"></div><h2 id="qText"></h2><div id="qOptions" class="options"></div>';
    quizCardEl.classList.remove("dissolve", "enter");
    show("quiz");
    renderQuestion(0);
  }
  function renderQuestion(idx) {
    const q = quizQs[idx];
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
    // 问题卡进场：从下方淡入
    quizCardEl.classList.remove("enter");
    void quizCardEl.offsetWidth;
    quizCardEl.classList.add("enter");
  }
  function chooseOption(idx, opt) {
    answers.push(opt);
    // 把这句回复淡入上移到顶部回复流
    const item = document.createElement("div");
    item.className = "reply-item";
    item.textContent = opt.reply || "好，记下了~";
    replyStreamEl.appendChild(item);
    requestAnimationFrame(() => item.classList.add("in"));
    replyStreamEl.scrollTop = replyStreamEl.scrollHeight;
    // 当前问题卡溶解
    quizCardEl.classList.add("dissolve");
    setTimeout(() => {
      if (idx + 1 < QUIZ_N) {
        renderQuestion(idx + 1);
      } else {
        $("#progressBar").style.width = "100%";
        renderSummary();
      }
    }, 420);
  }
  function renderSummary() {
    const replies = answers.map((a) => a.reply || "好，记下了~").filter(Boolean);
    quizCardEl.innerHTML =
      '<div class="summary">' +
        '<div class="summary-kicker">你刚才说——</div>' +
        '<div class="summary-replies">' + replies.map((r) => '<span class="sr">' + r + '</span>').join("") + '</div>' +
        '<p class="summary-line">好了，今晚的你也聊完了。<br>接下来，让一部电影接住你。</p>' +
        '<button id="revealBtn" class="cta">揭晓今晚的电影 →</button>' +
      '</div>';
    quizCardEl.classList.remove("dissolve");
    void quizCardEl.offsetWidth;
    quizCardEl.classList.add("enter");
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
    $("#aiPrompt").hidden = true;
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
    const W = window.Match.aggregate(answers);
    const answersText = quizQs.map((q, i) => `${i + 1}. ${q.question} → ${answers[i] ? answers[i].text : ""}`).join("\n");
    const prompt = window.Match.buildInterpretPrompt(answersText, current);
    const pre = $("#aiPrompt");
    pre.hidden = false;
    pre.classList.add("loading");
    pre.textContent = "正在探究你的内心，请稍后…";
    try {
      const resp = await fetch(AGNES.base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + AGNES.key },
        body: JSON.stringify({
          model: AGNES.model,
          temperature: 0.8,
          max_tokens: 500,
          messages: [
            { role: "system", content: "你是「不良少女放映组」的观影向导，懂电影也懂人心。用温暖、像朋友一样的语气写一段中文解读，可以带一点点不羁、漫不经心的酷劲儿——但别太用力，保持真诚自然。不要使用任何 markdown 格式。" },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      let text = (data.choices && data.choices[0] && data.choices[0].message.content) || "";
      text = text.trim();
      // 兜底：无论返回如何，结尾必带「今晚就它了。」
      if (text && !/今晚就它了[。\.！!]?$/.test(text.replace(/\s+$/, ""))) {
        text = text.replace(/\s+$/, "") + "\n\n今晚就它了。";
      } else if (!text) {
        text = "（AI 返回为空）";
      }
      pre.classList.remove("loading");
      pre.textContent = text;
    } catch (e) {
      pre.classList.remove("loading");
      pre.textContent = "（AI 接口暂不可用：" + e.message + "）\n\n以下是已构造的提示词，可手动发给任意 LLM：\n\n" + prompt;
    }
    pre.scrollIntoView({ behavior: "smooth" });
  };

  /* ---------------- 启动 ---------------- */
  buildWall();
})();
