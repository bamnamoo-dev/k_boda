# PrismView 분석 결과 수정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 전체 분석에서 나온 규칙 위반·버그를 고치고, 배포 용량과 저장소를 정리한다. 새 기능은 만들지 않는다.

**Architecture:** 기존 구조(App.tsx 단일 컴포넌트 + lib.rs 단일 백엔드)를 그대로 두고 필요한 곳만 고친다. 파일 분리(App.tsx/lib.rs 쪼개기)는 이 계획 범위가 아니며 별도 계획으로 한다.

**Tech Stack:** Tauri 2, React 19, TypeScript, Rust(image 0.25, trash 5), @tauri-apps/plugin-dialog

**Spec:** 이 대화의 "전체 분석 결과" 답변 + [AGENTS.md](../../../AGENTS.md)

## Global Constraints

- 새 라이브러리 추가 금지 (이 계획의 모든 작업은 기존 의존성만 사용)
- 삭제는 반드시 `trash::delete` (영구 삭제 금지, AGENTS.md 규칙 2)
- 덮어쓰기는 확인 창을 거친다 (규칙 3)
- UI 문구는 한국어 (규칙 7)
- 미리 읽기 캐시는 앞뒤 2장까지만 (성능 목표)
- 테스트: 프론트엔드 테스트 도구가 없으므로(추가는 새 라이브러리) 프론트 작업은 `npx tsc --noEmit` + 수동 확인, 백엔드 순수 함수는 `lib.rs` 안 `#[cfg(test)] mod tests`로 `cargo test`
- 명령어는 모두 PowerShell에서 프로젝트 폴더(`D:\antigravity\k-boda`) 기준

## Review Focus

1. 미리 읽기: 폴더 처음/끝(인덱스 0, 마지막)에서 범위 밖 인덱스 접근 없이 동작해야 한다 → Task 1 수동 확인 항목
2. 클립보드 저장: 투명 배경(RGBA) PNG를 JPG로 저장해도 오류 없이 저장돼야 한다 → Task 2 테스트 `encode_rgba_to_jpg_succeeds`
3. 덮어쓰기 확인: 겹치는 파일이 0개면 확인 창이 뜨지 않아야 한다 (매번 뜨면 불편) → Task 4 수동 확인
4. CSP 적용 후 이미지·썸네일·얼굴 인식(wasm)·CAD 보기가 모두 그대로 동작해야 한다 → Task 6 확인 목록
5. libredwg 정리 후 DWG 열기/썸네일이 설치판에서도 동작해야 한다 → Task 7 확인

---

### Task 0: 현재 변경사항을 기준점으로 커밋

지금 커밋 안 된 변경(이름 PrismView로 변경, 설치 훅, 라이선스 파일, release 스크립트)을 먼저 커밋해 두어야 이후 작업을 되돌리기 쉽다. 단 `release/` 폴더는 커밋하지 않는다.

- [ ] **Step 1:** `.gitignore` 끝에 `release/` 한 줄 추가
- [ ] **Step 2:** `git status`로 `release/`가 목록에서 사라졌는지 확인
- [ ] **Step 3: Commit**

```powershell
git add .gitignore README.md package.json src-tauri/Cargo.lock src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/tauri.conf.json src/App.tsx public/LICENSES.txt scripts/ src-tauri/installer-hooks.nsh src-tauri/resources/
git commit -m "chore: PrismView 이름 변경 및 배포 스크립트 추가, release 폴더 제외"
```

---

### Task 1: 미리 읽기 캐시를 앞뒤 2장으로 제한 (🔴1)

**Files:**
- Modify: `src/App.tsx:1241-1263` (미리 읽기 useEffect)

**Interfaces:**
- Produces: `function getPreloadIndices(current: number, length: number): number[]` — App.tsx 상단(컴포넌트 밖) 순수 함수. `current-2, current-1, current+1, current+2` 중 `0 <= i < length`인 것만 반환.

- [ ] **Step 1:** `getPreloadIndices` 작성
- [ ] **Step 2:** useEffect를 다음 순서로 수정: (a) 대상 URL 집합 계산 (b) `preloadCacheRef.current`에서 집합에 없는 항목은 `img.src = ""` 후 `delete` (c) 집합에 있는데 캐시에 없는 것만 새로 `new Image()` + `decode()`. 주석 "앞 1장, 뒤 2장" → "앞뒤 2장"으로 수정
- [ ] **Step 3:** `npx tsc --noEmit` → 출력 없음
- [ ] **Step 4: 수동 확인** (`npm run tauri dev`)
  - 사진 200장 이상 폴더에서 → 키로 끝까지 넘김. 작업 관리자에서 PrismView(WebView2) 메모리가 계속 늘지 않고 일정 범위에 머무는지 확인
  - 첫 사진에서 ←, 마지막 사진에서 → 를 눌러 오류 없는지 확인
  - 다음 장 전환이 전과 같이 즉시 뜨는지 확인
