// server.mjs
/**
 * ============================================
 * App: UML ↔ Code Studio
 * File: server.mjs (주석 정리/가독성 개선판)
 * --------------------------------------------
 * 역할
 *  - 로컬 JSON(./outputs/db.json)을 간단한 DB로 사용
 *  - 요구사항/다이어그램/코드 CRUD + 변환 API 제공
 *  - OpenAI Responses API를 호출해 Mermaid↔Code 생성
 *
 * 환경변수
 *  - OPENAI_API_KEY : OpenAI API Key (필수)
 *  - MODEL_ID       : 모델 ID (기본값 'gpt-4o-mini')
 *  - API_PORT       : 서버 포트 (기본값 3000)
 *
 * 저장소
 *  - outputs/db.json (atomic rename으로 기록)
 *
 * 보안/운영 주의
 *  - CORS는 데모 편의상 전체 허용. 운영 환경에선 도메인 제한 권장.
 *  - express.json({ limit: '5mb' }) 용량은 필요 시 조정.
 *  - 프롬프트 인젝션/LLM 출력 신뢰성은 클라이언트/사후검증으로 보강 권장.
 * ============================================
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

/** Node ESM에서 __dirname 대체 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 데이터 파일 경로 */
const DATA_DIR = path.join(__dirname, 'outputs');
const DB_PATH = path.join(DATA_DIR, 'db.json');

/** Express 앱 설정 */
const app = express();
app.use(cors()); // TODO: 운영환경에선 origin 화이트리스트 설정 권장
app.use(express.json({ limit: '5mb' })); // 요청 본문 최대 크기 제한

// -------------------- DB 유틸 --------------------
/**
 * @typedef {'SYS'|'SW'|'SW_DES'|'SW_TEST'} ReqType
 * @typedef {{ id: string, reqType: ReqType, title?: string, desc?: string }} Requirement
 * @typedef {{ codeId: string, language: string, code: string, swReqId?: string }} CodeItem
 * @typedef {{ diagramId: string, kind: 'usecase'|'sequence'|'class'|'activity', mermaid: string, links?: Record<string, any> }} Diagram
 * @typedef {{ requirements: Record<string, Requirement>, codes: Record<string, CodeItem>, diagrams: Record<string, Diagram> }} DB
 */

/** outputs 디렉토리 생성 보장 */
async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/** DB 로딩 (없으면 빈 구조 반환) */
async function loadDb() {
  await ensureDir();
  try {
    const buf = await fs.readFile(DB_PATH, 'utf8');
    const j = JSON.parse(buf);
    return {
      requirements: j.requirements || {},
      codes:        j.codes || {},
      diagrams:     j.diagrams || {},
    };
  } catch {
    return { requirements: {}, codes: {}, diagrams: {} };
  }
}

/** DB 저장 (임시파일→rename으로 반쯤 원자적 저장) */
async function saveDb(db) {
  await ensureDir();
  const tmp = DB_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tmp, DB_PATH);
}

// -------------------- OpenAI --------------------
/** OpenAI Responses API 클라이언트 */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/** 사용할 모델 ID (기본값 gpt-4o-mini) */
const MODEL = process.env.MODEL_ID || 'gpt-4o-mini';

/** 필수값 공통 검사 */
function assertNonEmpty(name, v) {
  if (!v || String(v).trim() === '') throw new Error(`${name}은(는) 필수입니다.`);
}

/** 
 * Mermaid 코드블록 축출:
 * ```mermaid ...``` 또는 ``` ...``` 감싸짐 제거
 */
function stripMermaidFences(s) {
  if (!s) return '';
  let t = String(s).trim();
  t = t.replace(/^```(?:mermaid)?\s*/i, '').replace(/\s*```$/i, '');
  if (/^```/.test(t) && /```$/.test(t)) {
    t = t.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  }
  return t.trim();
}

/**
 * OpenAI 호출 공통 래퍼
 * - developer 메시지: "결과만 출력" 강제
 * - 반환: 출력 텍스트(트림)
 */
async function runOpenAI(prompt) {
  const res = await client.responses.create({
    model: MODEL,
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: '너는 변환 엔진이다. 결과만 출력하고 설명은 금지.' }] },
      { role: 'user', content: [{ type: 'input_text', text: prompt }] }
    ]
  });
  return (res.output_text?.trim() || '');
}

// -------------------- Mermaid kind 매핑 --------------------
/**
 * usecase/activity → flowchart 강제 + 스타일 가드
 * 반환: { token, direction, guard }
 */
