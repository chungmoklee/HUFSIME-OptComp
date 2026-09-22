"use strict";
// 스냅샷 정적 페이지.
//   competitions.json                       대회 목록 (최신이 첫 항목)
//   competitions/<대회>/data/index.json     그 대회의 스냅샷 목록
//   competitions/<대회>/data/<종류>/<날짜>/<시각>.json
//   competitions/<대회>/data/teams/<팀ID>.json
// 서버 API 없이 정적 파일만 읽는다. 한 리포에 여러 대회를 두고 골라 본다.

const $ = (s) => document.querySelector(s);
const state = { comps: [], comp: null, index: null, kind: "leaderboard", rows: [], tz: "UTC", ms: null,
  view: "board", history: null, metric: "rank", span: 0, sel: new Set(), hover: null };

// 현재 대회의 데이터 경로
const dataPath = (rest) => `competitions/${state.comp}/data/${rest}`;

const fmtNum = (v) =>
  v === null || v === undefined || Number.isNaN(v) ? "—"
    : (typeof v === "number" ? v.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : v);

// "20260910/20260910_23" -> {day:"20260910", hour:"23"}
const parseStamp = (s) => {
  const [day, file] = s.split("/");
  return { day, hour: file.slice(-2) };
};

// ── 시간대 ────────────────────────────────────────────────────────────────
// 서버가 남기는 시각은 모두 UTC 다(스냅샷 파일명, generated_at, submitted_at).
// 한국 참가자에게는 UTC 가 낯설어 기본을 KST 로 두되, 해외 접속자는 UTC 가
// 자연스러우므로 브라우저 시간대를 보고 정한다.
const TZ_OFFSET = { KST: 9, UTC: 0 };

function defaultTz() {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (z === "Asia/Seoul") return "KST";
    // 시간대 이름을 못 얻는 브라우저를 위해 오프셋으로도 판단한다.
    if (-new Date().getTimezoneOffset() === 540) return "KST";
  } catch { /* 판단 불가 — 아래 기본값 */ }
  return "UTC";
}

// "2026-09-10 23:20:49 UTC" / "2026-09-10T09:07:00" 등을 UTC 로 해석한다.
// 뒤에 시간대 표시가 없어도 서버 값은 UTC 이므로 Z 를 붙여 파싱한다.
function parseUTC(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/\s+UTC$/i, "").replace(" ", "T");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) t += "Z";
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

const pad2 = (n) => String(n).padStart(2, "0");

// UTC 시각을 현재 선택한 시간대로 표시한다.
function fmtTime(text, withSeconds = false) {
  const d = parseUTC(text);
  if (!d) return text || "-";
  const shifted = new Date(d.getTime() + TZ_OFFSET[state.tz] * 3600e3);
  const base = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-` +
    `${pad2(shifted.getUTCDate())} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad2(shifted.getUTCSeconds())} ${state.tz}`
                     : `${base}`;
}


async function getJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

function stampsFor(kind) {
  return (state.index.kinds && state.index.kinds[kind]) || [];
}

// ── 시점 선택 ─────────────────────────────────────────────────────────────
// 스냅샷은 UTC 매시 정각에만 존재한다. 달력에서 날짜를 고르면 그 날짜에
// 실제로 데이터가 있는 시각만 드롭다운에 채우고, 시각을 고르면 바로 불러온다.
// 날짜·시각은 화면에 보이는 시간대(KST/UTC) 기준으로 다룬다.

// 스냅샷 "20260910/20260910_23" -> UTC epoch(ms)
function stampToMs(stamp) {
  const { day, hour } = parseStamp(stamp);
  return Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${hour}:00:00Z`);
}

// UTC epoch -> 선택 시간대의 날짜/시각 문자열
function msToLocalParts(ms) {
  const s = new Date(ms + TZ_OFFSET[state.tz] * 3600e3);
  return {
    date: `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())}`,
    hour: pad2(s.getUTCHours()),
  };
}

function allStampMs() {
  return stampsFor(state.kind).map(stampToMs).filter((x) => !isNaN(x)).sort((a, b) => a - b);
}

function latestStamp() {
  const list = allStampMs();
  return list.length ? list[list.length - 1] : null;
}

