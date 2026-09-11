"use strict";
// 스냅샷 정적 페이지.
//   competitions.json                       대회 목록 (최신이 첫 항목)
//   competitions/<대회>/data/index.json     그 대회의 스냅샷 목록
//   competitions/<대회>/data/<종류>/<날짜>/<시각>.json
//   competitions/<대회>/data/teams/<팀ID>.json
// 서버 API 없이 정적 파일만 읽는다. 한 리포에 여러 대회를 두고 골라 본다.

const $ = (s) => document.querySelector(s);
const state = { comps: [], comp: null, index: null, kind: "leaderboard", rows: [], tz: "UTC", ms: null };

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

async function loadCompetition(name) {
  state.comp = name;
  const meta = state.comps.find((c) => c.name === name);
  $("#title").textContent = (meta && meta.label) || name;
  state.index = await getJSON(dataPath("index.json"));
  state.ms = latestStamp();     // 대회를 바꾸면 그 대회의 최신 시점으로
  syncPicker();
  await loadBoard();
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