function mermaidKindConfig(kind) {
  const k = String(kind || '').toLowerCase();

  // ── Use Case 스타일 flowchart (가로 배치가 보기 좋아 LR)
  if (k === 'usecase') {
    const guard = `
[중요] Mermaid에는 'usecase' 다이어그램 토큰이 없다. 반드시 flowchart로 작성.
[형식] 첫 줄은 'flowchart LR'. 코드블록(\u0060\u0060\u0060) 금지.
[매핑 규칙]
- 시스템 경계: subgraph System [시스템명] ... end
- Actor: 네모[] 노드 + 라벨에 «actor»(유니코드 길러멧) 사용. 절대 <<actor>> 쓰지 말 것. 
  예) user[«actor» User]:::actor
- Use Case: 둥근 괄호 노드. 예) login(로그인):::usecase
- 연결:
  - Actor ↔ Use Case: --> (일반 연결)
  - «include»/«extend»: 점선 -.-> + 엣지 라벨. 예) A -.->|«include»| B
    (<<include>>/<<extend>> 대신 «include»/«extend» 사용)
- 금지: 'usecase', 'usecaseDiagram' 등의 토큰 사용 금지. 오직 flowchart로만.
[스타일 classDef]
classDef actor fill:#eef,stroke:#99f,stroke-width:1px,color:#003;
classDef usecase fill:#efe,stroke:#6c6,stroke-width:1px,color:#030;
`;
    return { token: 'flowchart', direction: 'LR', guard };
  }

  // ── Activity 스타일 flowchart (일반적으로 TD)
  if (k === 'activity') {
    const guard = `
[중요] Mermaid에는 'activity' 다이어그램 토큰이 없다. 반드시 flowchart로 작성.
[형식] 첫 줄은 'flowchart TD'. 코드블록(\u0060\u0060\u0060) 금지.
[매핑 규칙]
 - 모든 노드는 **ASCII id를 포함**해야 함 (익명 노드 금지)
  · 시작/종료: startNode((Start)), endNode((End))  ← 예약어 회피
  · 활동: measure[온도 측정]  ← id[라벨]
  · 의사결정: overheat{임계치 초과?}  ← id{라벨}
  · 같은 의미의 노드는 같은 id 재사용
 - 분기 라벨은 \u0060A -->|Yes| B\u0060 / \u0060A -->|No| C\u0060 형식만 사용
 - **예약어 id 금지**: start, end, class, subgraph, click, style, linkStyle 등 사용하지 말 것
- 병렬: fork[||]:::bar / join[||]:::bar 로 포크/조인
- 필요 시 subgraph로 swimlane 유사 구획 사용 (예: subgraph User [...])
- 금지: 'activity', 'activityDiagram' 등의 토큰 사용 금지.
[헤더 교정]
- 만약 잘못 생성되면 반드시 'flowchart TD'로 교정해 출력.
[스타일 classDef]
classDef startend fill:#fff,stroke:#888,stroke-width:1px,color:#111;
classDef bar stroke:#333,stroke-width:4px;
classDef step fill:#eef,stroke:#99f,color:#001;
classDef decision fill:#ffd,stroke:#cc4,color:#221;
`;
    return { token: 'flowchart', direction: 'TD', guard };
  }

  if (k === 'sequence') return { token: 'sequenceDiagram', direction: '', guard: '' };
  if (k === 'class') {
    const guard = `
[중요] Mermaid classDiagram 생성 규칙 (코드를 이미 개발했다고 가정하여 도메인 모델을 추출)
[헤더] 첫 줄은 'classDiagram'. 코드블록(\u0060\u0060\u0060) 금지. flowchart/sequence 사용 금지.
[구성]
- 최소 2개(권장 3~8개) 클래스. 서로 다른 책임을 단일 클래스로 합치지 말 것.
- 명사 → 클래스(PascalCase, ASCII), 핵심 상태 → 필드, 동사/행위 → 메서드.
- 필드/메서드 시그니처 예: 'name: string', 'check(t: float): bool'
- 타입은 string|int|float|bool|Date|enum 등 간결 타입 사용(과한 추측 금지).
- 가시성(+ # -)은 선택. 필요 시만 사용.
[관계]
- 상속: A <|-- B   합성: A *-- B   집합: A o-- B
- 연관: A --> B    의존: A ..> B
- 인터페이스는 'interface IName' 또는 'class IName <<interface>>'로 선언, 구현은 'C ..|> IName'
- 패키지는 'namespace Pack { ... }' 사용 가능.
[품질]
- 요구사항의 하위 기능/주체/리소스를 분리된 클래스로 모델링.
- 유사/중복 책임은 병합, 무관 책임은 분리. 단일 클래스에 모든 것을 몰아넣지 말 것.
[형식 예]
classDiagram
class Sensor { +read(): float }
class ThresholdPolicy { +limit: float; +isOver(t: float): bool }
class AlertService { +notify(msg: string): void }
class Controller { +check(t: float): void }
Sensor --> Controller : provides
Controller ..> ThresholdPolicy : uses
Controller --> AlertService : uses
`;
    return { token: 'classDiagram', direction: '', guard };
  }
  return { token: 'flowchart', direction: 'TD', guard: '' };
}
function normalizeMermaidOutput(kind, text) {
  let s = stripMermaidFences(String(text || ''));
  const lines = s.split(/\r?\n/);
  const first = (lines[0] || '').trim();
  const rest = lines.slice(1).join('\n');
  // 헤더 강제 교정
  if (/^usecaseDiagram\b/i.test(first)) s = `flowchart LR\n${rest}`;
  if (/^activityDiagram\b/i.test(first)) s = `flowchart TD\n${rest}`;
  // 스테레오타입 표기 교정: <<...>> → «...»
  s = s.replace(/<<\s*actor\s*>>/gi, '«actor»')
       .replace(/<<\s*include\s*>>/gi, '«include»')
       .replace(/<<\s*extend\s*>>/gi,  '«extend»');
  return s;
}

