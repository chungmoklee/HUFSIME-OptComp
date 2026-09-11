"use strict";
// 스냅샷 정적 페이지.
//   competitions.json                       대회 목록 (최신이 첫 항목)
//   competitions/<대회>/data/index.json     그 대회의 스냅샷 목록
//   competitions/<대회>/data/<종류>/<날짜>/<시각>.json
//   competitions/<대회>/data/teams/<팀ID>.json
// 서버 API 없이 정적 파일만 읽는다. 한 리포에 여러 대회를 두고 골라 본다.

const $ = (s) => document.querySelector(s);
const state = { comps: [], comp: null, index: null, kind: "leaderboard", rows: [] };

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
const fmtDay = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

async function getJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

function stampsFor(kind) {
  return (state.index.kinds && state.index.kinds[kind]) || [];
}

function fillDates() {
  const days = [...new Set(stampsFor(state.kind).map((s) => parseStamp(s).day))].sort().reverse();
  const sel = $("#sel-date");
  sel.innerHTML = days.map((d) => `<option value="${d}">${fmtDay(d)}</option>`).join("");
  fillHours();
}

function fillHours() {
  const day = $("#sel-date").value;
  const hours = stampsFor(state.kind)
    .map(parseStamp).filter((p) => p.day === day).map((p) => p.hour)
    .sort().reverse();
  const sel = $("#sel-hour");
  sel.innerHTML = hours.map((h) => `<option value="${h}">${h}:00</option>`).join("");
}

async function loadBoard() {
  const day = $("#sel-date").value, hour = $("#sel-hour").value;
  const tbody = $("#tbl tbody");
  if (!day || !hour) { tbody.innerHTML = ""; $("#empty").hidden = false; return; }
  try {
    const data = await getJSON(dataPath(`${state.kind}/${day}/${day}_${hour}.json`));
    state.rows = data.leaderboard || [];
    $("#generated").textContent = `생성 시각: ${data.generated_at || "-"}`;
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
  $("#d-body").innerHTML = subs.map((s) => {
    const tr = (s.eval_result && s.eval_result.test_results) || {};
    const cells = probs.map((p) => {
      const r = tr[p];
      if (!r) return "<td>—</td>";
      const ok = r.status === "ok";
      return `<td class="${ok ? "" : "na"}">${ok ? fmtNum(r.obj) : (r.status || "—")}</td>`;
    }).join("");
    const when = (s.submitted_at || "").replace("T", " ").slice(0, 19);
    return `<div class="sub">
      <h3>${when} <span class="muted">· ${s.eval_status || "-"}</span></h3>
      <div class="wrap"><table>
        <thead><tr>${probs.map((p) => `<th>${p}</th>`).join("")}</tr></thead>
        <tbody><tr>${cells}</tr></tbody>
      </table></div>
    </div>`;
  }).join("");
}

async function loadCompetition(name) {
  state.comp = name;
  const meta = state.comps.find((c) => c.name === name);
  $("#title").textContent = (meta && meta.label) || name;
  state.index = await getJSON(dataPath("index.json"));
  fillDates();
  await loadBoard();
}

function bind() {
  $("#sel-comp").addEventListener("change", async (e) => {
    await loadCompetition(e.target.value);
  });
  $("#sel-kind").addEventListener("change", (e) => {
    state.kind = e.target.value; fillDates(); loadBoard();
  });
  $("#sel-date").addEventListener("change", () => { fillHours(); loadBoard(); });
  $("#sel-hour").addEventListener("change", loadBoard);
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