- [ ] **Step 5: Commit** `fix: 미리 읽기 캐시를 앞뒤 2장으로 제한하고 범위 밖 항목 해제`

---

### Task 2: 클립보드 이미지를 선택한 형식으로 실제 변환해 저장 (🔴2)

**Files:**
- Modify: `src-tauri/src/lib.rs:3009-3031` (`save_clipboard_image`)
- Test: `src-tauri/src/lib.rs` 맨 끝에 `#[cfg(test)] mod tests` 신설

**Interfaces:**
- Produces: `fn encode_image_bytes_for_ext(bytes: &[u8], ext: &str) -> Result<Vec<u8>, String>` — `image::load_from_memory`로 읽어 `ext`(대소문자 무시)에 맞게 다시 인코딩. `png`/`webp`/`bmp`는 그대로 포맷만 지정, `jpg`/`jpeg`는 `to_rgb8()` 후 품질 92로 인코딩(JPEG은 투명도를 못 담음). 그 외 확장자는 `Err("지원하지 않는 저장 형식입니다: {ext}")`.
- `save_clipboard_image`의 시그니처는 그대로. base64 디코딩 후 대상 파일 확장자로 `encode_image_bytes_for_ext`를 거쳐 쓴다. CadViewer(PNG 고정)도 그대로 동작.

