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
    const box = $("#qOptions");
    box.innerHTML = "";
    q.options.forEach((opt) => {
      const b = document.createElement("button");
      b.className = "opt";
      b.textContent = opt.text;
      b.onclick = () => {
        answers.push(opt);
        if (idx + 1 < QUIZ_N) {
          renderQuestion(idx + 1);
        } else {
          $("#progressBar").style.width = "100%";
          finishQuiz();
        }
      };
      box.appendChild(b);
    });
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
    pre.textContent = "正在请 AI 解读，请稍候…";
    try {
      const resp = await fetch(AGNES.base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + AGNES.key },
        body: JSON.stringify({
          model: AGNES.model,
          temperature: 0.8,
          max_tokens: 600,
          messages: [
            { role: "system", content: "你是懂电影也懂人心的观影向导。用温暖、像朋友一样的语气，写一段中文解读，不要使用任何 markdown 格式。" },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const text = (data.choices && data.choices[0] && data.choices[0].message.content) || "";
      pre.textContent = text.trim() || "（AI 返回为空）";
    } catch (e) {
      pre.textContent = "（AI 接口暂不可用：" + e.message + "）\n\n以下是已构造的提示词，可手动发给任意 LLM：\n\n" + prompt;
    }
    pre.scrollIntoView({ behavior: "smooth" });
  };

  /* ---------------- 启动 ---------------- */
  buildWall();
})();
