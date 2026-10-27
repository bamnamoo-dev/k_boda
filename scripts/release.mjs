import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const VERSION = "1.0.0";
const RELEASE_DIR = path.join(rootDir, "release", VERSION);
const TEMP_PORTABLE_DIR = path.join(rootDir, "release", "portable_temp");

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function calculateSha256(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash("sha256");
  hashSum.update(fileBuffer);
  return hashSum.digest("hex");
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log("==================================================================");
console.log(`  PrismView v${VERSION} 올인원 릴리즈 패키징 스크립트 시작`);
console.log("==================================================================");

// 1. release 디렉터리 준비
if (!fs.existsSync(RELEASE_DIR)) {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
}

if (fs.existsSync(TEMP_PORTABLE_DIR)) {
  fs.rmSync(TEMP_PORTABLE_DIR, { recursive: true, force: true, maxRetries: 3 });
}
fs.mkdirSync(TEMP_PORTABLE_DIR, { recursive: true });

// 2. 프론트엔드 & Tauri 배포판 빌드
if (skipBuild) {
  console.log("\n[1/5] --skip-build 옵션: Tauri 빌드를 건너뛰고 기존 빌드 산출물을 사용합니다.");
} else {
  console.log("\n[1/5] Tauri 릴리즈 빌드 진행 (tauri build)...");
  try {
    execSync("npm run tauri -- build", {
      cwd: rootDir,
      stdio: "inherit",
      shell: true,
    });
  } catch (err) {
    console.error("Tauri 릴리즈 빌드 실패:", err);
    process.exit(1);
  }
}

// 3. NSIS 설치 파일 복사 및 정규화
console.log("\n[2/5] NSIS 설치 파일 수집...");
const nsisSourceDir = path.join(rootDir, "src-tauri", "target", "release", "bundle", "nsis");
const targetSetupExe = path.join(RELEASE_DIR, `PrismView_${VERSION}_x64-setup.exe`);

let foundInstaller = null;
const expectedInstaller = path.join(nsisSourceDir, `PrismView_${VERSION}_x64-setup.exe`);
if (fs.existsSync(expectedInstaller)) {
  foundInstaller = expectedInstaller;
} else if (fs.existsSync(nsisSourceDir)) {
  const files = fs.readdirSync(nsisSourceDir)
    .filter((f) => f.endsWith(".exe") && !f.includes("uninstall"))
    .map((f) => ({ name: f, time: fs.statSync(path.join(nsisSourceDir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  if (files.length > 0) {
    foundInstaller = path.join(nsisSourceDir, files[0].name);
  }
}

if (!foundInstaller) {
  console.error("NSIS 설치 파일을 찾을 수 없습니다:", nsisSourceDir);
  process.exit(1);
}

fs.copyFileSync(foundInstaller, targetSetupExe);
console.log(`✔ 설치 파일 복사 완료: ${path.basename(targetSetupExe)}`);

// 4. README.txt 작성
console.log("\n[3/5] 배포용 README.txt 작성...");
const readmeContent = `================================================================================
PrismView v${VERSION} - 윈도우용 빠르고 가벼운 이미지 뷰어
================================================================================

1. 소개
PrismView는 윈도우 10/11 전용으로 설계된 빠르고 가벼운 초경량 이미지 뷰어입니다.
열자마자 바로 사진을 확인하고 키보드만으로 시원시원하게 넘겨볼 수 있습니다.

[완전 오프라인 & 프라이버시 보장]
모든 기능(공무원증/증명사진 규격 맞춤, 얼굴 자동 감지, CAD 도면 열람, 
일괄 포맷 변환, 모자이크 등)은 100% 사용자의 PC 내부에서만 동작합니다.
어떠한 사진이나 개인정보도 외부 인터넷이나 클라우드로 전송되지 않습니다.

--------------------------------------------------------------------------------
2. 설치 방법 및 SmartScreen 안내
--------------------------------------------------------------------------------
[설치 버전 (PrismView_${VERSION}_x64-setup.exe)]
1) 설치 파일을 더블 클릭하여 실행합니다.
   * 관리자 권한 없이 현재 사용자 계정에 안전하고 빠르게 설치됩니다.
2) Windows SmartScreen ("Windows의 PC 보호") 창이 뜨는 경우:
   - [추가 정보] 링크를 클릭합니다.
   - 나타나는 [실행] 버튼을 클릭하면 정상적으로 설치가 진행됩니다.
   (코드 사이닝 인증서가 없는 무료 오픈소스 소프트웨어에서 최초 실행 시 나타나는 정상 안내입니다)
3) 설치 중 시작 메뉴 바로가기 및 바탕화면 바로가기 생성을 선택할 수 있습니다.
4) 기본 이미지 형식(JPG, PNG, GIF, WebP, AVIF, BMP, SVG, TIFF, HEIC, ZIP 등)이
   PrismView와 자동으로 연결됩니다.
   * AutoCAD 및 CAD 사용자의 기존 연결 보호를 위해 .dwg, .dxf는 자동 연결되지 않으며,
     설정에서 원하실 때만 켜실 수 있습니다.

[제거 방법]
- Windows "설정" → "앱" → "설치된 앱 (앱 및 기능)"에서 'PrismView'를 찾아 [제거]를 클릭합니다.
- 제거 시 개인 설정과 썸네일·도면 캐시를 함께 삭제할지 묻는 안내창이 뜹니다.
  (기본값은 재설치 시 설정을 유지하기 위해 '아니요'로 안전하게 보존됩니다)

--------------------------------------------------------------------------------
3. 무설치 포터블 버전 (PrismView_${VERSION}_portable.zip)
--------------------------------------------------------------------------------
- 압축을 원하는 폴더나 USB 드라이브에 풀고 바로 'PrismView.exe'를 실행하시면 됩니다.
- 윈도우 레지스트리나 시스템 폴더를 건드리지 않으며, 파일 연결을 등록하지 않습니다.
- 모든 개인 설정 및 캐시는 실행 파일 옆의 'data' 폴더에 저장되어 설치 버전과 섞이지 않습니다.
- 쓰기 권한이 없는 읽기 전용 USB나 제한된 폴더에서 실행하더라도 앱이 오류 없이 
  정상 작동하도록 시스템 임시 폴더에 캐시를 자동 우회 처리합니다.

--------------------------------------------------------------------------------
4. 주요 단축키 요약
--------------------------------------------------------------------------------
• 탐색 및 보기 모드:
  - Tab: 뷰어 모드 ↔ 탐색기(그리드) 모드 전환
  - Space / Enter: 사진 열기 / 슬라이드쇼 일시정지
  - 좌/우 화살표, 마우스 휠: 이전/다음 사진 이동
  - Backspace: 상위 폴더로 이동 (탐색기)
  - Home / End: 첫 번째 / 마지막 사진으로 이동
  - F: 화면 맞춤 (원본이 화면보다 크면 축소)
  - 1: 100% 원본 크기 보기
  - + / -: 줌 확대 / 축소
  - I: 사진 상세 정보 패널 토글 (EXIF 메타데이터)
  - F11: 전체 화면 토글
  - H 또는 F1: 단축키 안내 및 PrismView 정보 보기

• 편집 및 부가 기능:
  - Shift + P: 공무원증 / 증명사진 규격 자동 맞춤기
  - Ctrl + M: 얼굴 모자이크 / 블러 / 블랙박스 가리기
  - Shift + X: 사진 자르기
  - Shift + E: 사진 밝기 / 대비 / 채도 보정
  - R / Shift + R: 시계방향 90도 / 반시계방향 90도 회전
  - Ctrl + S: 변경 사항을 사본으로 저장 (원본 보호)
  - Delete: 파일을 윈도우 휴지통으로 이동 (영구 삭제 금지)
  - Ctrl + Z: 방금 삭제/이동한 파일 복원 (Undo)

• 일괄 작업 및 문서 생성 (탐색기 모드에서 여러 장 선택):
  - Ctrl + Shift + B: 일괄 포맷 변환 및 크기 조절
  - Ctrl + F2: 일괄 파일 이름 변경 (번호/날짜/패턴)
  - Ctrl + Alt + C: 사진 합치기 (바둑판 콜라주 생성)
  - Ctrl + Alt + P: 여러 장의 사진을 묶어 PDF로 저장
  - Ctrl + Alt + T: 사진 도장 및 날짜 스탬프 찍기

--------------------------------------------------------------------------------
5. 공무원증 사진 규격 맞춤 (3줄 요약)
--------------------------------------------------------------------------------
1) 증명사진 모드(단축키 Shift + P)를 열면 인공지능이 얼굴을 찾아 3:4 규격 틀 안에 자동 배치합니다.
2) 마우스 드래그로 위치와 크기를 정밀 조정한 뒤 [Enter]를 누릅니다.
3) 자동으로 정확히 354×472 픽셀, 150KB 미만, 메타데이터 제거된 표준 JPG로 저장되며 "규격 통과" 초록 배지가 표시됩니다.

--------------------------------------------------------------------------------
6. 오픈소스 라이선스 고지
--------------------------------------------------------------------------------
PrismView는 다음과 같은 오픈소스 프로젝트들을 사용합니다:
• GNU LibreDWG 0.14: GPLv3+ (별도 CLI 프로세스로 격리 호출)
  - 소스 코드: https://www.gnu.org/software/libredwg/
• Google MediaPipe Tasks Vision: Apache 2.0 (로컬 BlazeFace 모델)
• React 19, Tauri 2, dxf-parser, Lucide Icons: MIT / Apache 2.0 / ISC
자세한 라이선스 전문은 동봉된 LICENSES.txt 및 GPLv3.txt 파일을 참조하십시오.

--------------------------------------------------------------------------------
7. 문의 및 지원
--------------------------------------------------------------------------------
버그 제보 및 기능 제안:
GitHub Issues: https://github.com/bamnamoo-dev/k_boda/issues
`;

const targetReadme = path.join(RELEASE_DIR, "README.txt");
fs.writeFileSync(targetReadme, readmeContent, "utf-8");

// 5. 포터블 패키지 조립
console.log("\n[4/5] 포터블 ZIP 패키지 생성...");
const releaseExeSource = path.join(rootDir, "src-tauri", "target", "release", "k-boda.exe");
if (!fs.existsSync(releaseExeSource)) {
  console.error("컴파일된 실행 파일을 찾을 수 없습니다:", releaseExeSource);
  process.exit(1);
}

// 1) 실행 파일 복사 (PrismView.exe)
fs.copyFileSync(releaseExeSource, path.join(TEMP_PORTABLE_DIR, "PrismView.exe"));

// 2) LibreDWG 필수 런타임 파일 복사 (dwg2dxf.exe, dwgbmp.exe 및 핵심 DLL들)
const libredwgSource = path.join(rootDir, "src-tauri", "binaries", "libredwg");
const libredwgDest = path.join(TEMP_PORTABLE_DIR, "binaries", "libredwg");
fs.mkdirSync(libredwgDest, { recursive: true });

const requiredLibreDwgFiles = [
  "dwg2dxf.exe",
  "dwgbmp.exe",
  "libredwg-0.dll",
  "libiconv-2.dll",
  "libpcre2-8-0.dll",
  "libpcre2-16-0.dll",
];

for (const f of requiredLibreDwgFiles) {
  const src = path.join(libredwgSource, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(libredwgDest, f));
  }
}

// 3) MediaPipe 모델 및 WASM 복사 (요구사항 9번: 오프라인 에셋 동봉)
const mediapipeSource = path.join(rootDir, "public", "mediapipe");
const mediapipeDest = path.join(TEMP_PORTABLE_DIR, "mediapipe");
if (fs.existsSync(mediapipeSource)) {
  copyDirRecursive(mediapipeSource, mediapipeDest);
}

// 4) 라이선스 및 README 복사
fs.copyFileSync(path.join(rootDir, "src-tauri", "resources", "LICENSES.txt"), path.join(TEMP_PORTABLE_DIR, "LICENSES.txt"));
fs.copyFileSync(path.join(rootDir, "src-tauri", "resources", "GPLv3.txt"), path.join(TEMP_PORTABLE_DIR, "GPLv3.txt"));
fs.copyFileSync(targetReadme, path.join(TEMP_PORTABLE_DIR, "README.txt"));

// 5) 포터블 마커 및 data 빈 폴더 생성
fs.writeFileSync(path.join(TEMP_PORTABLE_DIR, "portable.txt"), "PrismView Portable Mode Marker\nThis file tells PrismView to use the local 'data' folder.\n", "utf-8");
fs.mkdirSync(path.join(TEMP_PORTABLE_DIR, "data"), { recursive: true });

// 6) ZIP 압축 (Windows 10/11 내장 tar bsdtar 사용)
const targetPortableZip = path.join(RELEASE_DIR, `PrismView_${VERSION}_portable.zip`);
if (fs.existsSync(targetPortableZip)) {
  fs.unlinkSync(targetPortableZip);
}

console.log("포터블 ZIP 압축 중 (tar)...");
execSync(`tar -a -c -f "${targetPortableZip}" -C "${TEMP_PORTABLE_DIR}" .`, { stdio: "inherit" });

// 임시 폴더 정리
try {
  fs.rmSync(TEMP_PORTABLE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  // 정리 지연 시 무시
}
console.log(`✔ 포터블 ZIP 생성 완료: ${path.basename(targetPortableZip)}`);

// 6. SHA256 해시 생성
console.log("\n[5/5] SHA256 해시 파일 생성...");
const filesToHash = [
  path.basename(targetSetupExe),
  path.basename(targetPortableZip),
  path.basename(targetReadme),
];

let checksumContent = `================================================================================
PrismView v${VERSION} SHA256 체크섬 (Checksums)
================================================================================
받으신 파일의 무결성(변조 여부)을 확인하실 때 사용하십시오.
PowerShell 명령어: Get-FileHash -Algorithm SHA256 <파일명>

`;

for (const fileName of filesToHash) {
  const filePath = path.join(RELEASE_DIR, fileName);
  if (fs.existsSync(filePath)) {
    const hash = calculateSha256(filePath);
    checksumContent += `${hash}  ${fileName}\n`;
  }
}

const targetSha256File = path.join(RELEASE_DIR, "SHA256SUMS.txt");
fs.writeFileSync(targetSha256File, checksumContent, "utf-8");

// 7. 최종 결과 및 용량 안내
console.log("\n==================================================================");
console.log(`  🎉 PrismView v${VERSION} 릴리즈 패키지 생성 완료!`);
console.log(`  폴더 위치: ${RELEASE_DIR}`);
console.log("==================================================================");

const finalFiles = fs.readdirSync(RELEASE_DIR);
for (const f of finalFiles) {
  const fPath = path.join(RELEASE_DIR, f);
  const stats = fs.statSync(fPath);
  console.log(` - ${f.padEnd(35)} : ${formatBytes(stats.size)}`);
}

console.log("\n[설치 파일 용량 안내]");
console.log("- 딥러닝 기반 얼굴 인식 모델(BlazeFace) 및 오프라인 WASM 탑재");
console.log("- AutoCAD DWG 도면 변환을 위한 독립 실행기(GNU LibreDWG) 내장");
console.log("- 외부 인터넷 다운로드 없는 100% 완전 오프라인 배포본입니다.");
console.log("==================================================================\n");
