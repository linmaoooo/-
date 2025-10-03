/* =========================================================
   九宮格抽獎（保留原動畫與結構｜抽後浮窗｜清除紀錄｜穩定寫回 Google Sheets）
   - 不更動你原本的 HTML/CSS 與動畫（<button class="card"><div class="cardInner">…）
   - 抽後：本地先扣 ➜ 浮窗顯示 ➜ 序列化寫回 Apps Script（多通道重試）➜ 延遲刷新（afterDraw）
   - 刪單回補：本地 +1 ➜ 序列化寫回 ➜ 延遲刷新（afterDelete）
   - 合併提示（merge hint）5 秒：抽後用 min、刪後用 max，避免被中立刷新覆蓋
   - 關閉浮窗後才能繼續操作，並啟動下一輪洗牌
   ========================================================= */

/* ====== 你的設定 ====== */
const SHEET_ID  = "1lDiuyoWrT_hGEckvfBq33WUmn3Jetjhkr_5L_GXnUMA";
const API_KEY   = "AIzaSyCDc7LumKdOSOrnB0J8CROm3Qy2949sysk";
const CANDIDATE_RANGES = ["sheet1!A:G", "工作表1!A:G", "Sheet1!A:G", "A:G"]; // 多表名相容

// 你的 Apps Script Web App（/exec）
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzvpU99IpaqlZIsXTo9kkrQ6InJ8uCsyZrHQ_h597TAMbJYhvwscJGuiRbc5RQZpfXUIg/exec";

/* 行為設定 */
const REFRESH_ON_CLICK = false;
const REFRESH_BEFORE_EACH_DRAW = false;
const POST_DRAW_REFRESH_DELAY_MS = 500;

/* 動畫用時（沿用你原本節奏） */
const SHUFFLE_GATHER_MS  = 500;
const SHUFFLE_SCATTER_MS = 500;

/* ====== DOM ====== */
const boardEl         = document.getElementById("board");
const invBody         = document.getElementById("invBody");
const invSummary      = document.getElementById("invSummary");