// 그 날짜(선택 시간대 기준)에 존재하는 시각 목록 — 오름차순
function hoursForDate(dateStr) {
  return allStampMs()
    .map((ms) => ({ ms, p: msToLocalParts(ms) }))
    .filter((x) => x.p.date === dateStr)
    .map((x) => ({ hour: x.p.hour, ms: x.ms }));
}

// 날짜 입력과 시각 드롭다운을 현재 state.ms 에 맞춰 다시 그린다.
function syncPicker() {
  const list = allStampMs();
  const dateEl = $("#sel-date"), hourEl = $("#sel-hour");
  if (!list.length) { dateEl.value = ""; hourEl.innerHTML = ""; return; }

  if (state.ms == null) state.ms = list[list.length - 1];
  const cur = msToLocalParts(state.ms);

  // 데이터가 있는 범위 밖 날짜는 고를 수 없게 한다.
  dateEl.min = msToLocalParts(list[0]).date;
  dateEl.max = msToLocalParts(list[list.length - 1]).date;
  dateEl.value = cur.date;
  fillHours(cur.date, cur.hour);
}

// 날짜에 해당하는 시각만 채운다. 데이터가 없는 날이면 비워 둔다.
function fillHours(dateStr, wantHour) {
  const hourEl = $("#sel-hour");
  const hrs = hoursForDate(dateStr);
  hourEl.innerHTML = hrs.map((h) => `<option value="${h.ms}">${h.hour}:00</option>`).join("");
  if (!hrs.length) { hourEl.value = ""; return; }
  // 원하는 시각이 그 날에 없으면 가장 늦은 시각을 고른다.
  const match = hrs.find((h) => h.hour === wantHour) || hrs[hrs.length - 1];
  hourEl.value = String(match.ms);
  state.ms = match.ms;
}

async function loadBoard() {
  const tbody = $("#tbl tbody");
  // state.ms 는 항상 실제 스냅샷의 시각이다(드롭다운 값이 곧 스냅샷).
  if (state.ms == null) { tbody.innerHTML = ""; $("#empty").hidden = false; return; }
  const u = new Date(state.ms);   // 파일 경로는 UTC 기준이다
  const day = `${u.getUTCFullYear()}${pad2(u.getUTCMonth() + 1)}${pad2(u.getUTCDate())}`;
  const hour = pad2(u.getUTCHours());
  try {
    const data = await getJSON(dataPath(`${state.kind}/${day}/${day}_${hour}.json`));
    state.rows = data.leaderboard || [];
    $("#generated").textContent = `생성 시각: ${fmtTime(data.generated_at, true)}`;
    // 앞서 "그 날짜에는 …" 같은 문구를 띄웠을 수 있으므로 되돌린다.
    $("#empty").textContent = "해당 시각의 리더보드가 없습니다.";
    $("#empty").hidden = state.rows.length > 0;
    // 순위·팀명·점수만 먼저 보여준다. 상세는 클릭 시 조회.
    tbody.innerHTML = state.rows.map((r, i) => `
      <tr>
        <td class="rank">${r.ranking ?? i + 1}</td>
        <td>${r.team_id ? `<button class="team-btn" data-team="${r.team_id}">${r.team_name ?? r.team_id}</button>`
                        : (r.team_name ?? "")}</td>
        <td class="score">${fmtNum(r.total_score)}</td>
      </tr>`).join("");
  } catch (e) {
    tbody.innerHTML = "";
    $("#generated").textContent = "";
    $("#empty").hidden = false;
  }
}

function problemNames(subs) {
  const names = new Set();
  subs.forEach((s) => {
    const tr = s.eval_result && s.eval_result.test_results;
    if (tr) Object.keys(tr).forEach((k) => names.add(k));
  });
  return [...names].sort();
}

