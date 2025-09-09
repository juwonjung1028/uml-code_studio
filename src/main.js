/**
 * ============================================
 * 역할
 *  - UI 제어(탭/토글), 목록 로딩, 다이어그램/코드 렌더링
 *  - 서버 API 연동(/api/*)
 *  - Mermaid 초기화 및 프리뷰
 *
 * 구조(섹션 가이드)
 *  1) 상수/초기화
 *  2) DOM 헬퍼 & 공용 유틸
 *  3) API 클라이언트
 *  4) 렌더링 & 목록 채우기
 *  5) 탭/토글 바인딩 (모드 전환)
 *  6) 변환 핸들러 (요구사항→MM, 코드→MM, MM→코드)
 *  7) 저장 핸들러 (요구사항/다이어그램/코드)
 *  8) 표 목록 로딩 (DB 탭)
 *  9) 부트스트랩(초기 실행)
 * ============================================
 */

import mermaid from 'mermaid';
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default' });

// ---- HMR 재실행 시 중복 리스너 방지용 전역 플래그 ----
window.__UML_APP_FLAGS__ = window.__UML_APP_FLAGS__ || { bound:false, toggleBound:false, tabsBound:false, togglesBound:false };

// ----------------- UI patches (runtime CSS) -----------------
function injectDynamicStyles() {
  if (document.getElementById('dynamic-ui-patches')) return;
  const css = `
  /* 토글-입력 간격 0 */
  .control-stack.tight { gap: 0 !important; }
  .control-stack.tight .row { margin: 0 !important; }
  .control-stack.tight [id$='-db'],
  .control-stack.tight [id$='-man'] { margin-top: 0 !important; }

  /* Mermaid→코드 textarea는 내부 스크롤만 */
  #mm-text {
    max-height: 40vh !important;
    min-height: 24vh !important;
    overflow: auto !important;
    resize: vertical !important;
  }
  `;
  const el = document.createElement('style');
  el.id = 'dynamic-ui-patches';
  el.textContent = css;
  document.head.appendChild(el);
}


// --------------- 헬퍼 ---------------
const qs  = (s,p=document)=>p.querySelector(s);
const qsa = (s,p=document)=>Array.from(p.querySelectorAll(s));
const val = el => (el?.value ?? '').trim();

const TYPE_KR = {
  SYS: '체계 요구사항',
  SW: 'SW 요구사항',
  SW_DES: 'SW 설계 요구사항',
  SW_TEST: 'SW TEST 요구사항'
};
const typeKR = t => TYPE_KR[t] || t;

function stripMermaidFences(s){
  if(!s) return '';
  let t = String(s).trim();
  t = t.replace(/^```(?:mermaid)?\s*/i, '').replace(/\s*```$/i, '');
  if (/^```/.test(t) && /```$/.test(t)) {
    t = t.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  }
  return t.trim();
}

// ── 에디터 주변에서 미리보기 컨테이너 추정
function guessPreviewForEditor(ed){
  const scope = ed.closest('[data-pane], .pane, .tab, section, .card, .panel, .view') || document;
  // 결과 패널 기본 프리뷰(id: *-view) 우선 탐색
  return (
    scope.querySelector('[id$="-view"]') ||                   // ex) #req2mm-view, #code2mm-view
    scope.querySelector('#req-mm-preview, .mermaid-preview, .mm-preview, [id*="preview"]')
  );
}

