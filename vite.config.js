// vite.config.js
/**
 * ============================================
 * App: UML ↔ Code Studio
 * File: vite.config.js (주석 정리/가독성 개선판)
 * --------------------------------------------
 * 목적
 *  - Vite 개발 서버(프론트) 설정
 *  - /api → 로컬 Express 백엔드(server.mjs)로 프록시
 *
 * 동작 개요
 *  - 현재 실행 모드(mode)에 맞는 .env 파일 로드 (loadEnv)
 *  - 백엔드 포트: env.API_PORT (기본 3000)
 *  - 프론트 개발 서버: http://localhost:5173
 *  - /api/* 요청은 http://localhost:${API_PORT}/api/* 로 프록시
 *
 * 비고
 *  - loadEnv에 prefix ''(빈 문자열)을 주어 VITE_* 외의 키도 로드
 *  - dev 환경 편의를 위한 proxy 설정으로, CORS 우회를 위해 사용
 * ============================================
 */

import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // 현재 mode에 해당하는 .env.* 파일을 읽어 env 오브젝트로 반환
  // 예: .env, .env.development, .env.local 등
  // prefix를 ''로 주면 모든 키 로드(VITE_*로 제한하지 않음)
  const env = loadEnv(mode, process.cwd(), '');
  // 프록시 대상 백엔드 포트: API_PORT(권장) → VITE_API_PORT → 기본 3000
  const apiPort = env.API_PORT || env.VITE_API_PORT || '3000';
  // 프론트 개발 서버 포트는 VITE_PORT만 사용(기본 5173)
  const devPort = Number(env.VITE_PORT || 5173);

  return {
    // ──────────────────────────────────────────────
    // Vite Dev Server
    // ──────────────────────────────────────────────
    server: {
      port: devPort, // 프론트 개발 서버 포트
      proxy: {
        // 프론트에서 상대경로 /api/* 로 호출하면 백엔드로 전달
        '/api': {
          target: `http://localhost:${apiPort}`,   // 백엔드 서버 주소(분리된 변수)
          changeOrigin: true,                      // 요청 Host 헤더를 target 기준으로 변경
          secure: false,                           // self-signed 등 허용(HTTP 개발용)
          // rewrite가 필요 없다면 그대로 두고 경로 유지
          // rewrite: (p) => p,
        },
      },
    },
  };
});
