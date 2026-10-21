/**
 * 오프라인 얼굴 검출 모듈 (100% PC 내부 로컬 모델 동작, 외부 네트워크 요청 절대 없음)
 * 
 * 1. MediaPipe Tasks Vision Face Detector (BlazeFace 초경량 모델, Apache 2.0 라이선스)
 *    - public/mediapipe/wasm 및 public/mediapipe/models/blaze_face_short_range.tflite 로컬 파일 구동
 *    - 외부 CDN 주소 절대 사용 안 함
 * 2. 최후 수단 폴백 (모델 로딩 실패 시에만 사용):
 *    - Chromium 내장 Shape Detection API 및 오프라인 Canvas 피부색/구조 분석 알고리즘
 *    - 폴백 사용 시 "자동 인식 정확도가 낮습니다. 직접 확인하세요" 안내 플래그(isFallback) 제공
 */

import { FilesetResolver, FaceDetector as MpFaceDetector } from "@mediapipe/tasks-vision";
import type { DetectedFace } from "./idPhotoTypes";

export interface FaceDetectionResult {
  faces: DetectedFace[];
  isFallback: boolean; // 모델 로딩에 실패하여 최후 수단 폴백을 사용했는지 여부
}

let cachedDetector: MpFaceDetector | null = null;
let initPromise: Promise<MpFaceDetector | null> | null = null;

/**
 * 앱 내부 public 폴더의 로컬 WASM 및 로컬 TFLite 모델을 로드하여 FaceDetector 초기화
 * (외부 CDN / 원격 URL 절대 호출 없음)
 */