function sanitizeActivityFlowchartClient(raw){
  let t = stripMermaidFences(String(raw||''));
  // 분기 라벨: --|Yes|-->  →  -->|Yes|
  t = t.replace(/--\|([^|]+)\|-->/g, '-->|$1|')
       .replace(/--\|([^|]+)\|\s+([A-Za-z_][\w]*)/g, '-->|$1| $2');
  // ((Start))/((End)) 직접 참조 → startNode/endNode
  t = t.replace(/-->\s*\(\(\s*End\s*\)\)/ig,'--> endNode')
       .replace(/-->\s*\(\(\s*Start\s*\)\)/ig,'--> startNode');
  // 예약 id(start/end) → 안전 id로 치환(선언/인라인/간선)
  t = t.replace(/(^|\s)start\(\(\s*Start\s*\)\)/ig, (_,p1)=>`${p1}startNode((Start))`)
       .replace(/(^|\s)end\(\(\s*End\s*\)\)/ig,   (_,p1)=>`${p1}endNode((End))`)
       .replace(/(\s-->\s*)end\(\(\s*End\s*\)\)/ig,'$1endNode((End))')
       .replace(/(\s-->\s*)start\(\(\s*Start\s*\)\)/ig,'$1startNode((Start))')
       .replace(/(-->|-\.->|\.\.->)\s*end\b/ig,'$1 endNode')
       .replace(/\bend\b\s*(-->|-\.->|\.\.->)/ig,'endNode $1')
       .replace(/(-->|-\.->|\.\.->)\s*start\b/ig,'$1 startNode')
       .replace(/\bstart\b\s*(-->|-\.->|\.\.->)/ig,'startNode $1');
  // 익명 노드에 id 부여(간단 버전)
  const idMap=new Map(); let seq=1;
  const slug=s=>(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')||`n${seq++}`;
  const ensure=(k,b)=>{ if(idMap.has(k)) return idMap.get(k); let v=b,i=2; while(idMap.has(v)) v=`${b}_${i++}`; idMap.set(k,v); idMap.set(v,true); return v; };
  // [라벨] → id[라벨]
  t = t.replace(/(^|\s)(\[\s*([^\[\]\n]+?)\s*\])(:::[\w-]+)?/g,
    (_,lead,whole,label,klass='')=>{
      if (/[A-Za-z0-9_]\[$/.test(lead)) return `${lead}${whole}${klass||''}`;
      const id = ensure(`[]:${label}`, slug(label));
      return `${lead}${id}[${label}]${klass||''}`;
    });
  // ((라벨)) → start/end/id((...))
  t = t.replace(/(^|\s)(\(\(\s*([^\(\)\n]+?)\s*\)\))(:::[\w-]+)?/g,
    (_,lead,whole,label,klass='')=>{
      const base = /end/i.test(label)?'end':/start/i.test(label)?'start':slug(label);
      const id = ensure(`((${label}))`, base);
      return `${lead}${id}((${label}))${klass||''}`;
    });
  // {라벨} → id{라벨}
  t = t.replace(/(^|\s)({\s*([^{}\n]+?)\s*})(:::[\w-]+)?/g,
    (_,lead,whole,label,klass='')=>{
      if (/[A-Za-z0-9_]\{$/.test(lead)) return `${lead}${whole}${klass||''}`;
      const id = ensure(`{}:${label}`, `q_${slug(label)}`);
      return `${lead}${id}{${label}}${klass||''}`;
    });
  // start/end 선언 보강 + 기본 classDef 주입
  const hasHeader=/^\s*flowchart\s+\w+\b/m.test(t);
  const declStart=/^\s*startNode\(\(/m.test(t), declEnd=/^\s*endNode\(\(/m.test(t);
  const refStart=/\b(?:-->|-\.->|\.\.->)\s*startNode\b|\bstartNode\b\s*(?:-->|-\.->|\.\.->)/i.test(t);
  const refEnd=/\b(?:-->|-\.->|\.\.->)\s*endNode\b|\bendNode\b\s*(?:-->|-\.->|\.\.->)/i.test(t);
  if (hasHeader && (refStart && !declStart || refEnd && !declEnd)) {
    t = t.replace(/^\s*flowchart\s+\w+\s*\n?/, m=>{
      let inject=m;
      if(refStart && !declStart) inject+='startNode((Start)):::startend\n';
      if(refEnd && !declEnd) inject+='endNode((End)):::startend\n';
      return inject;
    });
  }
  const uses=/:::(startend|step|decision|bar)\b/.test(t);
  const hasDef=/^\s*classDef\s+/m.test(t);
  if (uses && !hasDef){
    t+=`

classDef startend fill:#fff,stroke:#888,stroke-width:1px,color:#111;
classDef bar stroke:#333,stroke-width:4px;
classDef step fill:#eef,stroke:#99f,color:#001;
classDef decision fill:#ffd,stroke:#cc4,color:#221;`;
  }
  return t;
}

const looksLikeActivity = (code) =>
  /:::(startend|step|decision|bar)\b/.test(code) ||
  /\(\(\s*Start|\(\(\s*End|\{[^}\n]+\?\}/i.test(code);

const livePreviewHandler = debounce((ed)=>{
  if (!(ed && ed.tagName === 'TEXTAREA')) return;
  const code = String(ed.value || '');
  // Mermaid 헤더가 없으면 스킵
  if (!/^\s*(flowchart|classDiagram|sequenceDiagram|stateDiagram|erDiagram)\b/i.test(code)) return;
  const container = guessPreviewForEditor(ed);
  if (!container) return;
  renderMermaid(container, code);
}, 150);

// 캡처 단계에서 textarea 입력을 감지해도 다른 로직과 충돌 없음
document.addEventListener('input', (e)=>{
  const t = e.target;
  if (t && t.tagName === 'TEXTAREA') livePreviewHandler(t);
}, true);

 // 붙여넣기/드롭도 즉시 반영
document.addEventListener('paste', (e)=>{
  const t = e.target;
  if (t && t.tagName === 'TEXTAREA') livePreviewHandler(t);
}, true);
document.addEventListener('drop', (e)=>{
  const t = e.target;
  if (t && t.tagName === 'TEXTAREA') livePreviewHandler(t);
}, true);

function stripCodeFences(s){
  if(!s) return '';
  const t = String(s).trim();
  const m = t.match(/^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```$/);
  return (m ? m[1] : t).trim();
}

function debounce(fn, ms = 220){
  let tid;
  return (...args)=>{
    clearTimeout(tid);
    tid = setTimeout(()=>fn(...args), ms);
  };
}

function setActiveTab(targetId){
  qsa('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.target===targetId));
  qsa('.panel').forEach(p=>p.classList.toggle('active', p.id===targetId));
}

  // 진행 중 요청 중복 제거용 캐시
const __inflight = new Map();
async function api(path, opts = {}) {
  const key = `${opts.method||'GET'}::${path}::${opts.body||''}`;
  if (__inflight.has(key)) return __inflight.get(key);

  const p = (async () => {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  })();

  __inflight.set(key, p);
  try {
    return await p;
  } finally {
    __inflight.delete(key);
  }
}

function toggleBlocks(radiosName, dbBlock, manualBlock){
  const mode = qs(`input[name="${radiosName}"]:checked`)?.value || 'db';
  dbBlock.classList.toggle('hidden', mode!=='db');
  manualBlock.classList.toggle('hidden', mode!=='manual');
}

// 목록 채우기
function fillSelect(sel, items, mkLabel, mkValue){
  sel.innerHTML = '';
  for(const it of items){
    const opt = document.createElement('option');
    opt.textContent = mkLabel(it);
    opt.value = mkValue(it);
    sel.appendChild(opt);
  }
}

// Mermaid 렌더
function renderMermaid(container, code){
  if(!code || !container) return;
  let clean = stripMermaidFences(code);
  // flowchart + activity 유사 패턴이면 클라이언트 보정
  if (/^\s*flowchart\b/i.test(clean) && looksLikeActivity(clean)) {
    clean = sanitizeActivityFlowchartClient(clean);
  }
  // Validate header (generic). Only toast for main preview containers (id *-view).
  try { validateMermaidHeader(clean, { containerId: container.id }); } catch(e) { /* noop */ }
  container.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className='mermaid';
  pre.textContent = clean;
  container.appendChild(pre);
  mermaid.run({ querySelector: `#${container.id} .mermaid` });
}

// ---------- Toast & Header Validation Utilities ----------
function injectToastStyles(){
  if (document.getElementById('toast-styles')) return;
  const css = `
  #toast-container{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none}
  .toast{pointer-events:auto;background:#0e1534;border:1px solid #3a52aa;color:#e6edff;padding:10px 12px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45);max-width:86vw}
  .toast .title{font-weight:600;margin-bottom:4px}
  .toast.warn{border-color:#cc8a2b}
  .toast.error{border-color:#cc4b4b}
  `;
  const s = document.createElement('style');
  s.id = 'toast-styles'; s.textContent = css; document.head.appendChild(s);
}
function ensureToastContainer(){
  let c = document.getElementById('toast-container');
  if(!c){ c = document.createElement('div'); c.id='toast-container'; document.body.appendChild(c); }
  return c;
}
const __toastDedup = { key:'', ts:0 };
function showToast(message, type='warn', title){
  injectToastStyles();
  const now = Date.now();
  const key = `${type}|${title||''}|${message}`;
  if (__toastDedup.key === key && now - __toastDedup.ts < 1500) return; // 디듀프
  __toastDedup.key = key; __toastDedup.ts = now;

  const c = ensureToastContainer();
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.innerHTML = title ? `<div class="title">${title}</div><div>${message}</div>` : message;
  c.appendChild(d);
  setTimeout(()=>{ d.style.opacity='0'; d.style.transition='opacity .3s'; setTimeout(()=>d.remove(), 300); }, 4200);
}

function firstLineOfMermaid(code){
  const clean = stripMermaidFences(String(code||''));
  const lines = clean.split(/\r?\n/);
  for (const raw of lines){
    const line = (raw || '').trim();
    if (!line) continue;                    // 빈 줄 스킵
    if (line.startsWith('%%')) continue;    // Mermaid 주석 스킵
    if (line.startsWith('```')) continue;   // 잘못 붙은 펜스 스킵(방어)
    if (line.startsWith('<!--')) continue;  // HTML 코멘트 방어
    return line;                            // 첫 의미있는 라인 반환
  }
  return '';
}
function isValidMermaidHeaderLine(line){
  return /^(flowchart\s+(TD|LR|TB|BT|RL)|sequenceDiagram|classDiagram)\b/.test(line);
}
function expectedHeaderRegexForKind(kind){
  const k = String(kind||'').toLowerCase();
  if (k==='usecase')   return /^flowchart\s+LR\b/;
  if (k==='activity')  return /^flowchart\s+TD\b/;
  if (k==='sequence')  return /^sequenceDiagram\b/;
  if (k==='class')     return /^classDiagram\b/;
  return /^(flowchart\s+(TD|LR|TB|BT|RL)|sequenceDiagram|classDiagram)\b/;
}
/**
 * Validate Mermaid header and optionally enforce by kind.
 * @param {string} code - Mermaid source
 * @param {{expectedKind?:string, context?:string, containerId?:string}} [opts]
 * @returns {boolean} - whether header looks valid
 */
function validateMermaidHeader(code, opts={}){
  const line = firstLineOfMermaid(code);
  const { expectedKind, context, containerId } = opts || {};
  const valid = isValidMermaidHeaderLine(line);

  // Avoid spamming mini previews: only toast for main preview containers
  const isMainPreview = containerId && /-(view)$/.test(containerId);

  if (!valid) {
    if (isMainPreview) {
      showToast(`Mermaid 코드 첫 줄에 다이어그램 헤더가 필요해요. 예) flowchart TD | flowchart LR | sequenceDiagram | classDiagram. usecase/activity는 flowchart를 사용하세요.`, 'warn', '헤더 누락');
    }
    return false;
  }

  if (expectedKind) {
    const exp = expectedHeaderRegexForKind(expectedKind);
    if (!exp.test(line)) {
      if (isMainPreview) {
        const expStr = expectedKind==='usecase' ? "flowchart LR"
                    : expectedKind==='activity' ? "flowchart TD"
                    : expectedKind==='sequence' ? "sequenceDiagram"
                    : expectedKind==='class' ? "classDiagram" : "유효한 헤더";
        showToast(`선택한 다이어그램 종류 '${expectedKind}'와 헤더가 일치하지 않습니다. 첫 줄을 '${expStr}' 로 시작하세요. (현재: '${line || '빈 줄'}')`, 'warn', '헤더 불일치');
      }
      return false;
    }
  }
  return true;
}

// --------- 클릭 피드백 & 로딩 오버레이 ---------
function flashClick(btn){
  if(!btn) return;
  btn.classList.add('clicked');
  setTimeout(()=>btn.classList.remove('clicked'), 180);
}

let __loadingDepth = 0;
function showLoading(msg='처리 중…'){
  const overlay = qs('#loading'); if(!overlay) return;
  __loadingDepth++;
  const t = qs('#loading .loading-text'); if (t) t.textContent = msg;
  overlay.classList.remove('hidden');
}
function hideLoading(){
  const overlay = qs('#loading'); if(!overlay) return;
  __loadingDepth = Math.max(0, __loadingDepth - 1);
  if (__loadingDepth === 0) overlay.classList.add('hidden');
}

async function withLoading(btn, label, fn){
  // 이미 실행 중이면 바로 무시
  if (btn && btn.dataset.lock === '1') return;

  const orig = btn?.textContent;
  if (btn) {
    btn.dataset.lock = '1';              // 동시 클릭/중복 리스너 방지
    btn.disabled = true;
    btn.classList.add('busy');
    if (label) btn.textContent = label;
  }
  showLoading(label || '처리 중…');
  try{
    return await fn();
  } finally {
    hideLoading();
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('busy');
      if (orig) btn.textContent = orig;
      delete btn.dataset.lock;           // 해제
    }
  }
}

// --------------- 목록 로딩 ---------------
async function refreshReqList(){
  const typeSel = qs('#req-type');
  const type = val(typeSel);
  const url = type ? `/api/list/req?type=${encodeURIComponent(type)}` : '/api/list/req';
  const j = await api(url);
  fillSelect(qs('#req-select'), j.items, (r)=>`[${typeKR(r.reqType)}] ${r.id} - ${r.title}`, r=>r.id);
  if (j.items.length) {
    qs('#req-select').value = j.items[0].id;
    await loadReqDetailsToManual(j.items[0].id);
  } else {
    qs('#req-id').value = '';
    qs('#req-title').value = '';
    qs('#req-desc').value = '';
  }
}

// (코드→Mermaid) SW TEST 연결
async function refreshStJoin(){
  const type = val(qs('#st-join-type'));
  const url = type ? `/api/list/req?type=${encodeURIComponent(type)}` : '/api/list/req';
  const j = await api(url);
  const selectEl = qs('#st-join-select');
  fillSelect(selectEl, j.items, (r)=>`[${typeKR(r.reqType)}] ${r.id} - ${r.title}`, r=>r.id);

  if (!j.items || j.items.length === 0) {
    selectEl.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = "";
    opt.textContent = "(목록 없음)";
    opt.disabled = true;
    selectEl.appendChild(opt);
  }
}

// (Mermaid→코드) SW TEST 연결 - 타입 연동 전용
async function refreshMmSwJoin(){
  const type = val(qs('#mm-swtest-type'));
  const url = type ? `/api/list/req?type=${encodeURIComponent(type)}` : '/api/list/req';
  const j = await api(url);
  fillSelect(qs('#mm-swtest-select'), j.items, (r)=>`[${typeKR(r.reqType)}] ${r.id} - ${r.title}`, r=>r.id);
}

async function refreshCodeList(){
  const j = await api('/api/list/code');
  fillSelect(qs('#code-select'), j.items, c=>`${c.codeId} (${c.language})`, c=>c.codeId);
  if (j.items.length) {
    qs('#code-select').value = j.items[0].codeId;
    await loadCodeDetailsToManual(j.items[0].codeId);
  } else {
    qs('#code-id').value = '';
    qs('#code-text').value = '';
  }
}

async function refreshDiagramList(targetSelect, kind){
  const url = kind ? `/api/list/diagram?kind=${encodeURIComponent(kind)}` : '/api/list/diagram';
  const j = await api(url);
  fillSelect(targetSelect, j.items, d=>`${d.diagramId} [${d.kind}]`, d=>d.diagramId);

  if (targetSelect.id === 'mm-diagram-select' && j.items?.length){
    targetSelect.value = j.items[0].diagramId;
    const mer = await loadDiagramToCache(j.items[0].diagramId);
    const ta = qs('#mm-text');
    if (ta) {
      ta.value = mer;
      enforceMmTextScrollbox();
    }
  }
}

async function refreshSwTestList(targetSelect, type='SW_TEST'){
  const j = await api(`/api/list/req?type=${encodeURIComponent(type)}`);
  fillSelect(targetSelect, j.items, r=>`[${typeKR(r.reqType)}] ${r.id} - ${r.title}`, r=>r.id);
}

// (Mermaid→코드) 언어 기준 코드 ID 목록
async function refreshMmCodeIdList(){
  const lang = val(qs('#mm-lang'));
  const j = await api('/api/list/code');
  const list = (j.items||[]).filter(c=>String(c.language||'')===lang);
  fillSelect(qs('#mm-code-select'), list, c=>`${c.codeId}`, c=>c.codeId);
}

// --------------- 세부 로더 ---------------
async function loadReqDetailsToManual(id){
  if(!id) return;
  const r = await api(`/api/get/req/${encodeURIComponent(id)}`);
  qs('#req-id').value = r.id;
  qs('#req-type-man').value = r.reqType || 'SYS';
  qs('#req-title').value = r.title || '';
  qs('#req-desc').value  = r.desc || '';
}

async function loadCodeDetailsToManual(codeId){
  if(!codeId) return;
  const c = await api(`/api/get/code/${encodeURIComponent(codeId)}`);
  qs('#code-id').value = c.codeId;
  qs('#code-lang').value = c.language;
  qs('#code-text').value = c.code;
}

// Mermaid→소스코드: 최근 로드 Mermaid 캐시
let mmLastLoadedMermaid = '';
let mmLastLoadedDiagramId = '';
async function loadDiagramToCache(diagramId){
  if(!diagramId) return '';
  const d = await api(`/api/get/diagram/${encodeURIComponent(diagramId)}`);
  mmLastLoadedDiagramId = diagramId;
  mmLastLoadedMermaid = String(d.mermaid||'');
  return mmLastLoadedMermaid;
}

// --------------- DB 뷰(표) ---------------
function clearTbody(tid){ const tb = qs(`#${tid} tbody`); if(tb) tb.innerHTML=''; return tb; }

/** 요구: 펼치기/접기 버튼의 위치가 동일하게 유지되도록 토글을 위에 배치 */
function mkCollapsibleHTML(text){
  const esc = String(text||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `
    <div class="collap-wrap">
      <span class="toggle-more" aria-label="toggle">펼치기</span>
      <div class="collapsible">
        <div class="mono">${esc}</div>
      </div>
    </div>
  `;
}


async function loadDBView(){
  const [sys, sw, swDes, swTest, diags, codes] = await Promise.all([
    api('/api/list/req?type=SYS'),
    api('/api/list/req?type=SW'),
    api('/api/list/req?type=SW_DES'),
    api('/api/list/req?type=SW_TEST'),
    api('/api/list/diagram'),
    api('/api/list/code'),
  ]);

  // 요구사항 표
  const reqs = [
    ...sys.items.map(r=>({ ...r, reqType: 'SYS'})),
    ...sw.items.map(r=>({ ...r, reqType: 'SW'})),
    ...swDes.items.map(r=>({ ...r, reqType: 'SW_DES'})),
    ...swTest.items.map(r=>({ ...r, reqType: 'SW_TEST'})),
  ];
  const tbReq = clearTbody('tbl-req');
  for(const r of reqs){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.id}</td><td>${typeKR(r.reqType)}</td><td>${r.title||''}</td><td>${mkCollapsibleHTML(r.desc||'')}</td>`;
    tbReq.appendChild(tr);
  }

  // 다이어그램 표 (Mermaid 전체)
  const tbDia = clearTbody('tbl-diagram');
  for(const d of (diags.items||[])){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${d.diagramId}</td><td>${d.kind}</td><td>${mkCollapsibleHTML(d.mermaid||'')}</td>`;
    tbDia.appendChild(tr);
  }

  // 소스코드 표 (전체)
  const tbCode = clearTbody('tbl-code');
  for(const c of (codes.items||[])){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${c.codeId}</td><td>${c.language}</td><td>${mkCollapsibleHTML(c.code||'')}</td>`;
    tbCode.appendChild(tr);
  }

  // 요구: 컬럼 폭 재조정
  applyColgroup('tbl-req', ['14%', '12%', '24%', '50%']);   // ID / 종류 / 제목 / 내용
  applyColgroup('tbl-diagram', ['20%', '12%', '68%']);      // 다이어그램ID / 종류 / Mermaid 코드
  applyColgroup('tbl-code', ['22%', '12%', '66%']);         // 코드ID / 언어 / 소스코드

}

function applyColgroup(tableId, widths){
  const table = qs(`#${tableId}`);
  if(!table) return;
  let cg = table.querySelector('colgroup');
  if (cg) cg.remove();
  cg = document.createElement('colgroup');
  widths.forEach(w=>{
    const col = document.createElement('col');
    col.style.width = w;
    cg.appendChild(col);
  });
  table.insertBefore(cg, table.firstChild);
}

// 접기/펼치기 토글 + 다이어그램 미리보기 썸네일 (전역 1회만)
if (!window.__UML_APP_FLAGS__.toggleBound) {
  window.__UML_APP_FLAGS__.toggleBound = true;
  document.addEventListener('click', (e)=>{
  const t = e.target;
  if(t && t.classList.contains('toggle-more')){
    const wrap = t.closest('.collap-wrap');
    const cell = wrap?.querySelector('.collapsible');
    if(cell){
      const isCollapsed = !cell.style.maxHeight || cell.style.maxHeight === '0px';

      if (isCollapsed) {
        cell.style.maxHeight = cell.scrollHeight + 'px';
        t.textContent = '접기';
      } else {
        cell.style.maxHeight = '0px';
        t.textContent = '펼치기';
      }

      // 다이어그램 표에서만 미리보기 썸네일
      const row = t.closest('tr');
      const inDiagramTable = !!t.closest('#tbl-diagram');
      if (inDiagramTable) {
        let miniBox = row.querySelector('.diagram-mini');
        if (isCollapsed) {
          if (!miniBox) {
            miniBox = document.createElement('div');
            miniBox.className = 'diagram-mini';
            const pvId = `mini-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
            miniBox.innerHTML = `<div id="${pvId}"></div>`;
            t.closest('td')?.appendChild(miniBox);

            const codeText = cell.querySelector('.mono')?.textContent || '';
            const target = miniBox.firstElementChild;
            target.id = pvId;
            renderMermaid(target, codeText);
          }
        } else if (miniBox) {
          miniBox.remove();
        }
      }
    }
  }
  });
}


// --------------- 폼 정렬/간격 보정 유틸 ---------------
function tightenDiagramStacks(){
  // 요구사항→Mermaid 다이어그램 ID
  const reqStack = qs('#req-diagram-db')?.closest('.control-stack');
  reqStack && reqStack.classList.add('tight');

  // 소스코드→Mermaid 다이어그램 ID
  const codeStack = qs('#code-diagram-db')?.closest('.control-stack');
  codeStack && codeStack.classList.add('tight');

  // Mermaid→소스코드 다이어그램 ID
  const mmDiagStack = qs('#mm-diagram-db')?.closest('.control-stack');
  mmDiagStack && mmDiagStack.classList.add('tight');

  // Mermaid→소스코드 소스코드 ID
  const mmCodeIdStack = qs('#mm-codeid-db')?.closest('.control-stack');
  mmCodeIdStack && mmCodeIdStack.classList.add('tight');
}

function ensureManualBlockTopGaps(){
  // 요구사항 입력 방식: 직접입력 시 토글 ↔ 첫 줄 간격 확보
  const reqDb = qs('#req-db-block'), reqMan = qs('#req-manual-block');
  const reqMode = qs('input[name="reqMode"]:checked')?.value;
  if (reqMode === 'manual') reqMan.style.marginTop = 'var(--rowGap)';
  else reqMan.style.marginTop = '';

  // 소스코드 입력 방식: 직접입력 시 토글 ↔ 첫 줄 간격 확보
  const cdb = qs('#code-db-block'), cman = qs('#code-manual-block');
  const codeMode = qs('input[name="codeMode"]:checked')?.value;
  if (codeMode === 'manual') cman.style.marginTop = 'var(--rowGap)';
  else cman.style.marginTop = '';
}

function enforceMmTextScrollbox(){
  const ta = qs('#mm-text');
  if (!ta) return;
  ta.style.maxHeight = '40vh';
  ta.style.minHeight = '24vh';
  ta.style.overflow = 'auto';
  ta.style.resize = 'vertical';
}

// --------------- 초기 탭/토글 ---------------
function initTabs(){
  if (window.__UML_APP_FLAGS__.tabsBound) return;
  window.__UML_APP_FLAGS__.tabsBound = true;
  qsa('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      flashClick(btn);
      setActiveTab(btn.dataset.target);
      if (btn.dataset.target === 'tab-db') loadDBView().catch(()=>{});
    });
  });
  setActiveTab('tab-req2mm');
}

function initToggles(){
  // 요구사항 입력방식
  const reqDb = qs('#req-db-block'), reqMan = qs('#req-manual-block');
  if (window.__UML_APP_FLAGS__.togglesBound) return;
  window.__UML_APP_FLAGS__.togglesBound = true;
  qsa('input[name="reqMode"]').forEach(r=>r.addEventListener('change', ()=>{
    toggleBlocks('reqMode', reqDb, reqMan);
    ensureManualBlockTopGaps();
  }));
  toggleBlocks('reqMode', reqDb, reqMan);

  // 요구사항→Mermaid 다이어그램 ID
  const rdb = qs('#req-diagram-db'), rman = qs('#req-diagram-man');
  qsa('input[name="reqDiagramMode"]').forEach(r=>{
    r.addEventListener('change', async ()=>{
      toggleBlocks('reqDiagramMode', rdb, rman);
      if (qs('input[name="reqDiagramMode"]:checked').value==='db') {
        await refreshDiagramList(qs('#req-diagram-select'), val(qs('#req-diagram-kind')));
      }
    });
  });
  toggleBlocks('reqDiagramMode', rdb, rman);

  // 코드 입력방식
  const cdb = qs('#code-db-block'), cman = qs('#code-manual-block');
  qsa('input[name="codeMode"]').forEach(r=>r.addEventListener('change', ()=>{
    toggleBlocks('codeMode', cdb, cman);
    ensureManualBlockTopGaps();
  }));
  toggleBlocks('codeMode', cdb, cman);

  // 코드→Mermaid 다이어그램 ID
  const cddb = qs('#code-diagram-db'), cdman = qs('#code-diagram-man');
  qsa('input[name="codeDiagramMode"]').forEach(r=>{
    r.addEventListener('change', async ()=>{
      toggleBlocks('codeDiagramMode', cddb, cdman);
      if (qs('input[name="codeDiagramMode"]:checked').value==='db') {
        await refreshDiagramList(qs('#code-diagram-select'), val(qs('#code-diagram-kind')));
      }
    });
  });
  toggleBlocks('codeDiagramMode', cddb, cdman);

  // Mermaid→코드: 다이어그램 입력방식 + Mermaid 입력블록 토글
  const mdb = qs('#mm-diagram-db'), mman = qs('#mm-diagram-man'), mtext = qs('#mm-text-block');
  async function toggleMmBlocks(){
    const mode = qs('input[name="mmDiagramMode"]:checked')?.value || 'db';
    mdb.classList.toggle('hidden', mode!=='db');
    mman.classList.toggle('hidden', mode!=='manual');
    mtext.classList.toggle('hidden', mode!=='manual');
    if(mode==='manual'){
      const ta = qs('#mm-text');
      if(ta) {
        ta.value = mmLastLoadedMermaid || ta.value || '';
        enforceMmTextScrollbox();
      }
      const idInput = qs('#mm-diagram-id');
      if (idInput && mmLastLoadedDiagramId) idInput.value = mmLastLoadedDiagramId;
    }
  }
  qsa('input[name="mmDiagramMode"]').forEach(r=>r.addEventListener('change', toggleMmBlocks));
  toggleMmBlocks();

  // Mermaid→코드: 소스코드 ID 입력방식 (DB/수동) 토글 + DB 모드 시 즉시 목록 갱신
  const mcdb = qs('#mm-codeid-db'), mcman = qs('#mm-codeid-man');
  async function toggleMmCodeIdBlocks(){
    const mode = qs('input[name="mmCodeIdMode"]:checked')?.value || 'db';
    mcdb.classList.toggle('hidden', mode !== 'db');
    mcman.classList.toggle('hidden', mode !== 'manual');
    if (mode === 'db') {
      await refreshMmCodeIdList();
      const sel = qs('#mm-code-select');
      if (sel && !sel.value && sel.options.length) sel.value = sel.options[0].value;
    }
  }
  qsa('input[name="mmCodeIdMode"]').forEach(r => r.addEventListener('change', ()=>{ toggleMmCodeIdBlocks(); }));
  toggleMmCodeIdBlocks();
}

// --------------- 이벤트 연결 ---------------
function bindEvents(){
  // HMR로 main.js가 다시 평가되더라도 바인딩은 1회만
  if (window.__UML_APP_FLAGS__.bound) return;
  window.__UML_APP_FLAGS__.bound = true;

  document.addEventListener('click', (e)=>{
    const b = e.target.closest('.btn');
    if (b) flashClick(b);
  });

  const refreshBtn = qs('#btn-refresh-all');
  if (refreshBtn) refreshBtn.addEventListener('click', ()=>withLoading(refreshBtn, '불러오는 중…', async ()=>{
    await refreshAllLists();
    if (qs('.tab-btn.active')?.dataset.target === 'tab-db') await loadDBView();
  }));

  // 요구사항: 유형 변경/선택 변경
  qs('#req-type').addEventListener('change', refreshReqList);
  qs('#req-select').addEventListener('change', async ()=>{
    const id = val(qs('#req-select'));
    if (id) await loadReqDetailsToManual(id);
  });

  // 요구사항 저장
  qs('#btn-save-req').addEventListener('click', (e)=>{
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('busy')) return; // 재진입 방지
    withLoading(btn, '저장 중…', async ()=>{
      const id = val(qs('#req-id'));
      const reqType = val(qs('#req-type-man'));
      const title = val(qs('#req-title'));
      const desc  = val(qs('#req-desc'));
      if(!id || !reqType || !title || !desc) throw new Error('요구사항 ID/종류/제목/내용을 모두 입력하세요.');
      const j = await api('/api/save/req', { method:'POST', body: JSON.stringify({ id, reqType, title, desc })});
      alert(`요구사항 저장 완료: ${j.item.id}`);
      const reqMode = qs('input[name="reqMode"]:checked')?.value || 'db';
      // 목록 갱신 (드롭다운 반영)
      await refreshReqList();
      // 저장한 항목으로 셀렉트 고정
      if (qs('#req-select')) qs('#req-select').value = j.item.id;
      // 직접입력 모드에서는 수동 입력값 유지
      if (reqMode === 'manual') {
        qs('#req-id').value = j.item.id;
        qs('#req-type-man').value = j.item.reqType || '';
        qs('#req-title').value = j.item.title || '';
        qs('#req-desc').value = j.item.desc || '';
      }
      // SW TEST 요구사항이면 다른 탭의 연결 드롭다운도 갱신
      if ((j.item.reqType||'') === 'SW_TEST') {
        try { await refreshSwTestList(qs('#st-join-select'), 'SW_TEST'); } catch(e){}
        try { await refreshSwTestList(qs('#mm-swtest-select'), 'SW_TEST'); } catch(e){}
      }
    });
  });

  // 요구사항→Mermaid 실행
  qs('#btn-req2mm').addEventListener('click', (e)=>{
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('busy')) return; // 재진입 방지
    qs('#req2mm-error').textContent = '';
    withLoading(btn, 'Mermaid 생성 중…', async ()=>{
      let reqId, reqType, title, desc;
      const mode = qs('input[name="reqMode"]:checked').value;
      if(mode==='db'){
        reqId = val(qs('#req-select'));
        if(!reqId) throw new Error('요구사항을 선택하세요.');
        const r = await api(`/api/get/req/${encodeURIComponent(reqId)}`);
        reqType = r.reqType; title = r.title; desc = r.desc;
      } else {
        reqId   = val(qs('#req-id'));
        reqType = val(qs('#req-type-man'));
        title   = val(qs('#req-title'));
        desc    = val(qs('#req-desc'));
        if(!reqId || !reqType || !title || !desc) throw new Error('요구사항 ID/종류/제목/내용을 모두 입력하세요.');
      }
      const diagramKind = val(qs('#req-diagram-kind'));
      let diagramId = '';
      const dmode = qs('input[name="reqDiagramMode"]:checked').value;
      if(dmode==='db'){
        diagramId = val(qs('#req-diagram-select'));
        if(!diagramId) throw new Error('다이어그램을 선택하거나 직접 입력으로 전환하세요.');
      }else{
        diagramId = val(qs('#req-diagram-id'));
        if(!diagramId) throw new Error('다이어그램 ID를 입력하세요.');
      }

      const res = await api('/api/convert/req2mm', {
        method:'POST',
        body: JSON.stringify({ reqType, reqId, title, desc, diagramKind, diagramId })
      });
      let m = stripMermaidFences(res.mermaid || '');
      m = `%% diagram_id: ${diagramId}
%% linked_req_id: ${reqId}

${m}`; // ← 헤더/본문 사이 공백 1줄

      validateMermaidHeader(m, { expectedKind: diagramKind, containerId: 'req2mm-view', context: 'req2mm' });
      qs('#req2mm-output').value = m;
      renderMermaid(qs('#req2mm-view'), m);
    }).catch(err=>{
      qs('#req2mm-error').textContent = String(err?.message||err);
    });
  });

  // 요구사항→Mermaid 저장
  qs('#btn-save-req-diagram').addEventListener('click', (e)=>{
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('busy')) return; // 재진입 방지
    withLoading(btn, '저장 중…', async ()=>{
      const mermaidCode = stripMermaidFences(val(qs('#req2mm-output')));
      const diagramKind = val(qs('#req-diagram-kind'));
      const dmode = qs('input[name="reqDiagramMode"]:checked').value;
      const diagramId = dmode==='db' ? val(qs('#req-diagram-select')) : val(qs('#req-diagram-id'));
      if(!mermaidCode) throw new Error('Mermaid 코드가 없습니다.');
      if(!diagramId || !diagramKind) throw new Error('다이어그램 종류/ID를 지정하세요.');

            // links 정보 구성: reqId
      const reqMode = qs('input[name="reqMode"]:checked')?.value || 'db';
      const reqId = (reqMode === 'db') ? val(qs('#req-select')) : val(qs('#req-id'));
      await api('/api/save/diagram', {
        method:'POST',
        body: JSON.stringify({ diagramId, kind: diagramKind, mermaid: mermaidCode, links: { reqId } })
      });
      alert(`다이어그램 저장 완료: ${diagramId}`);
      await refreshDiagramList(qs('#req-diagram-select'), diagramKind);
    }).catch(err=>alert(String(err?.message||err)));
  });

  // 코드: 선택 시 자동 로드
  qs('#code-select').addEventListener('change', async ()=>{
    const codeId = val(qs('#code-select'));
    if (codeId) await loadCodeDetailsToManual(codeId);
  });

  // 코드 저장
  qs('#btn-save-code').addEventListener('click', (e)=>{
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('busy')) return; // 재진입 방지
    withLoading(btn, '저장 중…', async ()=>{
      const codeId = val(qs('#code-id'));
      const language = val(qs('#code-lang'));
      const code = val(qs('#code-text'));
      const swReqId = val(qs('#st-join-select')) || '';
      if(!codeId || !language || !code) throw new Error('소스코드 ID/언어/코드를 모두 입력하세요.');

      const payload = { codeId, language, code };
      if (swReqId) payload.swReqId = swReqId;

      const j = await api('/api/save/code', {
        method:'POST',
        body: JSON.stringify(payload)
      });
      alert(`소스코드 저장 완료: ${j.item.codeId}`);
      const codeMode = qs('input[name="codeMode"]:checked')?.value || 'db';
      await refreshCodeList();
      if (qs('#code-select')) qs('#code-select').value = j.item.codeId;
      if (codeMode === 'manual') {
        qs('#code-id').value = j.item.codeId;
        qs('#code-lang').value = j.item.language || '';
        qs('#code-text').value = j.item.code || '';
      }
    });
  });

  // Mermaid→코드 결과 저장 (코드)
  qs('#btn-save-mm-code').addEventListener('click', (e)=>{
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('busy')) return; // 재진입 방지
    withLoading(btn, '저장 중…', async ()=>{
      const codeIdMode = qs('input[name="mmCodeIdMode"]:checked').value;
      const chosenCodeId = (codeIdMode==='db') ? val(qs('#mm-code-select')) : val(qs('#mm-code-id'));
      const language = val(qs('#mm-lang'));
      const code = qs('#mm2code-output').textContent || '';
      const swReqId = val(qs('#mm-swtest-select')) || '';

      if(!language || !code) throw new Error('언어/코드를 모두 입력하세요.');
      const payload = { codeId: chosenCodeId || `CODE-${Date.now()}`, language, code };
      if (swReqId) payload.swReqId = swReqId;

      const j = await api('/api/save/code', { method:'POST', body: JSON.stringify(payload) });
      alert(`소스코드 저장 완료: ${j.item.codeId}`);
      await refreshCodeList();
      if (qs('input[name="mmCodeIdMode"]:checked').value==='db') await refreshMmCodeIdList();
    }).catch(err=>alert(String(err?.message||err)));
  });

  // 코드→Mermaid 실행
  qs('#btn-code2mm').addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('busy')) return;

    qs('#code2mm-error').textContent = '';
    await withLoading(btn, 'Mermaid 생성 중…', async () => {
      const mode = qs('input[name="codeMode"]:checked')?.value || 'db';
      let codeId, language, code;
      if (mode === 'db') {
        codeId = val(qs('#code-select'));
        if (!codeId) throw new Error('소스코드를 선택하세요.');
        const c = await api(`/api/get/code/${encodeURIComponent(codeId)}`);
        language = c.language; code = c.code;
      } else {
        codeId   = val(qs('#code-id'));
        language = val(qs('#code-lang'));
        code     = val(qs('#code-text'));
        if (!codeId || !language || !code) throw new Error('소스코드 ID/언어/코드를 모두 입력하세요.');
      }

      const diagramKind = val(qs('#code-diagram-kind'));
      const dmode = qs('input[name="codeDiagramMode"]:checked').value;
      const diagramId = (dmode === 'db') ? val(qs('#code-diagram-select')) : val(qs('#code-diagram-id'));
      if (!diagramKind) throw new Error('다이어그램 종류를 선택하세요.');
      if (!diagramId)  throw new Error('다이어그램 ID를 선택/입력하세요.');

      // 서버가 swReqId를 필수로 요구 중이므로 선택했는지 검사
      const swReqId = val(qs('#st-join-select'));
      if (!swReqId) throw new Error('SW TEST 요구사항을 선택하세요.');

      const res = await api('/api/convert/code2mm', {
        method: 'POST',
        body: JSON.stringify({ codeId, language, code, diagramKind, diagramId, swReqId })
      });

      // 모델이 본문 상단에 넣을 수 있는 중복 주석 제거(%% 또는 // 모두 대응)
      let m = stripMermaidFences(res.mermaid || '')
        .replace(/^\s*(%%|\/\/)\s*SW Test 요구사항 ID.*\n?/mi, '');

      const header2 = `%% diagram_id: ${diagramId}
%% linked_code_id: ${codeId}
%% linked_sw_req_id: ${swReqId}

`; // ← 마지막에 빈 줄 하나(헤더/본문 사이 공백 1줄)
      m = header2 + m;

      validateMermaidHeader(m, { expectedKind: diagramKind, containerId: 'code2mm-view', context: 'code2mm' });
      qs('#code2mm-output').value = m;
      renderMermaid(qs('#code2mm-view'), m);
    }).catch(err => {
      qs('#code2mm-error').textContent = String(err?.message || err);
    });
  });

  // 코드→Mermaid 결과 저장(다이어그램)
  qs('#btn-save-code-diagram').addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('busy')) return;

    await withLoading(btn, '저장 중…', async () => {
      const mermaidCode = stripMermaidFences(val(qs('#code2mm-output')));
      const diagramKind = val(qs('#code-diagram-kind'));
      const dmode = qs('input[name="codeDiagramMode"]:checked').value;
      const diagramId = (dmode === 'db') ? val(qs('#code-diagram-select')) : val(qs('#code-diagram-id'));

      if (!mermaidCode) throw new Error('Mermaid 코드가 없습니다.');
      if (!diagramId || !diagramKind) throw new Error('다이어그램 종류/ID를 지정하세요.');

            // links 정보 구성: codeId, swReqId
      const codeMode = qs('input[name="codeMode"]:checked')?.value || 'db';
      const codeId = (codeMode === 'db') ? val(qs('#code-select')) : val(qs('#code-id'));
      const swReqId = val(qs('#st-join-select')) || '';
      await api('/api/save/diagram', {
        method: 'POST',
        body: JSON.stringify({ diagramId, kind: diagramKind, mermaid: mermaidCode, links: { codeId, swReqId } })
      });
      alert(`다이어그램 저장 완료: ${diagramId}`);
      await refreshDiagramList(qs('#code-diagram-select'), diagramKind);
    }).catch(err => alert(String(err?.message || err)));
  });

  // Mermaid 코드 자체 저장(수정/직접입력용)
  qs('#btn-save-mm-diagram').addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('busy')) return;

    await withLoading(btn, '저장 중…', async () => {
      const diagramKind = val(qs('#mm-diagram-kind'));
      const mode = qs('input[name="mmDiagramMode"]:checked')?.value || 'db';
      const diagramId = (mode === 'db') ? val(qs('#mm-diagram-select')) : val(qs('#mm-diagram-id'));
      const mermaidCode = stripMermaidFences(val(qs('#mm-text')));

      if (!diagramId || !diagramKind) throw new Error('다이어그램 종류/ID를 지정하세요.');
      if (!mermaidCode) throw new Error('Mermaid 코드가 없습니다.');

      // links 정보 구성: codeId, swReqId
      const codeMode = qs('input[name="codeMode"]:checked')?.value || 'db';
      const codeId = (codeMode === 'db') ? val(qs('#code-select')) : val(qs('#code-id'));
      const swReqId = val(qs('#st-join-select')) || '';
      await api('/api/save/diagram', {
        method: 'POST',
        body: JSON.stringify({ diagramId, kind: diagramKind, mermaid: mermaidCode, links: { codeId, swReqId } })
      });

      alert(`Mermaid 코드 저장 완료: ${diagramId}`);
      const kindVal = val(qs('#mm-diagram-kind'));
      await refreshDiagramList(qs('#mm-diagram-select'), kindVal);
      // 저장한 다이어그램과 텍스트 유지
      if (qs('#mm-diagram-select')) qs('#mm-diagram-select').value = diagramId;
      const ta = qs('#mm-text'); if (ta) { ta.value = mermaidCode; enforceMmTextScrollbox(); }
    }).catch(err => alert(String(err?.message || err)));
  });

  // 다이어그램 kind 변경 시 목록 갱신
  qs('#req-diagram-kind').addEventListener('change', ()=>refreshDiagramList(qs('#req-diagram-select'), val(qs('#req-diagram-kind'))));
  qs('#code-diagram-kind').addEventListener('change', ()=>refreshDiagramList(qs('#code-diagram-select'), val(qs('#code-diagram-kind'))));

  // Mermaid→코드: kind 변경 시 목록 갱신
  const mmKindSel = qs('#mm-diagram-kind');
  if (mmKindSel) mmKindSel.addEventListener('change', ()=>{
    refreshDiagramList(qs('#mm-diagram-select'), val(qs('#mm-diagram-kind')));
  });

  // Mermaid→코드: 다이어그램 선택 시 DB에서 Mermaid 불러오기
  const mmSel = qs('#mm-diagram-select');
  if (mmSel) mmSel.addEventListener('change', async ()=>{
    const id = val(qs('#mm-diagram-select'));
    if(id){
      const mer = await loadDiagramToCache(id);
      const ta = qs('#mm-text');
      if (ta) { ta.value = mer; enforceMmTextScrollbox(); }
    }
  });

  // Mermaid→코드: 언어 변경 시 코드ID(DB) 목록 즉시 갱신
  const mmLangSel = qs('#mm-lang');
  if (mmLangSel) mmLangSel.addEventListener('change', async ()=>{
    await refreshMmCodeIdList();
    if (qs('input[name="mmCodeIdMode"]:checked')?.value === 'db') {
      const sel = qs('#mm-code-select');
      if (sel && !sel.value && sel.options.length) sel.value = sel.options[0].value;
    }
  });

  // Mermaid→코드 실행
  const mmRun = qs('#btn-mm2code');
  if (mmRun) mmRun.addEventListener('click', (e)=>{
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains('busy')) return; // 재진입 방지
    withLoading(btn, '코드 생성 중…', async ()=>{
      const diagramKind = val(qs('#mm-diagram-kind'));
      const dmode = qs('input[name="mmDiagramMode"]:checked')?.value || 'db';
      const diagramId = (dmode==='db') ? val(qs('#mm-diagram-select')) : val(qs('#mm-diagram-id'));
      const language = val(qs('#mm-lang'));
      const swReqId = val(qs('#mm-swtest-select'));

      if(!diagramKind) throw new Error('다이어그램 종류를 선택하세요.');
      if(dmode==='db' && !diagramId) throw new Error('다이어그램 ID를 선택하세요.');
      if(!language) throw new Error('언어를 선택하세요.');
      if(!swReqId) throw new Error('SW TEST 요구사항을 선택하세요.');

      const codeIdMode = qs('input[name="mmCodeIdMode"]:checked')?.value || 'db';
      const chosenCodeId = (codeIdMode==='db') ? val(qs('#mm-code-select')) : val(qs('#mm-code-id'));

      // manual이면 입력 텍스트 사용, db면 서버에서 DB 가져오도록 비움
      const mermaid = (dmode==='manual') ? stripMermaidFences(val(qs('#mm-text'))) : '';

      const res = await api('/api/convert/mm2code', {
        method:'POST',
        body: JSON.stringify({ diagramId, diagramKind, mermaid, language, codeId: chosenCodeId, swReqId })
      });

      const headerCodeId = res.codeId || chosenCodeId || '';
      const commentPrefix = (String(language||'').toLowerCase().includes('python')) ? '#' : '//';
      const codeHeader = [
        `${commentPrefix} language: ${language}`,
        `${commentPrefix} code_id: ${headerCodeId}`,
        `${commentPrefix} linked_sw_req_id: ${swReqId || ''}`,
        `${commentPrefix} linked_diagram_id: ${diagramId || ''}`
      ].join('\n');

      // 생성 코드 맨 위에 모델이 넣어주는 중복 주석 제거(있을 때만)
      const body = stripCodeFences(res.code || '')
        .replace(/^(\/\/|#)\s*SW Test 요구사항 ID.*\n?/mi, '');

      const finalCode = `${codeHeader}\n\n${body}`;
      qs('#mm2code-output').textContent = finalCode;

      if(res.codeId && codeIdMode==='manual') qs('#mm-code-id').value = res.codeId;
    }).catch(err=>{
      qs('#mm2code-error').textContent = String(err?.message||err);
    });
  });

}

// --------------- 전체 목록 일괄 로드 ---------------
async function refreshAllLists(){
  await Promise.all([
    refreshReqList(),
    refreshStJoin(),
    refreshCodeList(),
    refreshDiagramList(qs('#req-diagram-select'), val(qs('#req-diagram-kind'))),
    refreshDiagramList(qs('#code-diagram-select'), val(qs('#code-diagram-kind'))),
    refreshDiagramList(qs('#mm-diagram-select'),   val(qs('#mm-diagram-kind'))),
    refreshMmSwJoin(),
    refreshMmCodeIdList(),
  ]);
}

// --------------- 초기 로드 ---------------
document.addEventListener('DOMContentLoaded', async ()=>{
  injectDynamicStyles();
  injectToastStyles();
  initTabs();
  initToggles();
  bindEvents();
  await refreshAllLists();

  // UI 보정 (간격/정렬)
  tightenDiagramStacks();      // 특정 토글-입력 구간 간격 0으로
  ensureManualBlockTopGaps();  // 직접입력 선택 시 토글 아래 여백 확보
  enforceMmTextScrollbox();    // Mermaid 텍스트 박스 내부 스크롤 고정

  // Mermaid→코드: DB 로딩 및 실행 핸들러 (보강 바인딩)
  const mmKindSel = qs('#mm-diagram-kind');
  if (mmKindSel && !mmKindSel.__bound) {
    mmKindSel.__bound = true;
    mmKindSel.addEventListener('change', ()=>{
      refreshDiagramList(qs('#mm-diagram-select'), val(qs('#mm-diagram-kind')));
    });
  }

  const mmSel = qs('#mm-diagram-select');
  if (mmSel && !mmSel.__bound) {
    mmSel.__bound = true;
    mmSel.addEventListener('change', async ()=>{
      const id = val(qs('#mm-diagram-select'));
      if(id){
        const mer = await loadDiagramToCache(id);
        const ta = qs('#mm-text');
        if (ta) { ta.value = mer; enforceMmTextScrollbox(); }
      }
    });
  }

  // 언어 변경 시 코드 ID 즉시 갱신 (초기화 바인딩)
  const mmLangSel = qs('#mm-lang');
  if (mmLangSel && !mmLangSel.__bound) {
    mmLangSel.__bound = true;
    mmLangSel.addEventListener('change', async ()=>{
      await refreshMmCodeIdList();
      if (qs('input[name="mmCodeIdMode"]:checked')?.value === 'db') {
        const sel = qs('#mm-code-select');
        if (sel && !sel.value && sel.options.length) sel.value = sel.options[0].value;
      }
    });
  }

  const mmRun = qs('#btn-mm2code');
  if (mmRun && !mmRun.__bound) {
    mmRun.__bound = true;
    mmRun.addEventListener('click', (e)=>{
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const btn = e.currentTarget;
      if (btn.disabled || btn.classList.contains('busy')) return;
      withLoading(btn, '코드 생성 중…', async ()=>{
        const diagramKind = val(qs('#mm-diagram-kind'));
        const dmode = qs('input[name="mmDiagramMode"]:checked')?.value || 'db';
        const diagramId = (dmode==='db') ? val(qs('#mm-diagram-select')) : val(qs('#mm-diagram-id'));
        const language = val(qs('#mm-lang'));
        const swReqId = val(qs('#mm-swtest-select'));

        if(!diagramKind) throw new Error('다이어그램 종류를 선택하세요.');
        if(dmode==='db' && !diagramId) throw new Error('다이어그램 ID를 선택하세요.');
        if(!language) throw new Error('언어를 선택하세요.');
        if(!swReqId) throw new Error('SW TEST 요구사항을 선택하세요.');

        const codeIdMode = qs('input[name="mmCodeIdMode"]:checked')?.value || 'db';
        const chosenCodeId = (codeIdMode==='db') ? val(qs('#mm-code-select')) : val(qs('#mm-code-id'));

        // manual이면 입력 텍스트 사용, db면 서버에서 DB 가져오도록 비움
        const mermaid = (dmode==='manual') ? stripMermaidFences(val(qs('#mm-text'))) : '';

        const res = await api('/api/convert/mm2code', {
          method:'POST',
          body: JSON.stringify({ diagramId, diagramKind, mermaid, language, codeId: chosenCodeId, swReqId })
        });

        const headerCodeId = res.codeId || chosenCodeId || '';
        const commentPrefix = (String(language||'').toLowerCase().includes('python')) ? '#' : '//';
        const codeHeader = [
          `${commentPrefix} language: ${language}`,
          `${commentPrefix} code_id: ${headerCodeId}`,
          `${commentPrefix} linked_sw_req_id: ${swReqId || ''}`,
          `${commentPrefix} linked_diagram_id: ${diagramId || ''}`
        ].join('\n');

        // 생성 코드 맨 위에 모델이 넣어주는 중복 주석 제거(있을 때만)
        const body = stripCodeFences(res.code || '')
          .replace(/^(\/\/|#)\s*SW Test 요구사항 ID.*\n?/mi, '');

        const finalCode = `${codeHeader}\n\n${body}`;
        qs('#mm2code-output').textContent = finalCode;

        if(res.codeId && codeIdMode==='manual') qs('#mm-code-id').value = res.codeId;
      }).catch(err=>{
        qs('#mm2code-error').textContent = String(err?.message||err);
      });
    });
  }

  // ─────────────────────────────────────────────
  // 요구사항→Mermaid / 소스코드→Mermaid 결과창 실시간 미리보기
  const reqOut = qs('#req2mm-output');
  if (reqOut && !reqOut.__liveBound) {
    reqOut.__liveBound = true;
    const updateReqPreview = debounce(()=>{
      const view = qs('#req2mm-view');
      if (view) renderMermaid(view, reqOut.value || '');
    }, 220);
    reqOut.addEventListener('input', updateReqPreview);
    reqOut.addEventListener('paste', updateReqPreview);
  }

  const codeOut = qs('#code2mm-output');
  if (codeOut && !codeOut.__liveBound) {
    codeOut.__liveBound = true;
    const updateCodePreview = debounce(()=>{
      const view = qs('#code2mm-view');
      if (view) renderMermaid(view, codeOut.value || '');
    }, 220);
    codeOut.addEventListener('input', updateCodePreview);
    codeOut.addEventListener('paste', updateCodePreview);
  }
});