- [ ] **Step 1: 실패하는 테스트 작성**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sample_rgba_png() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 128]));
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img).write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    #[test]
    fn encode_rgba_to_jpg_succeeds() {
        let out = encode_image_bytes_for_ext(&sample_rgba_png(), "JPG").unwrap();
        assert_eq!(image::guess_format(&out).unwrap(), image::ImageFormat::Jpeg);
    }

    #[test]
    fn encode_to_webp_and_png() {
        let png = sample_rgba_png();
        assert_eq!(image::guess_format(&encode_image_bytes_for_ext(&png, "webp").unwrap()).unwrap(), image::ImageFormat::WebP);
        assert_eq!(image::guess_format(&encode_image_bytes_for_ext(&png, "png").unwrap()).unwrap(), image::ImageFormat::Png);
    }

    #[test]
    fn encode_unknown_ext_fails() {
        assert!(encode_image_bytes_for_ext(&sample_rgba_png(), "gif").is_err());
    }
}
```

- [ ] **Step 2:** `cd src-tauri; cargo test; cd ..` → 컴파일 실패(`encode_image_bytes_for_ext` 없음)
- [ ] **Step 3:** 함수 구현 + `save_clipboard_image`에서 사용
- [ ] **Step 4:** `cd src-tauri; cargo test; cd ..` → 3개 모두 PASS
- [ ] **Step 5: 수동 확인:** 화면 캡처(Win+Shift+S) → PrismView에서 Ctrl+V → Ctrl+S → JPEG 선택 저장 → 저장된 파일을 그림판으로 열어 정상 표시 확인
- [ ] **Step 6: Commit** `fix: 클립보드 이미지를 선택한 형식(JPG/WebP/PNG)으로 변환해 저장`

---

### Task 3: 동작하지 않는 메타데이터 옵션 정리 (🔴3)

결정: 현재 모든 저장 경로(image 크레이트 재인코딩, canvas)는 메타데이터를 **항상** 지운다. "유지" 기능을 새로 만들지 않고(범위 밖), 실제 동작대로 화면을 고친다.

**Files:**
- Modify: `src/App.tsx:452-453, 1840-1841, 1906-1907, 5370-5390`
- Modify: `src-tauri/src/lib.rs:722-735` (`save_image_advanced` 인자), `src-tauri/src/lib.rs:3923-3927` (`save_edited_image` 인자)
- Modify: `src/MosaicEditorModal.tsx:46, 444, 663 부근`, `src/PhotoCollageModal.tsx:354`, `src/PhotoStampModal.tsx:420`

**Interfaces:**
- `save_image_advanced`에서 `_strip_metadata`, `_strip_ai_prompt` 인자 삭제
- `save_edited_image(base64_data: String, target_path: String)` — `_strip_exif` 삭제

- [ ] **Step 1:** 백엔드 두 함수에서 안 쓰는 인자 삭제
- [ ] **Step 2:** App.tsx: `saveAsStripMetadata`/`saveAsStripAiPrompt` 상태, 초기화, invoke 인자 삭제. "메타데이터 옵션" 체크박스 두 개를 안내 문구 하나로 교체: `저장한 사본에는 EXIF·AI 프롬프트 등 메타데이터가 포함되지 않습니다.`
- [ ] **Step 3:** 모자이크 창의 `stripExif` 상태와 체크박스 삭제(같은 안내 문구로 교체), 콜라주·도장 invoke에서 `stripExif` 인자 삭제
- [ ] **Step 4:** `npx tsc --noEmit` → 출력 없음, `cd src-tauri; cargo check; cd ..` → 경고 없음
- [ ] **Step 5: 수동 확인:** 다른 이름으로 저장 / 모자이크 저장 / 콜라주 저장이 각각 성공하는지 확인
- [ ] **Step 6: Commit** `fix: 동작하지 않던 메타데이터 옵션을 실제 동작에 맞게 안내 문구로 교체`

---

### Task 4: 복사/이동 덮어쓰기 전 확인 창 (🔴4)

**Files:**
- Modify: `src/App.tsx:6` (import에 `ask` 추가), `src/App.tsx:2175-2190` (`executeCopyMove`)
- Modify: `src-tauri/capabilities/default.json` (권한 `"dialog:allow-ask"` 추가)

**Interfaces:**
- Consumes: 기존 `check_path_exists(path: String) -> bool`
- 대상 경로는 `${target}\\${파일이름}`(파일이름은 원본 경로의 마지막 `\` 또는 `/` 뒤)

- [ ] **Step 1:** `executeCopyMove`에서 `copyMoveConflict === "overwrite"`일 때만, 원본마다 `check_path_exists`로 겹치는 개수 N을 센다. N > 0이면 `ask` 호출, 거절이면 `return`

```ts
const ok = await ask(
  `대상 폴더에 이름이 같은 파일이 ${n}개 있습니다.\n기존 파일은 휴지통으로 이동하고 덮어씁니다. 계속할까요?`,
  { title: "덮어쓰기 확인", kind: "warning", okLabel: "덮어쓰기", cancelLabel: "취소" }
);
```

- [ ] **Step 2:** `npx tsc --noEmit` → 출력 없음
- [ ] **Step 3: 수동 확인:** 같은 이름 파일이 있는 폴더로 "덮어쓰기" 모드 복사 → 확인 창 뜸, 취소 시 아무 변화 없음, 확인 시 기존 파일이 휴지통에 들어가 있음. 겹치는 파일이 없으면 창이 뜨지 않음
- [ ] **Step 4: Commit** `fix: 복사/이동 덮어쓰기 전에 확인 창 표시`

---

### Task 5: 이동 되돌리기에서 영구 삭제 제거 (🔴5)

**Files:**
- Modify: `src-tauri/src/lib.rs:2580-2587`

- [ ] **Step 1:** `copy_entry_recursive` 성공 후의 `remove_dir_all`/`remove_file` 분기를 `let _ = trash::delete(dest_p);` 한 줄로 교체 (move_files_to_folder의 2741줄과 같은 방식)
- [ ] **Step 2:** `cd src-tauri; cargo check; cd ..` → 경고 없음
- [ ] **Step 3: 수동 확인:** USB 등 다른 드라이브로 파일 이동 → Ctrl+Z → 원래 위치로 돌아오고, USB 쪽 사본은 휴지통에 있음
- [ ] **Step 4: Commit** `fix: 드라이브 간 이동 되돌리기 시 영구 삭제 대신 휴지통 사용`

---

### Task 6: 웹 보안 정책(CSP) 설정 (🔴6)

asset 허용 범위 `"**"`는 유지한다(임의 폴더·네트워크 드라이브를 열어야 하므로). 대신 CSP로 외부 스크립트·외부 통신을 막는다.

**Files:**
- Modify: `src-tauri/tauri.conf.json` `app.security.csp`

- [ ] **Step 1:** `"csp": null`을 아래로 교체

```json
"csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data: blob:; media-src 'self' asset: http://asset.localhost blob:; connect-src 'self' ipc: http://ipc.localhost asset: http://asset.localhost; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'"
```

- [ ] **Step 2: 수동 확인 (`npm run tauri dev`, F12 개발자 도구 Console에 "Content Security Policy" 오류가 없어야 함)**
  - JPG/PNG/GIF/WebP/SVG 표시, 탐색기 썸네일, ZIP 내부 이미지, TIFF 여러 페이지, HEIC
  - Shift+P 증명사진 얼굴 인식, DWG/DXF 열기, 콜라주/모자이크 저장, 클립보드 붙여넣기
  - 오류가 나면 해당 지시어에 Console이 알려주는 출처만 추가
- [ ] **Step 3: Commit** `fix: CSP를 설정해 외부 스크립트와 통신 차단`

---

### Task 7: 배포 용량 정리 (🟡2, 🟡3)

**Files:**
- Delete (git rm): `src-tauri/binaries/libredwg/` 안에서 아래 **남길 것** 외 전부
  - 남길 것: `dwg2dxf.exe`, `dwgbmp.exe`, `libredwg-0.dll`, `libiconv-2.dll`, `libpcre2-8-0.dll`, `libpcre2-16-0.dll`, `README.txt`
- Delete: `public/mediapipe/wasm/vision_wasm_module_internal.*`, `public/mediapipe/wasm/vision_wasm_nosimd_internal.*`
- Modify: `src-tauri/tauri.conf.json` `bundle.resources`의 `"binaries/libredwg/**/*"` → `"binaries/libredwg/*"`

- [ ] **Step 1:** 파일 삭제 후 `npm run tauri dev`
- [ ] **Step 2: 수동 확인:** DWG 파일 열기(dwg2dxf) + 탐색기에서 DWG 썸네일(dwgbmp) + Shift+P 얼굴 인식 동작. 하나라도 실패하면 해당 파일만 되살림(`git checkout -- <파일>`)
- [ ] **Step 3:** `npm run release` 후 설치판을 설치해 Step 2를 한 번 더 확인, `release\1.0.0` 설치 파일 크기가 전보다 줄었는지 확인
- [ ] **Step 4: Commit** `chore: 사용하지 않는 libredwg 파일과 MediaPipe wasm 변형 제거`

---

### Task 8: 작은 정리 (🟡4, 🟢1~4)

**Files:**
- Modify: `src-tauri/tauri.conf.json` fileAssociations `ext`에 `"jfif"` 다시 추가 (App.tsx 45줄 IMAGE_EXTENSIONS와 맞춤)
- Modify: `scripts/release.mjs:11` — `VERSION`을 `package.json`의 `version`에서 읽기 (`JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version`)
- Modify: `src-tauri/Cargo.toml` `authors = ["you"]` → 사용자가 정한 이름 (실행 전에 사용자에게 묻기)
- Modify: `src-tauri/src/lib.rs:657` 주석 → `/// 파일을 윈도우 휴지통으로 보내고 되돌리기(Ctrl+Z) 기록에 추가`
- Modify: `src-tauri/src/lib.rs` `get_tiff_page`, `get_heic_display_path` — 캐시 파일을 새로 만든 직후 `cleanup_cache_if_needed(&cache_dir);` 호출 (지금은 썸네일 생성 때만 500MB 정리가 돎)

제외: 레지스트리 키 `k-boda.Cad` 이름 변경 — 이미 연결을 켠 사용자의 설정이 깨지므로 그대로 둔다. `console.error/warn`은 모두 오류 경로 기록이라 그대로 둔다(분석 때 "정리 대상"이라고 한 것은 정정).

- [ ] **Step 1:** 위 수정 적용
- [ ] **Step 2:** `npx tsc --noEmit`, `cd src-tauri; cargo check; cargo test; cd ..` → 모두 통과
- [ ] **Step 3:** `npm run release -- --skip-build`가 버전 1.0.0으로 동작하는지 확인
- [ ] **Step 4: Commit** `chore: jfif 연결 복구, 릴리스 버전 자동화, 캐시 정리 보강`

---

## 이 계획에 넣지 않은 것 (별도 결정 필요)

- App.tsx(6,275줄)·lib.rs(4,593줄) 파일 분리 — 기능 변경 없는 큰 리팩터링이라 별도 계획으로
- AGENTS.md "편집기가 아니다" 문구와 실제 기능(증명사진·콜라주·CAD 등)의 불일치 — 사용자가 방향 결정
- 성능 목표 측정 코드 — 위 수정 후 별도로