const historyBtn      = document.getElementById("historyBtn");
const historyDlg      = document.getElementById("historyDlg");
const historyBody     = document.getElementById("historyBody");
const exportCsvBtn    = document.getElementById("exportCsvBtn");
const closeHistoryBtn = document.getElementById("closeHistoryBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

/* 抽獎結果浮動視窗（名稱置中加粗、圖片顯示；關閉後才可再操作） */
const resultModal     = document.getElementById("resultModal");
const modalPrizeName  = document.getElementById("modalPrizeName");
const modalPrizeImage = document.getElementById("modalPrizeImage");
const modalImgWrap    = document.getElementById("modalImgWrap");
const modalOkBtn      = document.getElementById("modalOkBtn");

/* ====== 狀態 ====== */
let prizesMap = {};        // 1..9 => { id, name, desc, image, remain, weight }
let drawHistory = [];      // [{ ts, id, name, remain, deleted }]
let isShuffling = false;
let pickedThisRound = false;
let waitingForNext = false;
let modalOpen = false;

/* ====== 小工具 ====== */
function escapeHtml(s){ return String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
function intOr(x, d=0){ const n=Number(x); return Number.isFinite(n)?n:d; }
function waitMs(ms){ return new Promise(r => setTimeout(r, ms)); }
function formatTS(ts){ const d=new Date(ts||Date.now()),p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function extractImageUrl(raw){
  if (!raw) return "";
  const s = String(raw).trim();
  const m = s.match(/^=?(?:IMAGE|image)\s*\(\s*"(https?:\/\/[^"]+)"\s*(?:,.*)?\)$/);
  return m ? m[1] : s;
}

// 立即解除抽獎點擊鎖（不動你的動畫）
function unlockDrawImmediately(){
  pickedThisRound = false;
  waitingForNext = false;
  isShuffling = false;
  modalOpen = false;                // 只針對結果浮窗
  boardEl?.classList?.remove('animating'); // 若曾進入洗牌，確保不殘留
}

/* ====== 合併提示（避免抽/刪後被中立刷新覆蓋） ====== */
// key = prize.id || prize.name
const mergeHints = new Map(); // key -> { mode: 'afterDraw'|'afterDelete', until: ts }
function prizeKeyOf(p){ return (p && (p.id || p.name)) ? String(p.id || p.name) : ""; }
function setMergeHint(prize, mode, ttlMs = 5000){ const key = prizeKeyOf(prize); if (!key) return; mergeHints.set(key, { mode, until: Date.now() + ttlMs }); }
function getEffectiveHintFor(key){ const rec = mergeHints.get(key); if (!rec) return null; if (rec.until < Date.now()) { mergeHints.delete(key); return null; } return rec; }

/* ====== 只在 #board 為空時補 9 張卡（結構與 class 100% 沿用你原本） ====== */
function buildBoardBacks(){
  if (!boardEl) return;
  if (boardEl.querySelectorAll(".card").length) return; // 已有就不動
  for (let i = 1; i <= 9; i++) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card";
    card.dataset.idx = String(i);

    const inner = document.createElement("div");
    inner.className = "cardInner";

    const back = document.createElement("div");
    back.className = "face back";
    back.textContent = "點我抽";

    const front = document.createElement("div");
    front.className = "face front";
    front.innerHTML = `<div class="prizeName">—</div><div class="prizeMeta"></div>`;

    inner.appendChild(back);
    inner.appendChild(front);
    card.appendChild(inner);
    boardEl.appendChild(card);
  }
}

/* ====== 右側清單 ====== */
function totalRemain(){ return Object.values(prizesMap).reduce((s,p)=>s+Math.max(0,p?.remain??0),0); }
function renderInventoryTable(){
  if (!invBody) return;
  const items = Object.values(prizesMap)
    .filter(p => (p.remain ?? 0) > 0 && (p.name ?? "").trim() !== "")
    .map(p => ({ name: p.name, remain: p.remain }))
    .sort((a,b) => a.remain - b.remain || a.name.localeCompare(b.name,"zh-Hant"));

  if (items.length===0){
    invBody.innerHTML = `<tr><td colspan="2">（已無剩餘獎項）</td></tr>`;
    if (invSummary) invSummary.textContent = "總剩餘：0";
    return;
  }
  invBody.innerHTML = items.map(it=>`<tr><td>${escapeHtml(it.name)}</td><td style="text-align:right">${it.remain}</td></tr>`).join("");
  if (invSummary) invSummary.textContent = `總剩餘：${totalRemain()}，品項數：${items.length}`;
}

/* ====== 歷史紀錄（表格 + 控制） ====== */
function renderHistoryTable(){
  if (!historyBody) return;
  if (drawHistory.length===0){ historyBody.innerHTML = `<tr><td colspan="4">目前沒有紀錄</td></tr>`; return; }
  const rows = [...drawHistory].reverse();
  historyBody.innerHTML = rows.map((rec, idxNewest) => {
    const cls = rec.deleted ? 'style="opacity:.55;text-decoration:line-through;"' : "";
    const btn = rec.deleted ? `<button class="btn" disabled>已刪除</button>`
                            : `<button class="btn" data-del-index="${idxNewest}">刪除（還原庫存）</button>`;
    return `<tr>
      <td>${formatTS(rec.ts)}</td>
      <td ${cls}>${escapeHtml(rec.name)}</td>
      <td style="text-align:right;" ${cls}>${rec.remain}</td>
      <td style="text-align:right;">${btn}</td>
    </tr>`;
  }).join("");
}
function updateClearHistoryBtnState(){
  if (!clearHistoryBtn) return;
  const has = (drawHistory||[]).length>0;
  clearHistoryBtn.disabled = !has;
}
historyBtn?.addEventListener("click", () => { renderHistoryTable(); updateClearHistoryBtnState(); historyDlg?.showModal?.(); });
closeHistoryBtn?.addEventListener("click", () => historyDlg?.close?.());
exportCsvBtn?.addEventListener("click", exportHistoryCSV);
historyBody?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-del-index]");
  if (!btn) return;
  const idxNewest = Number(btn.getAttribute("data-del-index"));
  if (!Number.isFinite(idxNewest)) return;
  if (!confirm("確定要刪除此筆紀錄並將獎品歸還庫存？")) return;
  deleteHistoryAt(idxNewest);
});
clearHistoryBtn?.addEventListener("click", () => {
  if (!drawHistory || drawHistory.length === 0) return;
  const ok = window.confirm("確定要清除全部抽獎紀錄嗎？此動作無法復原。");
  if (!ok) return;
  drawHistory.length = 0;
  saveHistoryToStorage();
  renderHistoryTable();
  updateClearHistoryBtnState();
});