// ACTIVITY(flowchart) 전용 정규화: 익명 노드 → id부여, 라벨/헤더 교정
function sanitizeActivityFlowchart(raw) {
  let t = stripMermaidFences(String(raw || ''));
  // 1) 헤더를 flowchart TD로 강제
  t = t.replace(/^\s*(graph|flowchart)\s+[A-Z]{1,2}/i, 'flowchart TD');

  // 1a) 예약 id(start/end) → 안전 id로 선치환 (선언/인라인/간선 참조 모두)
  //    선언형:  start((Start)) / end((End))  →  startNode((Start)) / endNode((End))
  t = t.replace(/(^|\s)start\(\(\s*Start\s*\)\)/ig, (_,p1)=>`${p1}startNode((Start))`)
       .replace(/(^|\s)end\(\(\s*End\s*\)\)/ig,   (_,p1)=>`${p1}endNode((End))`);
  //    인라인 선언:  A --> end((End))  →  A --> endNode((End))
  t = t.replace(/(\s-->\s*)end\(\(\s*End\s*\)\)/ig, '$1endNode((End))')
       .replace(/(\s-->\s*)start\(\(\s*Start\s*\)\)/ig, '$1startNode((Start))');
  //    간선 참조:  --> end / start -->  →  endNode / startNode
  t = t.replace(/(-->|-\.->|\.\.->)\s*end\b/ig, '$1 endNode')
       .replace(/\bend\b\s*(-->|-\.->|\.\.->)/ig, 'endNode $1')
       .replace(/(-->|-\.->|\.\.->)\s*start\b/ig, '$1 startNode')
       .replace(/\bstart\b\s*(-->|-\.->|\.\.->)/ig, 'startNode $1');

  // 2) 분기 라벨 표기 교정
  //   --|Yes|-->  →  -->|Yes|   /   --|Yes| Target → -->|Yes| Target
  t = t.replace(/--\|([^|]+)\|-->/g, '-->|$1|')
       .replace(/--\|([^|]+)\|\s+([A-Za-z_][\w]*)/g, '-->|$1| $2');

  // 3) 익명 노드에 id 부여 (라벨 기반 slug로 안정적 매핑)
  const idMap = new Map();
  let seq = 1;
  const slug = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || `n${seq++}`;
  const ensureId = (key, base) => {
    if (idMap.has(key)) return idMap.get(key);
    let v = base; let i = 2;
    while (idMap.has(v)) v = `${base}_${i++}`;
    idMap.set(key, v); idMap.set(v, true);
    return v;
  };
  //   [라벨]  →  id[라벨]
  t = t.replace(/(^|\s)(\[\s*([^\[\]\n]+?)\s*\])(:::[\w-]+)?/g,
    (_, lead, whole, label, klass='') => {
      // 이미 id[...]: 전방에 영숫자/언더스코어가 있으면 패스
      if (/[A-Za-z0-9_]\[$/.test(lead)) return `${lead}${whole}${klass||''}`;
      const id = ensureId(`[]:${label}`, slug(label));
      return `${lead}${id}[${label}]${klass||''}`;
    });
  //   ((라벨))  →  start((Start)) / end((End)) / id((라벨))
  t = t.replace(/(^|\s)(\(\(\s*([^\(\)\n]+?)\s*\)\))(:::[\w-]+)?/g,
    (_, lead, whole, label, klass='') => {
      const base = /end/i.test(label) ? 'endNode' : /start/i.test(label) ? 'startNode' : slug(label);
      const id = ensureId(`((${label}))`, base);
      return `${lead}${id}((${label}))${klass||''}`;
    });
  //   {라벨}  →  id{라벨}
  t = t.replace(/(^|\s)({\s*([^{}\n]+?)\s*})(:::[\w-]+)?/g,
    (_, lead, whole, label, klass='') => {
      if (/[A-Za-z0-9_]\{$/.test(lead)) return `${lead}${whole}${klass||''}`;
      const id = ensureId(`{}:${label}`, `q_${slug(label)}`);
      return `${lead}${id}{${label}}${klass||''}`;
    });

  // 4) 익명 시작/종료 참조 교정: ((Start))/((End)) → startNode/endNode
  t = t.replace(/-->\s*\(\(\s*End\s*\)\)/ig,   '--> endNode')
       .replace(/-->\s*\(\(\s*Start\s*\)\)/ig, '--> startNode');

  // 5) start/end 선언 보강: 참조가 있는데 선언이 없으면 헤더 직후에 선언 삽입
  const hasHeader = /^\s*flowchart\s+TD\b/m.test(t);
  const declaresStart = /^\s*startNode\(\(/m.test(t);
  const declaresEnd   = /^\s*endNode\(\(/m.test(t);
  const refsStart = /\b(?:-->|-\.->|\.\.->)\s*startNode\b|\bstartNode\b\s*(?:-->|-\.->|\.\.->)/i.test(t);
  const refsEnd   = /\b(?:-->|-\.->|\.\.->)\s*endNode\b|\bendNode\b\s*(?:-->|-\.->|\.\.->)/i.test(t);

  if (hasHeader) {
    t = t.replace(/^\s*flowchart\s+TD\s*\n?/, (m) => {
      let inject = m;
      if (refsStart && !declaresStart) inject += 'startNode((Start)):::startend\n';
      if (refsEnd   && !declaresEnd)   inject += 'endNode((End)):::startend\n';
      return inject;
    });
  }

  // 6) 중복 end 선언/직접 참조 정리(최종 보정)
  t = t.replace(/-->\s*\(\(\s*End\s*\)\)/ig, '--> endNode');

  // 7) :::class 사용했는데 classDef가 없으면 기본 정의 자동 주입
  const usesClasses = /:::(startend|step|decision|bar)\b/.test(t);
  const hasClassDef = /^\s*classDef\s+/m.test(t);
  if (usesClasses && !hasClassDef) {
    t += `

classDef startend fill:#fff,stroke:#888,stroke-width:1px,color:#111;
classDef bar stroke:#333,stroke-width:4px;
classDef step fill:#eef,stroke:#99f,color:#001;
classDef decision fill:#ffd,stroke:#cc4,color:#221;`;
  }

  return t;
}


// ===================================================================
// 목록 API (List)
// ===================================================================

/**
 * 요구사항 목록
 * GET /api/list/req?type=SYS|SW|SW_DES|SW_TEST (옵션)
 * 응답: { items: Array<{ id, reqType, title, desc }> }
 */
app.get('/api/list/req', async (req, res) => {
  try {
    const { type = '' } = req.query;
    const db = await loadDb();
    const items = Object.values(db.requirements);
    const filtered = type ? items.filter(r => (r.reqType || '') === type) : items;
    res.json({
      items: filtered.map(r => ({ id: r.id, reqType: r.reqType, title: r.title || '', desc: r.desc || '' }))
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * 소스코드 목록
 * GET /api/list/code
 * 응답: { items: Array<{ codeId, language, code, swReqId }> }
 */
app.get('/api/list/code', async (req, res) => {
  try {
    const db = await loadDb();
    const items = Object.values(db.codes).map(c => ({
      codeId: c.codeId,
      language: c.language,
      code: c.code,
      swReqId: c.swReqId || ''
    }));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * 다이어그램 목록
 * GET /api/list/diagram?kind=usecase|sequence|class|activity (옵션)
 * 응답: { items: Array<{ diagramId, kind, mermaid, links }> }
 */
app.get('/api/list/diagram', async (req, res) => {
  try {
    const { kind = '' } = req.query;
    const db = await loadDb();
    const items = Object.values(db.diagrams);
    const filtered = kind
      ? items.filter(d => (d.kind || '').toLowerCase() === String(kind).toLowerCase())
      : items;
    res.json({
      items: filtered.map(d => ({
        diagramId: d.diagramId,
        kind: d.kind,
        mermaid: d.mermaid,
        links: d.links || {}
      }))
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===================================================================
// 단건 조회 (Get One)
// ===================================================================

/** GET /api/get/req/:id */
app.get('/api/get/req/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await loadDb();
    const r = db.requirements[id];
    if (!r) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** GET /api/get/code/:codeId */
app.get('/api/get/code/:codeId', async (req, res) => {
  try {
    const { codeId } = req.params;
    const db = await loadDb();
    const c = db.codes[codeId];
    if (!c) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(c);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** GET /api/get/diagram/:diagramId */
app.get('/api/get/diagram/:diagramId', async (req, res) => {
  try {
    const { diagramId } = req.params;
    const db = await loadDb();
    const d = db.diagrams[diagramId];
    if (!d) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===================================================================
// 저장(추적성 포함)  Save APIs
// ===================================================================

/**
 * 요구사항 저장/업서트
 * POST /api/save/req
 * body: { id, reqType, title?, desc? }
 */
app.post('/api/save/req', async (req, res) => {
  try {
    const { id, reqType, title, desc } = req.body || {};
    assertNonEmpty('id', id);
    assertNonEmpty('reqType', reqType);
    const db = await loadDb();
    db.requirements[id] = { id, reqType, title: title || '', desc: desc || '' };
    await saveDb(db);
    res.json({ ok: true, item: db.requirements[id] });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * 코드 저장/업서트
 * POST /api/save/code
 * body: { codeId, language, code, swReqId? }
 */
app.post('/api/save/code', async (req, res) => {
  try {
    const { codeId, language, code, swReqId } = req.body || {};
    assertNonEmpty('codeId', codeId);
    assertNonEmpty('language', language);
    assertNonEmpty('code', code);
    const db = await loadDb();
    db.codes[codeId] = { codeId, language, code, swReqId: swReqId || '' };
    await saveDb(db);
    res.json({ ok: true, item: db.codes[codeId] });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * 다이어그램 저장/업서트
 * POST /api/save/diagram
 * body: { diagramId, kind, mermaid, links? }
 */
app.post('/api/save/diagram', async (req, res) => {
  try {
    const { diagramId, kind, mermaid, links } = req.body || {};
    assertNonEmpty('diagramId', diagramId);
    assertNonEmpty('kind', kind);
    assertNonEmpty('mermaid', mermaid);
    const db = await loadDb();
    db.diagrams[diagramId] = {
      diagramId,
      kind,
      mermaid: stripMermaidFences(mermaid),
      links: links || {}
    };
    await saveDb(db);
    res.json({ ok: true, item: db.diagrams[diagramId] });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ===================================================================
// 변환 APIs (요구사항→MM, 코드→MM, MM→코드)
// ===================================================================

/**
 * 요구사항 → Mermaid
 * POST /api/convert/req2mm
 * body: { reqType, reqId, title?, desc?, diagramKind, diagramId }
 * resp: { ok, mermaid, diagramId, kind, linked: { reqId } }
 */
app.post('/api/convert/req2mm', async (req, res) => {
  try {
    const { reqType, reqId, title, desc, diagramKind, diagramId } = req.body || {};
    assertNonEmpty('reqType', reqType);
    assertNonEmpty('reqId', reqId);
    assertNonEmpty('diagramKind', diagramKind);
    assertNonEmpty('diagramId', diagramId);

    const cfg = mermaidKindConfig(diagramKind);
    const header = cfg.token === 'flowchart' ? `flowchart ${cfg.direction}` : cfg.token;
    const reqClassExtra =
      String(diagramKind).toLowerCase() === 'class'
        ? `
[요구사항→classDiagram 추가 지침]
- 단일 클래스 금지. 요구사항에서 추론되는 역할/엔티티/정책/서비스를 2~8개 클래스로 분해.
- 가능하면 Controller/Service/Model(엔티티)/Policy 등 서로 다른 책임을 분리하고 관계를 명시.
- 불분명한 세부 정보는 과도하게 가정하지 말고 타입/연관만 간결히 표기.`
        : '';
const prompt = `[목표] 아래 요구사항을 ${diagramKind} 관점의 Mermaid 다이어그램 1개 생성.
[형식] 첫 줄에 '${header}' 를 사용.
${cfg.guard}
[출력] Mermaid 코드만. 코드블록(\u0060\u0060\u0060) 금지.
[입력]
- 요구사항 유형: ${reqType}
- 요구사항 ID: ${reqId}
- 제목: ${title || ''}
- 내용: ${desc || ''}`;

    const mermaidRaw = await runOpenAI(prompt);
    let mermaid = normalizeMermaidOutput(diagramKind, mermaidRaw);
    if (String(diagramKind).toLowerCase() === 'activity') {
      mermaid = sanitizeActivityFlowchart(mermaid);
    }
    // 변환 결과만 반환 (저장은 /api/save/diagram 에서)
    res.json({ ok: true, mermaid, diagramId, kind: diagramKind, linked: { reqId } });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * 코드 → Mermaid
 * POST /api/convert/code2mm
 * body: { codeId, language, code, diagramKind, diagramId, swReqId, reqJoin? }
 * resp: { ok, mermaid, diagramId, kind, linked: { codeId, swReqId, reqId? } }
 */
app.post('/api/convert/code2mm', async (req, res) => {
  try {
    const { codeId, language, code, diagramKind, diagramId, swReqId, reqJoin } = req.body || {};
    assertNonEmpty('codeId', codeId);
    assertNonEmpty('language', language);
    assertNonEmpty('code', code);
    assertNonEmpty('diagramKind', diagramKind);
    assertNonEmpty('diagramId', diagramId);
    assertNonEmpty('swReqId', swReqId);

    const cfg = mermaidKindConfig(diagramKind);
const header = cfg.token === 'flowchart' ? `flowchart ${cfg.direction}` : cfg.token;
const prompt = `[목표] 아래 ${language} 소스코드를 ${diagramKind} 관점으로 Mermaid 1개 생성.
[형식] 첫 줄에 '${header}' 를 사용.
${cfg.guard}
[출력] Mermaid 코드만. 코드블록(\u0060\u0060\u0060) 금지.
[참고] 연결된 SW Test 요구사항 ID: ${swReqId}
[선택 정보] 요구사항 매칭(있으면 반영): ${reqJoin ? JSON.stringify(reqJoin) : '없음'}
[소스코드]
${code}`;

    const gen = await runOpenAI(prompt);
    let mermaid = normalizeMermaidOutput(diagramKind, gen);
    if (String(diagramKind).toLowerCase() === 'activity') {
      mermaid = sanitizeActivityFlowchart(mermaid);
    }
    res.json({
      ok: true, mermaid, diagramId, kind: diagramKind,
      linked: { codeId, swReqId, ...(reqJoin?.reqId ? { reqId: reqJoin.reqId } : {}) }
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

/**
 * Mermaid → 코드
 * POST /api/convert/mm2code
 * body: { diagramId?, diagramKind, mermaid?, language, codeId?, swReqId }
 *  - mermaid가 없으면 diagramId로 DB에서 조회하여 사용
 * resp: { ok, codeId, language, code, diagramId, diagramKind }
 */
app.post('/api/convert/mm2code', async (req, res) => {
  try {
    const { diagramId, diagramKind, mermaid, language, codeId, swReqId } = req.body || {};
    assertNonEmpty('diagramKind', diagramKind);
    assertNonEmpty('language', language);
    assertNonEmpty('swReqId', swReqId);

    const db = await loadDb();
    let mm = mermaid;
    if (!mm && diagramId && db.diagrams[diagramId]) {
      mm = db.diagrams[diagramId].mermaid;
    }
    mm = stripMermaidFences(mm);
    assertNonEmpty('mermaid', mm);

    const prompt = `
[목표] 아래 ${diagramKind} Mermaid를 ${language} 소스코드로 구현(필요 최소 골격).
[출력] 코드만.
[Mermaid]
${mm}
`;

    const genCode = await runOpenAI(prompt);
    const newCodeId = codeId && codeId.trim() !== '' ? codeId : `CODE-${Date.now()}`;
    // 변환 결과만 반환 (저장은 /api/save/code 에서)
    res.json({ ok: true, codeId: newCodeId, language, code: genCode, diagramId, diagramKind });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// -------------------- 서버 시작 --------------------
const API_PORT = process.env.API_PORT || 3000; // 프론트 PORT와 분리
app.listen(API_PORT, () => {
  console.log(`[server] listening on http://localhost:${API_PORT}`);
});