async function showTeam(teamId) {
  const row = state.rows.find((r) => r.team_id === teamId) || {};
  $("#d-team").textContent = row.team_name || teamId;
  $("#d-sum").textContent = `순위 ${row.ranking ?? "-"} · 총점 ${fmtNum(row.total_score)}`;
  $("#d-body").innerHTML = "<p class='muted'>불러오는 중…</p>";
  $("#overlay").hidden = false;

  let data;
  try {
    data = await getJSON(dataPath(`teams/${teamId}.json`));
  } catch {
    $("#d-body").innerHTML = "<p class='muted'>제출 이력이 없습니다.</p>";
    return;
  }
  // 최신 제출이 위로 오게
  const subs = (data.submissions || []).slice().reverse();
  if (!subs.length) {
    $("#d-body").innerHTML = "<p class='muted'>제출 이력이 없습니다.</p>";
    return;
  }
  const probs = problemNames(subs);

  // 제출 1건 = 표 1행. 건별로 카드를 쌓으면 P1..Pn 머리글이 매번 반복되어
  // 이력이 수십 건일 때 화면이 수천 px 로 늘어난다. 한 표에 모으면 머리글이
  // 한 줄이고 세로로도 짧아, 제출 간 값 비교도 바로 된다.
  //
  // 각 문제의 최소값(=가장 좋은 해)에 표시를 달아 어느 제출이 최선이었는지
  // 한눈에 보이게 한다.
  const best = {};
  probs.forEach((p) => {
    const vals = subs
      .map((s) => ((s.eval_result || {}).test_results || {})[p])
      .filter((r) => r && r.status === "ok" && typeof r.obj === "number")
      .map((r) => r.obj);
    if (vals.length) best[p] = Math.min(...vals);
  });

  const rows = subs.map((s) => {
    const tr = (s.eval_result && s.eval_result.test_results) || {};
    const cells = probs.map((p) => {
      const r = tr[p];
      if (!r) return "<td>—</td>";
      if (r.status !== "ok") return `<td class="na">${r.status || "—"}</td>`;
      const isBest = best[p] !== undefined && r.obj === best[p];
      return `<td class="${isBest ? "best" : ""}">${fmtNum(r.obj)}</td>`;
    }).join("");
    const when = fmtTime(s.submitted_at);
    return `<tr><td class="when">${when}</td>${cells}</tr>`;
  }).join("");

  $("#d-body").innerHTML = `
    <p class="muted">제출 ${subs.length}건 · 최신순 · 시각은 ${state.tz} · 각 문제의 최고 기록은 굵게</p>
    <div class="wrap"><table class="hist">
      <thead><tr><th>제출 시각</th>${probs.map((p) => `<th>${p}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// ── 순위 변화 그래프 ──────────────────────────────────────────────────────
// history.json 하나로 모든 시각의 순위를 받아 SVG bump chart 를 그린다.
// 라이브러리 없이 <path>/<circle> 을 직접 만든다 — 팀 선택·강조·툴팁만
// 있으면 되므로 차트 라이브러리를 끌어올 만큼 복잡하지 않다.

const CH = { w: 860, h: 460, ml: 44, mr: 34, mt: 14, mb: 30 };

// 팀 구분색. 색맹 접근성을 위해 명도도 함께 달라지는 순서로 골랐다.
// 팀 수가 색 수보다 많으면 순환하되, 강조된 선만 진하게 보이므로 겹쳐도 읽힌다.
const PALETTE = [
  "#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed",
  "#0891b2", "#be185d", "#65a30d", "#ea580c", "#4f46e5",
];
const colorOf = (i) => PALETTE[i % PALETTE.length];

// 화면에 그릴 구간을 잘라낸다. span=0 이면 전체.
function trendSlice() {
  const h = state.history;
  const n = h.stamps.length;
  const from = state.span > 0 ? Math.max(0, n - state.span) : 0;
  return { from, n, stamps: h.stamps.slice(from) };
}

// 지금 그릴 시리즈들. 선택이 없으면 전부 흐리게, 있으면 선택만 진하게.
function trendSeries(from) {
  return state.history.teams.map((t, i) => ({
    id: t.team_id,
    name: t.team_name,
    color: colorOf(i),
    vals: (state.metric === "rank" ? t.rank : t.score).slice(from),
  })).filter((s) => s.vals.some((v) => v !== null && v !== undefined));
}

// 값의 범위. 순위는 1 이 위로 오도록 뒤집어 그린다.
function trendScale(series) {
  let lo = Infinity, hi = -Infinity;
  series.forEach((s) => s.vals.forEach((v) => {
    if (v === null || v === undefined) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }));
  if (!isFinite(lo)) return null;
  if (lo === hi) { lo -= 1; hi += 1; }          // 값이 하나뿐이면 납작해진다
  else if (state.metric === "score") {          // 점수는 위아래로 약간 여유
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  }
  return { lo, hi };
}

function trendGeom(count, sc) {
  const iw = CH.w - CH.ml - CH.mr, ih = CH.h - CH.mt - CH.mb;
  // 점이 하나뿐이면 나누기 0 이 된다 — 가운데에 둔다.
  const x = (i) => count < 2 ? CH.ml + iw / 2 : CH.ml + (i * iw) / (count - 1);
  // 이 대회는 점수가 낮을수록 좋다(1위가 최저점). 순위와 마찬가지로
  // 값이 작을수록 위로 가게 그려야 "위에 있는 선이 앞선 팀"으로 읽힌다.
  const y = (v) => CH.mt + ((v - sc.lo) / (sc.hi - sc.lo)) * ih;
  return { x, y, iw, ih };
}

// null 이 섞인 시계열을 끊어진 선분들로 만든다 — 참가 전/이탈 후 구간을
// 직선으로 이어 버리면 있지도 않은 순위를 보여 주게 된다.
function pathFor(vals, g) {
  const segs = [];
  let cur = [];
  vals.forEach((v, i) => {
    if (v === null || v === undefined) { if (cur.length) segs.push(cur); cur = []; return; }
    cur.push(`${g.x(i).toFixed(1)},${g.y(v).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur);
  // 점 하나짜리 구간은 path 로는 안 보이므로 아래에서 원으로 따로 찍는다.
  return segs.filter((sg) => sg.length > 1).map((sg) => `M${sg.join("L")}`).join(" ");
}

// 시간축 눈금 — 기간에 따라 라벨이 겹치지 않을 만큼만 고른다.
function xTicks(stamps, g) {
  const every = Math.max(1, Math.ceil(stamps.length / 8));
  const out = [];
  stamps.forEach((st, i) => {
    const last = i === stamps.length - 1;
    if (i % every && !last) return;
    // 마지막 눈금이 직전 것과 너무 가까우면 겹쳐 읽히므로 직전 것을 버린다.
    if (last && out.length && g.x(i) - out[out.length - 1].x < 50) out.pop();
    const p = msToLocalParts(stampToMs(st));
    // 양 끝 라벨은 가운데 정렬하면 그림 밖으로 나간다 — 안쪽으로 맞춘다.
    const anchor = i === 0 ? "start" : last ? "end" : "middle";
    out.push({ i, x: g.x(i), anchor, label: `${p.date.slice(5)} ${p.hour}시` });
  });
  return out;
}

function yTicks(sc, g) {
  const out = [];
  const steps = 6;
  for (let k = 0; k <= steps; k++) {
    const v = sc.lo + ((sc.hi - sc.lo) * k) / steps;
    // 순위는 정수만 의미가 있다. 같은 정수가 두 번 나오면 건너뛴다.
    const shown = state.metric === "rank" ? Math.round(v) : v;
    if (state.metric === "rank" && out.some((o) => o.label === String(shown))) continue;
    out.push({ y: g.y(v), label: state.metric === "rank" ? String(shown) : fmtNum(Number(v.toFixed(1))) });
  }
  return out;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function drawTrend() {
  const box = $("#chart"), note = $("#trend-empty");
  const h = state.history;
  if (!h || !h.stamps.length || !h.teams.length) {
    box.innerHTML = ""; note.hidden = false; $("#legend").innerHTML = ""; return;
  }
  const { from, stamps } = trendSlice();
  const series = trendSeries(from);
  const sc = series.length ? trendScale(series) : null;
  if (!sc) { box.innerHTML = ""; note.hidden = false; $("#legend").innerHTML = ""; return; }
  note.hidden = true;

  const g = trendGeom(stamps.length, sc);
  const anySel = state.sel.size > 0;

  const grid = yTicks(sc, g).map((t) => `
    <line class="grid" x1="${CH.ml}" x2="${CH.w - CH.mr}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"/>
    <text class="ytick" x="${CH.ml - 8}" y="${(t.y + 4).toFixed(1)}">${esc(t.label)}</text>`).join("");

  const xs = xTicks(stamps, g).map((t) => `
    <text class="xtick" x="${t.x.toFixed(1)}" y="${CH.h - 8}" text-anchor="${t.anchor}">${esc(t.label)}</text>`).join("");

  // 선택된 선을 나중에 그려 위로 오게 한다 (SVG 는 뒤에 온 것이 위).
  const ordered = series.slice().sort((a, b) =>
    (state.sel.has(a.id) ? 1 : 0) - (state.sel.has(b.id) ? 1 : 0));

  const lines = ordered.map((s) => {
    const on = !anySel || state.sel.has(s.id);
    const d = pathFor(s.vals, g);
    // 앞뒤가 끊긴 외톨이 점은 선으로 안 보이므로 점으로 찍어 준다.
    const lone = s.vals.map((v, i) => {
      if (v === null || v === undefined) return null;
      const prev = s.vals[i - 1], next = s.vals[i + 1];
      const alone = (prev === null || prev === undefined) && (next === null || next === undefined);
      return alone ? `<circle class="dot" cx="${g.x(i).toFixed(1)}" cy="${g.y(v).toFixed(1)}" r="2.5" fill="${s.color}"/>` : null;
    }).filter(Boolean).join("");
    return `<g class="series ${on ? "on" : "off"}" data-team="${esc(s.id)}">
      ${d ? `<path class="line" d="${d}" stroke="${s.color}"/>` : ""}${lone}</g>`;
  }).join("");

  // 마우스 위치를 읽기 위한 투명 판. 선마다 이벤트를 달면 얇아서 잡기 어렵다.
  box.innerHTML = `
    <svg id="svg" viewBox="0 0 ${CH.w} ${CH.h}" preserveAspectRatio="xMidYMid meet"
         role="img" aria-label="팀별 ${state.metric === "rank" ? "순위" : "점수"} 변화 그래프">
      ${grid}${xs}
      <line class="axis" x1="${CH.ml}" y1="${CH.mt}" x2="${CH.ml}" y2="${CH.h - CH.mb}"/>
      <g id="cursor" hidden><line class="cursor" y1="${CH.mt}" y2="${CH.h - CH.mb}"/></g>
      ${lines}
      <rect id="hit" x="${CH.ml}" y="${CH.mt}" width="${g.iw}" height="${g.ih}" fill="transparent"/>
    </svg>
    <div id="tip" hidden></div>`;

  drawLegend(series);
  bindChart(series, stamps, g);
}

function drawLegend(series) {
  const anySel = state.sel.size > 0;
  $("#legend").innerHTML = series.map((s) => {
    const on = !anySel || state.sel.has(s.id);
    const last = [...s.vals].reverse().find((v) => v !== null && v !== undefined);
    return `<button class="lg ${on ? "on" : "off"} ${state.sel.has(s.id) ? "sel" : ""}"
      data-team="${esc(s.id)}" type="button" aria-pressed="${state.sel.has(s.id)}">
      <span class="sw" style="background:${s.color}"></span>${esc(s.name)}
      <span class="lv">${last === undefined ? "—" : (state.metric === "rank" ? `${last}위` : fmtNum(last))}</span>
    </button>`;
  }).join("");
}

// 가장 가까운 시각을 집어 세로선과 툴팁을 띄운다.
function bindChart(series, stamps, g) {
  const svg = $("#svg"), hit = $("#hit"), tip = $("#tip"), cur = $("#cursor");
  if (!svg) return;

  const idxAt = (clientX) => {
    const r = svg.getBoundingClientRect();
    const vx = ((clientX - r.left) / r.width) * CH.w;      // 화면 px -> viewBox 좌표
    if (stamps.length < 2) return 0;
    const t = (vx - CH.ml) / g.iw;
    return Math.max(0, Math.min(stamps.length - 1, Math.round(t * (stamps.length - 1))));
  };

  const move = (clientX, clientY) => {
    const i = idxAt(clientX);
    const x = g.x(i);
    cur.hidden = false;
    cur.querySelector("line").setAttribute("x1", x.toFixed(1));
    cur.querySelector("line").setAttribute("x2", x.toFixed(1));

    const anySel = state.sel.size > 0;
    const at = series
      .filter((s) => !anySel || state.sel.has(s.id))
      .map((s) => ({ s, v: s.vals[i] }))
      .filter((r) => r.v !== null && r.v !== undefined)
      .sort((a, b) => a.v - b.v)     // 순위·점수 모두 작을수록 앞선다
      .slice(0, 12);                     // 팀이 많을 때 툴팁이 화면을 넘지 않게

    const p = msToLocalParts(stampToMs(stamps[i]));
    tip.innerHTML = `<div class="tt-h">${p.date} ${p.hour}:00 ${state.tz}</div>` + at.map((r) =>
      `<div class="tt-r"><span class="sw" style="background:${r.s.color}"></span>${esc(r.s.name)}
        <b>${state.metric === "rank" ? `${r.v}위` : fmtNum(r.v)}</b></div>`).join("");
    tip.hidden = false;

    // 툴팁이 오른쪽 끝에서 잘리지 않도록 넘치면 왼쪽에 붙인다.
    const box = $("#chart").getBoundingClientRect();
    const px = clientX - box.left;
    tip.style.left = (px + tip.offsetWidth + 16 > box.width ? px - tip.offsetWidth - 12 : px + 12) + "px";
    // 세로로도 커서를 피한다. 위 절반에 있으면 아래에, 아래 절반이면 위에 둔다.
    const py = clientY - box.top;
    const below = py < box.height / 2;
    tip.style.top = below
      ? Math.min(py + 16, box.height - tip.offsetHeight - 4) + "px"
      : Math.max(4, py - tip.offsetHeight - 16) + "px";
  };

  hit.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
  hit.addEventListener("mouseleave", () => { tip.hidden = true; cur.hidden = true; });
  // 터치에서도 같은 동작 — 스크롤을 막지 않기 위해 passive 로 둔다.
  hit.addEventListener("touchmove", (e) => { if (e.touches[0]) move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  hit.addEventListener("touchstart", (e) => { if (e.touches[0]) move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
}

function toggleTeam(id) {
  if (state.sel.has(id)) state.sel.delete(id); else state.sel.add(id);
  drawTrend();
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll("#tabs .tab").forEach((b) =>
    b.classList.toggle("on", b.dataset.view === view));
  $("#board").hidden = view !== "board";
  $("#trend").hidden = view !== "trend";
  // 시점 선택은 리더보드 탭에서만 의미가 있다 (그래프는 전 구간을 본다).
  $("#sel-date").closest(".controls").querySelectorAll("label,button").forEach((el) => {
    if (el.querySelector("#sel-comp") || el.querySelector("#sel-tz")) return;
    el.style.display = view === "board" ? "" : "none";
  });
  if (view === "trend") drawTrend();
}

async function loadHistory() {
  try {
    state.history = await getJSON(dataPath("history.json"));
  } catch {
    state.history = null;     // 아직 내보내지 않은 대회일 수 있다
  }
  state.sel = new Set();
}

async function loadCompetition(name) {
  state.comp = name;
  const meta = state.comps.find((c) => c.name === name);
  // 제목은 config 의 [publish] competition_label (registry 의 label) 을 쓴다.
  const label = (meta && meta.label) || name;
  $("#title").textContent = label;
  document.title = `${label} 리더보드`;
  state.index = await getJSON(dataPath("index.json"));
  state.ms = latestStamp();     // 대회를 바꾸면 그 대회의 최신 시점으로
  syncPicker();
  await Promise.all([loadBoard(), loadHistory()]);
  if (state.view === "trend") drawTrend();
}

function bind() {
  $("#sel-comp").addEventListener("change", async (e) => {
    await loadCompetition(e.target.value);
  });
  $("#sel-tz").addEventListener("change", (e) => {
    state.tz = e.target.value;
    try { localStorage.setItem("ogc.tz", state.tz); } catch { /* 저장 실패는 무시 */ }
    syncPicker();           // 입력값을 새 시간대 표기로 다시 쓴다
    loadBoard();            // 생성 시각 문구 갱신
    if (state.view === "trend") drawTrend();   // 축 라벨이 시간대를 따른다
    $("#overlay").hidden = true;   // 열려 있던 상세는 닫는다(시각 표기가 섞이지 않게)
  });
  // 날짜를 고르면 그 날짜에 데이터가 있는 시각만 채우고, 곧바로 불러온다
  // (날짜·시각이 모두 정해지므로 따로 누를 것이 없다).
  $("#sel-date").addEventListener("change", (e) => {
    const cur = state.ms == null ? null : msToLocalParts(state.ms);
    fillHours(e.target.value, cur ? cur.hour : null);
    if ($("#sel-hour").value) {
      loadBoard();
    } else {
      // 그 날짜에 스냅샷이 없다 — 표를 비우고 안내한다.
      $("#tbl tbody").innerHTML = "";
      $("#generated").textContent = "";
      $("#empty").hidden = false;
      $("#empty").textContent = "그 날짜에는 리더보드가 없습니다.";
    }
  });
  $("#sel-hour").addEventListener("change", (e) => {
    const ms = Number(e.target.value);
    if (!isNaN(ms)) { state.ms = ms; loadBoard(); }
  });
  $("#btn-latest").addEventListener("click", () => {
    state.ms = latestStamp(); syncPicker(); loadBoard();
  });
  $("#tbl").addEventListener("click", (e) => {
    const b = e.target.closest(".team-btn");
    if (b) showTeam(b.dataset.team);
  });
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (b) switchView(b.dataset.view);
  });
  $("#sel-metric").addEventListener("change", (e) => { state.metric = e.target.value; drawTrend(); });
  $("#sel-span").addEventListener("change", (e) => { state.span = Number(e.target.value) || 0; drawTrend(); });
  $("#btn-top10").addEventListener("click", () => {
    // history.teams 는 최종 순위순이므로 앞 10개가 곧 상위 10팀이다.
    state.sel = new Set((state.history ? state.history.teams : []).slice(0, 10).map((t) => t.team_id));
    drawTrend();
  });
  $("#btn-all").addEventListener("click", () => { state.sel = new Set(); drawTrend(); });
  $("#btn-none").addEventListener("click", () => {
    // 전부 끄면 볼 것이 없으므로, 1위 팀 하나만 남긴다.
    const first = state.history && state.history.teams[0];
    state.sel = new Set(first ? [first.team_id] : []);
    drawTrend();
  });
  $("#legend").addEventListener("click", (e) => {
    const b = e.target.closest(".lg");
    if (b) toggleTeam(b.dataset.team);
  });
  // 그래프의 선을 직접 눌러도 선택된다.
  $("#chart").addEventListener("click", (e) => {
    const g = e.target.closest(".series");
    if (g) toggleTeam(g.dataset.team);
  });
  $("#close").addEventListener("click", () => { $("#overlay").hidden = true; });
  $("#overlay").addEventListener("click", (e) => {
    if (e.target.id === "overlay") $("#overlay").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("#overlay").hidden = true;
  });
}

(async function init() {
  $("#overlay").hidden = true;
  try {
    const reg = await getJSON("competitions.json");
    state.comps = reg.competitions || [];
    if (!state.comps.length) throw new Error("no competitions");
  } catch {
    $("#empty").hidden = false;
    $("#empty").textContent = "데이터를 불러오지 못했습니다.";
    return;
  }
  // 시간대 기본값: 이전 선택이 있으면 그것, 없으면 접속 지역으로 정한다.
  let tz = null;
  try { tz = localStorage.getItem("ogc.tz"); } catch { /* 읽기 실패는 무시 */ }
  state.tz = (tz === "KST" || tz === "UTC") ? tz : defaultTz();
  $("#sel-tz").value = state.tz;

  // competitions.json 은 최신 대회가 첫 항목이다 — 그것을 기본 선택한다.
  $("#sel-comp").innerHTML = state.comps
    .map((c) => `<option value="${c.name}">${c.label || c.name}</option>`).join("");
  bind();
  try {
    await loadCompetition(state.comps[0].name);
  } catch {
    $("#empty").hidden = false;
    $("#empty").textContent = "데이터를 불러오지 못했습니다.";
  }
})();