/* ====== CSV 匯出 ====== */
function exportHistoryCSV(){
  const header = ["時間","獎項","抽後剩餘","狀態"];
  const lines = [header.join(",")];
  drawHistory.forEach(rec=>{
    const name = `"${String(rec.name).replace(/"/g,'""')}"`;
    lines.push([formatTS(rec.ts), name, rec.remain, rec.deleted?"已刪除":"有效"].join(","));
  });
  const csvContent = "\uFEFF"+lines.join("\n");
  const blob = new Blob([csvContent],{type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `抽獎紀錄_${Date.now()}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ====== 解析 Sheets ====== */
function parseSheetValues(values){
  const header = values[0].map(h=>String(h||"").trim().toLowerCase());
  const findCol=(...names)=>{ for(const n of names){ const i=header.indexOf(n.toLowerCase()); if(i!==-1) return i; } return -1; };
  const cId     = findCol("id","編號");
  const cName   = findCol("name","名稱","品名","獎項");
  const cQty    = findCol("qty","數量","總量");
  const cRemain = findCol("remain","剩餘");
  const cWeight = findCol("weight","權重","機率");
  const cImage  = findCol("image","圖片","img","photo","picture");
  const cDesc   = findCol("desc","描述","說明");

  const list=[];
  for(let r=1;r<values.length;r++){
    const row = values[r]||[];
    const name = String(row[cName]||"").replace(/[\u200B-\u200D\uFEFF]/g,"").trim();
    if(!name) continue;
    const qty    = cQty    !==-1 ? intOr(row[cQty],1) : 1;
    const remain = cRemain !==-1 ? intOr(row[cRemain],qty) : qty;
    const weight = cWeight !==-1 ? intOr(row[cWeight],1) : 1;
    const image  = cImage  !==-1 ? String(row[cImage]||"").trim() : "";
    const desc   = cDesc   !==-1 ? String(row[cDesc] ||"").trim() : "";
    const id     = cId     !==-1 ? String(row[cId]   ||"").trim() : "";
    list.push({ id:id||name, name, qty, remain, weight, image, desc });
  }
  const map={}; for(let i=0;i<9;i++) if(list[i]) map[i+1]=list[i]; return map;
}

/* ====== 讀 Sheets（多 range fallback） ====== */
async function fetchFromSheetsWithFallback(){
  let lastErr=null;
  for(const range of CANDIDATE_RANGES){
    const url=`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?key=${API_KEY}`;
    try{
      const res = await fetch(url,{cache:"no-store"});
      if(!res.ok){ lastErr=new Error(`HTTP ${res.status}`); continue; }
      const data = await res.json();
      if(!data.values || data.values.length<2){ lastErr=new Error("空資料或只有表頭"); continue; }
      return parseSheetValues(data.values);
    }catch(e){ lastErr=e; continue; }
  }
  throw lastErr || new Error("無法從任何 Range 取得資料");
}

/* ====== 從 Sheets 讀最新並合併（支援 mode/hint） ====== */
// mode: 'afterDraw' | 'afterDelete' | 'neutral' | 'auto' (預設 'auto')
async function refreshFromSheetsAndMerge(mode = 'auto'){
  const fresh = await fetchFromSheetsWithFallback();
  const freshList = Object.values(fresh);

  for (let i = 1; i <= 9; i++) {
    const incoming = fresh[i] || freshList[i-1];
    if (!incoming) continue;

    const local  = prizesMap[i] || {};
    const merged = { ...incoming };

    const lrem = typeof local.remain    === 'number' ? local.remain    : null;
    const irem = typeof incoming.remain === 'number' ? incoming.remain : null;

    let effMode = mode;
    if (effMode === 'auto') {
      const key = prizeKeyOf(incoming) || prizeKeyOf(local);
      const hint = key ? getEffectiveHintFor(key) : null;
      effMode = hint ? hint.mode : 'neutral';
    }

    if (lrem != null && irem != null) {
      if (effMode === 'afterDraw')      merged.remain = Math.min(lrem, irem);   // 抽後：取較小值
      else if (effMode === 'afterDelete') merged.remain = Math.max(lrem, irem); // 刪後：取較大值
      else                                merged.remain = irem;                 // 中立：以雲端為準
    }
    prizesMap[i] = merged;
  }

  renderInventoryTable();
}

/* ====== 穩定寫回 Google Sheets：序列化佇列 + 多通道重試 ====== */
let writeRunning = false;
const writeQ = []; // {payload, resolve, reject}

function syncRemainToServer({ id, name, remain }){
  return new Promise((resolve, reject) => {
    writeQ.push({ payload: { id, name, remain }, resolve, reject });
    if (!writeRunning) processWriteQ();
  });
}

async function processWriteQ(){
  writeRunning = true;
  while (writeQ.length){
    const { payload, resolve, reject } = writeQ.shift();
    try {
      await sendToAppsScriptWithRetries(payload);
      resolve(true);
    } catch (e) {
      console.warn("寫回失敗：", e);
      reject(e);
    }
  }
  writeRunning = false;
}

async function sendToAppsScriptWithRetries({ id, name, remain }){
  const MAX_TRY = 3;
  const backoff = i => waitMs(250 * (i+1));

  async function tryFetch(url, options){
    const r = await fetchWithTimeout(url, options, 10000);
    const txt = await r.text().catch(()=> "");
    // 允許純文字 "ok" 或 JSON {ok:true,...}
    const ok = /(^|\b)ok\b/i.test(txt);
    if (ok) return true;
    try {
      const j = JSON.parse(txt);
      if (j && j.ok === true) return true;
    } catch {}
    throw new Error("GAS not ok: " + txt);
  }

  for (let i=0;i<MAX_TRY;i++){
    try {
      // 先用 JSON（與你 GAS 對齊）
      await tryFetch(APPS_SCRIPT_URL, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ op:"setRemain", id, name, remain }),
        mode:"cors"
      });
      return;
    } catch(e1){
      try {
        // 再試 x-www-form-urlencoded
        await tryFetch(APPS_SCRIPT_URL, {
          method:"POST",
          headers:{ "Content-Type":"application/x-www-form-urlencoded" },
          body: new URLSearchParams({ op:"setRemain", id:id||"", name:name||"", remain:String(remain) }).toString(),
          mode:"cors"
        });
        return;
      } catch(e2){
        try {
          // 最後用 GET（備援）
          const qs = new URLSearchParams({ op:"setRemain", id:id||"", name:name||"", remain:String(remain) }).toString();
          await tryFetch(`${APPS_SCRIPT_URL}?${qs}`, { method:"GET", mode:"cors" });
          return;
        } catch(e3){
          if (i === MAX_TRY-1) throw e3;
          await backoff(i);
        }
      }
    }
  }
}

// fetch 加上逾時計時
function fetchWithTimeout(resource, options={}, timeout=8000){
  return new Promise((resolve, reject) => {
    const t = setTimeout(()=>reject(new Error("timeout")), timeout);
    fetch(resource, options).then(r=>{
      clearTimeout(t);
      // Apps Script 常回 200 即代表已接受；不強制解析 body
      if (!r.ok) reject(new Error("HTTP "+r.status));
      else resolve(r);
    }).catch(err => { clearTimeout(t); reject(err); });
  });
}

/* ====== 權重抽選 ====== */
function drawRandomPrize(){
  const items = Object.values(prizesMap).filter(p => (p.remain??0)>0 && (p.name??"").trim()!=="");
  if (items.length===0) return null;
  const totalW = items.reduce((s,p)=>s+(p.weight||1),0);
  if (!Number.isFinite(totalW) || totalW<=0) return items[Math.floor(Math.random()*items.length)];
  let r = Math.random()*totalW;
  for(const it of items){ r -= (it.weight||1); if (r<=0) return it; }
  return items.at(-1);
}

/* ====== 結果浮動視窗 ====== */
function openResultModal(prize){
  modalOpen = true;
  document.body.classList.add("modal-open");
  if (modalPrizeName)  modalPrizeName.textContent = prize?.name || "—";
  const url = extractImageUrl(prize?.image || "");
  if (url && /^https?:\/\//i.test(url)){
    if (modalPrizeImage){ modalPrizeImage.src = url; modalPrizeImage.alt = prize?.name || ""; }
    if (modalImgWrap) modalImgWrap.style.display = "";
  } else {
    if (modalPrizeImage) modalPrizeImage.removeAttribute("src");
    if (modalImgWrap)    modalImgWrap.style.display = "none";
  }
  resultModal?.classList.add("open");
}
function closeResultModalAndContinue(){
  resultModal?.classList.remove("open");
  document.body.classList.remove("modal-open");
  modalOpen = false;
  const hasRemain = Object.values(prizesMap).some(p => (p.remain ?? 0) > 0);
  if (hasRemain) startShuffle(); // 關閉後立刻啟動下一輪洗牌（保留你的節奏）
}
modalOkBtn?.addEventListener("click", closeResultModalAndContinue);

/* ====== 洗牌（集中→散開；沿用你原本的思路） ====== */
async function startShuffle() {
  pickedThisRound = false;
  waitingForNext = false;
  isShuffling = true;

  if (REFRESH_BEFORE_EACH_DRAW) {
    try { await refreshFromSheetsAndMerge('neutral'); } catch(e){ console.warn("洗牌前刷新失敗：", e); }
  }

  const cards = Array.from(boardEl.querySelectorAll(".card"));
  // 清翻面（CSS 以 .card.flipped 控制動畫）
  cards.forEach(c => c.classList.remove("flipped"));

  // 量測初始位置
  const boardRect = boardEl.getBoundingClientRect();
  const positions = cards.map(el => {
    const r = el.getBoundingClientRect();
    return { el, left: r.left - boardRect.left, top: r.top - boardRect.top, width: r.width, height: r.height };
  });

  // 設置容器鎖高，避免動畫過程跳動
  boardEl.classList.add("animating");
  boardEl.style.position = "relative";
  boardEl.style.minHeight = boardRect.height + "px";

  // 固定卡片為絕對定位
  positions.forEach(p => {
    Object.assign(p.el.style, {
      position:"absolute", left:p.left+"px", top:p.top+"px",
      width:p.width+"px", height:p.height+"px",
      transition:"none", transform:"translate(0,0) scale(1)"
    });
  });

  // 集中
  await waitMs(20);
  positions.forEach(p => {
    p.el.style.transition = `transform ${SHUFFLE_GATHER_MS}ms ease`;
    p.el.style.transform  = `translate(${(boardRect.width/2 - p.left - p.width/2)}px, ${(boardRect.height/2 - p.top - p.height/2)}px) scale(0.96)`;
  });

  await waitMs(SHUFFLE_GATHER_MS + 10);

  // 散開（隨機微位移）
  positions.forEach(p => {
    const dx=(Math.random()-0.5)*12, dy=(Math.random()-0.5)*12;
    p.el.style.transition = `transform ${SHUFFLE_SCATTER_MS}ms ease`;
    p.el.style.transform  = `translate(0,0) scale(1) translate(${dx}px, ${dy}px)`;
  });

  await waitMs(SHUFFLE_SCATTER_MS);
  positions.forEach(p => {
    Object.assign(p.el.style, { position:"", left:"", top:"", width:"", height:"", transition:"", transform:"" });
  });
  boardEl.classList.remove("animating");
  boardEl.style.minHeight = "";
  isShuffling = false;
}

/* ====== 刪除單筆紀錄（回補） ====== */
function deleteHistoryAt(idxNewest){
  const origIdx = drawHistory.length - 1 - idxNewest;
  const rec = drawHistory[origIdx];
  if (!rec || rec.deleted) return;

  rec.deleted = true;

  // 找回對應獎品
  let prize = null;
  for (const k of Object.keys(prizesMap)) {
    const p = prizesMap[k];
    if (!p) continue;
    if ((rec.id && p.id === rec.id) || p.name === rec.name) { prize = p; break; }
  }
  if (!prize) return;

  // 本地回補
  prize.remain = Number(prize.remain ?? 0) + 1;
  renderInventoryTable();

  // 合併提示：刪除後採 max
  setMergeHint(prize, 'afterDelete');

  // 序列化寫回（不阻塞 UI）
  syncRemainToServer({ id: prize.id, name: prize.name, remain: prize.remain })
    .catch(err => console.warn("刪除回補寫回失敗：", err));

  // 儲存與重繪
  saveHistoryToStorage();
  renderHistoryTable();
  updateClearHistoryBtnState();

  // 刪除後延遲刷新（afterDelete）
  refreshFromSheetsAndMerge('afterDelete').catch(err => console.warn("刪除後刷新失敗：", err));

  unlockDrawImmediately();
}

/* ====== 點擊九宮格卡片抽獎（保留翻牌動畫，不改 DOM） ====== */
boardEl?.addEventListener("click", async (ev) => {
  const card = ev.target.closest(".card");
  if (!card) return;
  if (pickedThisRound || isShuffling || waitingForNext || modalOpen) return;

  if (REFRESH_ON_CLICK) {
    try { await refreshFromSheetsAndMerge('neutral'); } catch(e){ console.warn("點擊前刷新失敗：", e); }
  }

  const prize = drawRandomPrize();
  if (!prize) return;

  // 翻牌＆填入文字（你的 CSS 以 .card.flipped 觸發動畫）
  const nameEl = card.querySelector(".prizeName");
  const metaEl = card.querySelector(".prizeMeta");
  if (nameEl) nameEl.textContent = prize.name || "—";
  if (metaEl) metaEl.textContent = prize.desc || "";
  card.classList.add("flipped");
  pickedThisRound = true;

  // 本地先扣 → 右側立即更新
  prize.remain = Math.max(0, (prize.remain ?? 0) - 1);
  renderInventoryTable();

  // 合併提示：抽後採 min（有效 5 秒）
  setMergeHint(prize, 'afterDraw');

  // 紀錄
  drawHistory.push({ ts: Date.now(), id: prize.id || null, name: prize.name, remain: prize.remain, deleted: false });
  saveHistoryToStorage();
  renderHistoryTable();
  updateClearHistoryBtnState();

  // 序列化寫回（不阻塞 UI）
  syncRemainToServer({ id: prize.id, name: prize.name, remain: prize.remain })
    .catch(err => console.warn("寫回雲端失敗：", err));

  // 抽後延遲刷新（afterDraw）
  setTimeout(() => {
    refreshFromSheetsAndMerge('afterDraw').catch(err => console.warn("抽後刷新失敗：", err));
  }, POST_DRAW_REFRESH_DELAY_MS);

  // 顯示結果浮窗（按「確定」關閉後才允許再抽/洗牌）
  openResultModal(prize);
});

/* ====== 本地儲存 ====== */
function loadHistoryFromStorage(){ try{ const raw=localStorage.getItem("drawHistory"); const arr=raw?JSON.parse(raw):[]; return Array.isArray(arr)?arr:[]; }catch{return[];} }
function saveHistoryToStorage(){ try{ localStorage.setItem("drawHistory", JSON.stringify(drawHistory)); }catch{} }

/* ====== 啟動 ====== */
(async function init(){
  // 建卡：只有當 #board 裡沒有卡片時才建立（保留你的 DOM 與動畫）
  buildBoardBacks();

  // 載入歷史
  drawHistory = loadHistoryFromStorage();

  // 抓一次雲端
  try {
    prizesMap = await fetchFromSheetsWithFallback();
  } catch (err) {
    console.error("讀取 Google Sheets 失敗：", err);
  }

  // 渲染右側＆歷史
  renderInventoryTable();
  renderHistoryTable();
  updateClearHistoryBtnState();

  // 進場洗牌（保留你的節奏）
  startShuffle();
})();