async function getMediaPipeFaceDetector(): Promise<MpFaceDetector | null> {
  if (cachedDetector) return cachedDetector;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // 로컬 앱 내부 경로 (Vite/Tauri 로컬 호스트 기준)
      const baseOrigin = window.location.origin;
      const wasmPath = `${baseOrigin}/mediapipe/wasm`;
      const modelPath = `${baseOrigin}/mediapipe/models/blaze_face_short_range.tflite`;

      const vision = await FilesetResolver.forVisionTasks(wasmPath);
      const detector = await MpFaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: "CPU", // Windows WebView2 환경에서 100% 신뢰성 보장
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.45,
      });

      cachedDetector = detector;
      return detector;
    } catch (err) {
      console.warn("MediaPipe FaceDetector 로컬 모델 초기화 실패, 최후 수단 폴백 모드로 전환:", err);
      return null;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * 단일 얼굴 검출 (공무원증/증명사진 자동 맞춤용)
 */
export async function detectFaceOffline(
  imageElement: HTMLImageElement
): Promise<{ face: DetectedFace | null; isFallback: boolean }> {
  const result = await detectAllFacesDetailed(imageElement);
  if (result.faces.length === 0) {
    return { face: null, isFallback: result.isFallback };
  }

  // 가장 면적이 크고 신뢰도 높은 얼굴 1개 선정
  let best = result.faces[0];
  let maxArea = best.width * best.height;
  for (let i = 1; i < result.faces.length; i++) {
    const area = result.faces[i].width * result.faces[i].height;
    if (area > maxArea) {
      maxArea = area;
      best = result.faces[i];
    }
  }

  return { face: best, isFallback: result.isFallback };
}

/**
 * 사진 속 모든 얼굴 검출 (결과 및 폴백 여부 메타데이터 포함)
 */
export async function detectAllFacesDetailed(
  imageElement: HTMLImageElement
): Promise<FaceDetectionResult> {
  // 1. 1순위: MediaPipe BlazeFace 정식 로컬 딥러닝 모델
  try {
    const detector = await getMediaPipeFaceDetector();
    if (detector) {
      const detectionsResult = detector.detect(imageElement);
      if (detectionsResult && detectionsResult.detections) {
        const faces: DetectedFace[] = detectionsResult.detections.map((d) => {
          const bb = d.boundingBox;
          const conf = d.categories && d.categories.length > 0 ? d.categories[0].score : 0.95;
          return {
            x: bb ? Math.max(0, bb.originX) : 0,
            y: bb ? Math.max(0, bb.originY) : 0,
            width: bb ? Math.max(10, bb.width) : 10,
            height: bb ? Math.max(10, bb.height) : 10,
            confidence: conf,
          };
        });

        return { faces, isFallback: false };
      }
    }
  } catch (err) {
    console.warn("MediaPipe 모델 추론 중 오류 발생, 최후 수단 폴백 실행:", err);
  }

  // 2. 2순위 최후 수단: Chromium 내장 Shape Detection API
  if (typeof (window as unknown as { FaceDetector?: unknown }).FaceDetector === "function") {
    try {
      const FaceDetectorClass = (window as unknown as { FaceDetector: new () => { detect: (el: HTMLImageElement) => Promise<Array<{ boundingBox: DOMRectReadOnly }>> } }).FaceDetector;
      const detector = new FaceDetectorClass();
      const faces = await detector.detect(imageElement);
      if (faces && faces.length > 0) {
        return {
          faces: faces.map((f) => ({
            x: f.boundingBox.x,
            y: f.boundingBox.y,
            width: f.boundingBox.width,
            height: f.boundingBox.height,
            confidence: 0.85,
          })),
          isFallback: true,
        };
      }
    } catch {
      // 내장 API 실패 시 캔버스 피부색 분석으로 최종 폴백
    }
  }

  // 3. 3순위 최후 수단: 순수 Canvas 피부색/구조 명암 분석 폴백
  const canvasFaces = detectAllFacesFromCanvas(imageElement);
  return { faces: canvasFaces, isFallback: true };
}

/**
 * 하위 호환용 전체 얼굴 검출 함수
 */
export async function detectAllFacesOffline(
  imageElement: HTMLImageElement
): Promise<DetectedFace[]> {
  const result = await detectAllFacesDetailed(imageElement);
  return result.faces;
}

/**
 * 로컬 캔버스 기반 최후 수단 피부색 대조 폴백 알고리즘
 */
function detectAllFacesFromCanvas(img: HTMLImageElement): DetectedFace[] {
  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;
  if (!origW || !origH) return [];

  const scale = Math.min(1.0, 320 / origW);
  const sw = Math.round(origW * scale);
  const sh = Math.round(origH * scale);

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  ctx.drawImage(img, 0, 0, sw, sh);
  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, sw, sh);
  } catch {
    return [];
  }

  const data = imageData.data;
  const skinMask = new Uint8Array(sw * sh);
  let skinCount = 0;

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const idx = (y * sw + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      const yVal = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

      if (yVal > 40 && cr >= 132 && cr <= 175 && cb >= 75 && cb <= 130 && r > g && g > b) {
        skinMask[y * sw + x] = 1;
        skinCount++;
      }
    }
  }

  if (skinCount < (sw * sh) * 0.01) {
    return [
      {
        x: (origW - origW * 0.4) / 2,
        y: origH * 0.15,
        width: origW * 0.4,
        height: origH * 0.5,
        confidence: 0.5,
      },
    ];
  }

  const integral = new Int32Array((sw + 1) * (sh + 1));
  for (let y = 0; y < sh; y++) {
    let rowSum = 0;
    for (let x = 0; x < sw; x++) {
      rowSum += skinMask[y * sw + x];
      integral[(y + 1) * (sw + 1) + (x + 1)] = integral[y * (sw + 1) + (x + 1)] + rowSum;
    }
  }

  const getAreaSum = (x0: number, y0: number, x1: number, y1: number) => {
    return (
      integral[y1 * (sw + 1) + x1] -
      integral[y0 * (sw + 1) + x1] -
      integral[y1 * (sw + 1) + x0] +
      integral[y0 * (sw + 1) + x0]
    );
  };

  interface ScoredBox {
    x: number;
    y: number;
    w: number;
    h: number;
    score: number;
  }
  const candidates: ScoredBox[] = [];

  const minBoxW = Math.round(sw * 0.12);
  const maxBoxW = Math.round(sw * 0.65);
  const step = Math.max(4, Math.round(sw * 0.04));

  for (let boxW = minBoxW; boxW <= maxBoxW; boxW += step) {
    const boxH = Math.round(boxW * 1.25);
    if (boxH > sh) break;

    const yStart = Math.round(sh * 0.04);
    const yEnd = Math.min(sh - boxH, Math.round(sh * 0.8));

    for (let y = yStart; y <= yEnd; y += step) {
      for (let x = 0; x <= sw - boxW; x += step) {
        const area = boxW * boxH;
        const skinInBox = getAreaSum(x, y, x + boxW, y + boxH);
        const skinRatio = skinInBox / area;

        if (skinRatio >= 0.28 && skinRatio <= 0.88) {
          const upperH = Math.round(boxH * 0.45);
          const lowerH = boxH - upperH;
          const upperSkin = getAreaSum(x, y, x + boxW, y + upperH) / (boxW * upperH);
          const lowerSkin = getAreaSum(x, y + upperH, x + boxW, y + boxH) / (boxW * lowerH);

          if (upperSkin >= 0.22 && lowerSkin >= 0.22) {
            const score = skinRatio * (1.0 - Math.abs(upperSkin - lowerSkin) * 0.5);
            candidates.push({ x, y, w: boxW, h: boxH, score });
          }
        }
      }
    }
  }

  if (candidates.length === 0) {
    return [
      {
        x: (origW - origW * 0.4) / 2,
        y: origH * 0.15,
        width: origW * 0.4,
        height: origH * 0.5,
        confidence: 0.5,
      },
    ];
  }

  candidates.sort((a, b) => b.score - a.score);

  const selected: ScoredBox[] = [];
  for (const cand of candidates) {
    let overlap = false;
    for (const sel of selected) {
      const ix0 = Math.max(cand.x, sel.x);
      const iy0 = Math.max(cand.y, sel.y);
      const ix1 = Math.min(cand.x + cand.w, sel.x + sel.w);
      const iy1 = Math.min(cand.y + cand.h, sel.y + sel.h);

      if (ix1 > ix0 && iy1 > iy0) {
        const interArea = (ix1 - ix0) * (iy1 - iy0);
        const minArea = Math.min(cand.w * cand.h, sel.w * sel.h);
        if (interArea / minArea > 0.35) {
          overlap = true;
          break;
        }
      }
    }
    if (!overlap) {
      selected.push(cand);
      if (selected.length >= 8) break;
    }
  }

  const invScale = 1.0 / scale;
  return selected.map((s) => ({
    x: Math.round(s.x * invScale),
    y: Math.round(s.y * invScale),
    width: Math.round(s.w * invScale),
    height: Math.round(s.h * invScale),
    confidence: Math.min(0.85, Math.max(0.4, s.score)),
  }));
}
