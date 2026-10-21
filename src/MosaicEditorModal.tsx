import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  X,
  Trash2,
  Sparkles,
  Download,
  Eye,
  RotateCcw,
  Sliders,
  ShieldAlert,
} from "lucide-react";
import { detectAllFacesDetailed } from "./faceDetection";
import "./MosaicEditorModal.css";

export type MosaicType = "pixelate" | "blur" | "black";

export interface MosaicBox {
  id: string;
  x: number; // 원본 이미지 좌표계
  y: number;
  width: number;
  height: number;
  type: MosaicType;
  intensity: number; // 픽셀화 블록 크기 또는 블러 강도
}

interface MosaicEditorModalProps {
  imagePath: string;
  onClose: () => void;
  showToast: (msg: string) => void;
  onSaved?: (newPath: string) => void;
}

export function MosaicEditorModal({
  imagePath,
  onClose,
  showToast,
  onSaved,
}: MosaicEditorModalProps) {
  const [boxes, setBoxes] = useState<MosaicBox[]>([]);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [currentType, setCurrentType] = useState<MosaicType>("pixelate");
  const [currentIntensity, setCurrentIntensity] = useState<number>(24);
  const [stripExif, setStripExif] = useState<boolean>(true);
  const [isDetectingFaces, setIsDetectingFaces] = useState<boolean>(false);
  const [faceDetectionAlert, setFaceDetectionAlert] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // 캔버스 및 뷰포트 상태
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const originalImgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState<boolean>(false);
  const [origSize, setOrigSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // 드래그 신규 생성 및 이동/리사이즈 인터랙션
  const [dragMode, setDragMode] = useState<"none" | "create" | "move" | "resize">("none");
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [activeBoxInitial, setActiveBoxInitial] = useState<MosaicBox | null>(null);
  const [resizeHandle, setResizeHandle] = useState<string>("");

  // 1. 원본 이미지 로드
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = convertFileSrc(imagePath);
    img.onload = () => {
      originalImgRef.current = img;
      setOrigSize({ width: img.naturalWidth, height: img.naturalHeight });
      setImgLoaded(true);
    };
    img.onerror = () => {
      showToast("이미지를 불러오지 못했습니다.");
      onClose();
    };
  }, [imagePath, showToast, onClose]);

  // 2. 캔버스 렌더링: 원본 이미지에 모자이크/흐림/검은박스 완전 파괴 렌더링
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img = originalImgRef.current;
    if (!canvas || !img || !imgLoaded) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const { width: w, height: h } = origSize;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    // 원본 그리기
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    // 각 모자이크 박스 픽셀 파괴 적용
    for (const b of boxes) {
      const bx = Math.max(0, Math.min(w - 1, Math.round(b.x)));
      const by = Math.max(0, Math.min(h - 1, Math.round(b.y)));
      const bw = Math.max(2, Math.min(w - bx, Math.round(b.width)));
      const bh = Math.max(2, Math.min(h - by, Math.round(b.height)));

      if (b.type === "black") {
        // 검은 박스: 100% 완전 불투명 단색 덮어쓰기 (복원 절대 불가)
        ctx.fillStyle = "#000000";
        ctx.fillRect(bx, by, bw, bh);
      } else if (b.type === "pixelate") {
        // 모자이크: 영역 크기에 비례하여 블록 크기 결정 (고해상도 사진에서도 얼굴 복원 불가)
        const minDim = Math.min(bw, bh);
        const minBlock = Math.max(12, Math.round(minDim / 10));
        const blockSize = Math.max(minBlock, Math.round((b.intensity / 20) * minBlock));
        const subData = ctx.getImageData(bx, by, bw, bh);
        const data = subData.data;

        for (let py = 0; py < bh; py += blockSize) {
          for (let px = 0; px < bw; px += blockSize) {
            const blockW = Math.min(blockSize, bw - px);
            const blockH = Math.min(blockSize, bh - py);

            let rSum = 0, gSum = 0, bSum = 0, count = 0;
            for (let dy = 0; dy < blockH; dy++) {
              for (let dx = 0; dx < blockW; dx++) {
                const idx = ((py + dy) * bw + (px + dx)) * 4;
                rSum += data[idx];
                gSum += data[idx + 1];
                bSum += data[idx + 2];
                count++;
              }
            }

            const avgR = Math.round(rSum / count);
            const avgG = Math.round(gSum / count);
            const avgB = Math.round(bSum / count);

            ctx.fillStyle = `rgb(${avgR},${avgG},${avgB})`;
            ctx.fillRect(bx + px, by + py, blockW, blockH);
          }
        }
      } else if (b.type === "blur") {
        // 고강도 흐림: 영역 크기에 비례하여 강한 다운샘플링 + 2중 리샘플링으로 고주파 성분 완전 파괴 (복원 불가)
        const minDim = Math.min(bw, bh);
        const baseFactor = Math.max(10, Math.round(minDim / 12));
        const factor = Math.max(baseFactor, Math.round((b.intensity / 15) * baseFactor));
        const smallW = Math.max(2, Math.round(bw / factor));
        const smallH = Math.max(2, Math.round(bh / factor));

        const offCanvas = document.createElement("canvas");
        offCanvas.width = smallW;
        offCanvas.height = smallH;
        const offCtx = offCanvas.getContext("2d")!;
        offCtx.drawImage(canvas, bx, by, bw, bh, 0, 0, smallW, smallH);

        // 1차 리샘플링
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "medium";
        ctx.drawImage(offCanvas, 0, 0, smallW, smallH, bx, by, bw, bh);

        // 2차 추가 다운샘플링으로 잔여 윤곽선 제거
        const superSmallW = Math.max(1, Math.round(smallW / 2));
        const superSmallH = Math.max(1, Math.round(smallH / 2));
        offCanvas.width = superSmallW;
        offCanvas.height = superSmallH;
        offCtx.drawImage(canvas, bx, by, bw, bh, 0, 0, superSmallW, superSmallH);
        ctx.drawImage(offCanvas, 0, 0, superSmallW, superSmallH, bx, by, bw, bh);
      }
    }
  }, [boxes, origSize, imgLoaded]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // 화면 좌표 -> 원본 이미지 좌표 변환
  const screenToCanvasCoords = useCallback((screenX: number, screenY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = origSize.width / rect.width;
    const scaleY = origSize.height / rect.height;
    return {
      x: (screenX - rect.left) * scaleX,
      y: (screenY - rect.top) * scaleY,
    };
  }, [origSize]);

  // 마우스 다운: 박스 선택, 이동, 핸들 리사이즈, 또는 신규 박스 생성
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !imgLoaded) return;
    const pt = screenToCanvasCoords(e.clientX, e.clientY);

    // 1. 이미 선택된 박스의 리사이즈 핸들 클릭 확인
    const selected = boxes.find((b) => b.id === selectedBoxId);
    if (selected) {
      const handle = getHitResizeHandle(selected, pt.x, pt.y);
      if (handle) {
        setDragMode("resize");
        setResizeHandle(handle);
        setDragStart(pt);
        setActiveBoxInitial({ ...selected });
        return;
      }
    }

    // 2. 박스 내부 클릭 (선택 및 이동)
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      if (
        pt.x >= b.x &&
        pt.x <= b.x + b.width &&
        pt.y >= b.y &&
        pt.y <= b.y + b.height
      ) {
        setSelectedBoxId(b.id);
        setCurrentType(b.type);
        setCurrentIntensity(b.intensity);
        setDragMode("move");
        setDragStart(pt);
        setActiveBoxInitial({ ...b });
        return;
      }
    }

    // 3. 빈 공간 클릭: 신규 모자이크 박스 드래그 생성 시작
    const newId = `box_${Date.now()}`;
    const newBox: MosaicBox = {
      id: newId,
      x: pt.x,
      y: pt.y,
      width: 0,
      height: 0,
      type: currentType,
      intensity: currentIntensity,
    };
    setBoxes((prev) => [...prev, newBox]);
    setSelectedBoxId(newId);
    setDragMode("create");
    setDragStart(pt);
    setActiveBoxInitial(newBox);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragMode === "none" || !activeBoxInitial) return;
    const pt = screenToCanvasCoords(e.clientX, e.clientY);

    if (dragMode === "create") {
      const x = Math.min(dragStart.x, pt.x);
      const y = Math.min(dragStart.y, pt.y);
      const width = Math.abs(pt.x - dragStart.x);
      const height = Math.abs(pt.y - dragStart.y);

      setBoxes((prev) =>
        prev.map((b) =>
          b.id === activeBoxInitial.id ? { ...b, x, y, width, height } : b
        )
      );
    } else if (dragMode === "move") {
      const dx = pt.x - dragStart.x;
      const dy = pt.y - dragStart.y;
      const newX = Math.max(0, Math.min(origSize.width - activeBoxInitial.width, activeBoxInitial.x + dx));
      const newY = Math.max(0, Math.min(origSize.height - activeBoxInitial.height, activeBoxInitial.y + dy));

      setBoxes((prev) =>
        prev.map((b) =>
          b.id === activeBoxInitial.id ? { ...b, x: newX, y: newY } : b
        )
      );
    } else if (dragMode === "resize") {
      let { x, y, width, height } = activeBoxInitial;
      const dx = pt.x - dragStart.x;
      const dy = pt.y - dragStart.y;

      if (resizeHandle.includes("r")) width += dx;
      if (resizeHandle.includes("b")) height += dy;
      if (resizeHandle.includes("l")) {
        x += dx;
        width -= dx;
      }
      if (resizeHandle.includes("t")) {
        y += dy;
        height -= dy;
      }

      if (width >= 10 && height >= 10) {
        setBoxes((prev) =>
          prev.map((b) =>
            b.id === activeBoxInitial.id ? { ...b, x, y, width, height } : b
          )
        );
      }
    }
  };

  const handleMouseUp = () => {
    if (dragMode === "create" && activeBoxInitial) {
      // 너무 작은 드래그(오클릭 등)는 취소
      setBoxes((prev) =>
        prev.filter((b) => !(b.id === activeBoxInitial.id && (b.width < 10 || b.height < 10)))
      );
    }
    setDragMode("none");
    setActiveBoxInitial(null);
  };

  // 8방향 리사이즈 핸들 적중 검사
  const getHitResizeHandle = (b: MosaicBox, px: number, py: number): string | null => {
    const handleRadius = Math.max(8, origSize.width * 0.015);
    const inCircle = (hx: number, hy: number) =>
      Math.hypot(px - hx, py - hy) <= handleRadius;

    if (inCircle(b.x + b.width, b.y + b.height)) return "rb";
    if (inCircle(b.x, b.y + b.height)) return "lb";
    if (inCircle(b.x + b.width, b.y)) return "rt";
    if (inCircle(b.x, b.y)) return "lt";
    if (inCircle(b.x + b.width / 2, b.y + b.height)) return "b";
    if (inCircle(b.x + b.width / 2, b.y)) return "t";
    if (inCircle(b.x + b.width, b.y + b.height / 2)) return "r";
    if (inCircle(b.x, b.y + b.height / 2)) return "l";
    return null;
  };

  // 선택된 박스 삭제
  const handleDeleteSelected = () => {
    if (!selectedBoxId) return;
    setBoxes((prev) => prev.filter((b) => b.id !== selectedBoxId));
    setSelectedBoxId(null);
  };

  // 키보드 단축키 (Delete 키로 삭제, Esc로 닫기)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Delete" || e.code === "Backspace") {
        if (selectedBoxId) {
          e.preventDefault();
          handleDeleteSelected();
        }
      } else if (e.code === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedBoxId, onClose]);

  // "얼굴 자동 찾기" 실행
  const handleAutoDetectFaces = async () => {
    const img = originalImgRef.current;
    if (!img) return;

    setIsDetectingFaces(true);
    setFaceDetectionAlert(null);
    try {
      const { faces, isFallback } = await detectAllFacesDetailed(img);
      if (faces.length === 0) {
        showToast("사진에서 얼굴을 찾지 못했습니다. 직접 드래그하여 영역을 지정하세요.");
        return;
      }

      // 감지된 얼굴을 12% 여유 마진을 주어 모자이크 박스로 등록
      const newBoxes: MosaicBox[] = faces.map((f, i) => {
        const padX = f.width * 0.12;
        const padY = f.height * 0.12;
        const x = Math.max(0, f.x - padX);
        const y = Math.max(0, f.y - padY);
        const width = Math.min(origSize.width - x, f.width + padX * 2);
        const height = Math.min(origSize.height - y, f.height + padY * 2);

        return {
          id: `face_${Date.now()}_${i}`,
          x,
          y,
          width,
          height,
          type: currentType,
          intensity: currentIntensity,
        };
      });

      setBoxes((prev) => [...prev, ...newBoxes]);
      setSelectedBoxId(newBoxes[0]?.id ?? null);

      const alertMsg = isFallback
        ? `자동 인식 정확도가 낮습니다. 직접 확인하세요. (얼굴 ${faces.length}개를 찾았습니다. 빠진 얼굴이 없는지 확인 후 저장하세요)`
        : `얼굴 ${faces.length}개를 찾았습니다. 빠진 얼굴이 없는지 확인 후 저장하세요.`;

      setFaceDetectionAlert(alertMsg);
      if (isFallback) {
        showToast("자동 인식 정확도가 낮습니다. 직접 확인하세요.");
      } else {
        showToast(`얼굴 ${faces.length}개를 찾았습니다.`);
      }
    } catch (e) {
      showToast(`얼굴 검출 오류: ${e}`);
    } finally {
      setIsDetectingFaces(false);
    }
  };

  // 모자이크 유형 변경
  const handleTypeChange = (type: MosaicType) => {
    setCurrentType(type);
    if (selectedBoxId) {
      setBoxes((prev) =>
        prev.map((b) => (b.id === selectedBoxId ? { ...b, type } : b))
      );
    }
  };

  // 강도 슬라이더 변경
  const handleIntensityChange = (val: number) => {
    setCurrentIntensity(val);
    if (selectedBoxId) {
      setBoxes((prev) =>
        prev.map((b) => (b.id === selectedBoxId ? { ...b, intensity: val } : b))
      );
    }
  };

  // 최종 저장: 항상 새 파일로 저장 (원본 보존 원칙)
  const handleSaveCopy = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (boxes.length === 0) {
      showToast("적용된 모자이크 영역이 없습니다. 영역을 드래그해 주세요.");
      return;
    }

    setIsSaving(true);
    try {
      // 캔버스에서 최고 품질의 JPEG Base64 추출 (캔버스 내보내기는 EXIF 메타데이터를 완전 파괴함)
      const dataUrl = canvas.toDataURL("image/jpeg", 0.96);

      // 출력 파일명: 원본명_mosaic.jpg
      const lastDot = imagePath.lastIndexOf(".");
      const basePath = lastDot > 0 ? imagePath.substring(0, lastDot) : imagePath;
      const targetPath = `${basePath}_mosaic.jpg`;

      const savedPath = await invoke<string>("save_edited_image", {
        base64Data: dataUrl,
        targetPath,
        stripExif,
      });

      showToast(`모자이크 사본이 저장되었습니다: ${savedPath}`);
      if (onSaved) onSaved(savedPath);
      onClose();
    } catch (e) {
      showToast(`저장 실패: ${e}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mosaic-modal-overlay">
      <div className="mosaic-modal-container">
        {/* 상단 헤더 */}
        <header className="mosaic-modal-header">
          <div className="mosaic-header-title">
            <Eye size={20} className="header-icon" />
            <h2>개인정보 가리기 (모자이크·흐림)</h2>
            <span className="mosaic-badge">원본 보존 · 새 파일 저장</span>
          </div>
          <button
            type="button"
            className="mosaic-close-btn"
            onClick={onClose}
            title="닫기 (Esc)"
          >
            <X size={20} />
          </button>
        </header>

        {/* 안내 배너 (자동 찾기 완료 시 확인 권고) */}
        {faceDetectionAlert && (
          <div className="mosaic-alert-banner">
            <ShieldAlert size={18} />
            <span>{faceDetectionAlert}</span>
            <button
              type="button"
              className="alert-dismiss"
              onClick={() => setFaceDetectionAlert(null)}
            >
              확인
            </button>
          </div>
        )}

        {/* 메인 편집 뷰 */}
        <div className="mosaic-main-body">
          {/* 중앙 이미지 캔버스 */}
          <div
            className="mosaic-canvas-viewport"
            ref={containerRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            <div className="mosaic-canvas-wrapper">
              <canvas ref={canvasRef} className="mosaic-render-canvas" />

              {/* 선택된 영역 표시 및 리사이즈 핸들 오버레이 */}
              {origSize.width > 0 &&
                boxes.map((b) => {
                  const isSelected = b.id === selectedBoxId;
                  const leftPct = (b.x / origSize.width) * 100;
                  const topPct = (b.y / origSize.height) * 100;
                  const widthPct = (b.width / origSize.width) * 100;
                  const heightPct = (b.height / origSize.height) * 100;

                  return (
                    <div
                      key={b.id}
                      className={`mosaic-box-overlay ${isSelected ? "selected" : ""}`}
                      style={{
                        left: `${leftPct}%`,
                        top: `${topPct}%`,
                        width: `${widthPct}%`,
                        height: `${heightPct}%`,
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        handleMouseDown(e);
                      }}
                    >
                      {isSelected && (
                        <>
                          <div className="resize-handle lt" />
                          <div className="resize-handle rt" />
                          <div className="resize-handle lb" />
                          <div className="resize-handle rb" />
                        </>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>

          {/* 우측 설정 사이드바 */}
          <aside className="mosaic-sidebar">
            <div className="mosaic-panel-section">
              <label className="section-label">가리기 방식</label>
              <div className="type-button-group">
                <button
                  type="button"
                  className={`type-btn ${currentType === "pixelate" ? "active" : ""}`}
                  onClick={() => handleTypeChange("pixelate")}
                >
                  모자이크
                </button>
                <button
                  type="button"
                  className={`type-btn ${currentType === "blur" ? "active" : ""}`}
                  onClick={() => handleTypeChange("blur")}
                >
                  흐림 (블러)
                </button>
                <button
                  type="button"
                  className={`type-btn ${currentType === "black" ? "active" : ""}`}
                  onClick={() => handleTypeChange("black")}
                >
                  검은 박스
                </button>
              </div>
            </div>

            {currentType !== "black" && (
              <div className="mosaic-panel-section">
                <div className="slider-label-row">
                  <label className="section-label">
                    <Sliders size={14} /> 강도 조절
                  </label>
                  <span className="slider-val">{currentIntensity}px</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={60}
                  step={2}
                  value={currentIntensity}
                  onChange={(e) => handleIntensityChange(Number(e.target.value))}
                  className="mosaic-range-slider"
                />
                <span className="slider-hint">
                  {currentType === "pixelate"
                    ? "블록 크기가 클수록 원래 형태를 알아볼 수 없습니다."
                    : "흐림 강도가 높을수록 원본 픽셀이 완전히 파괴됩니다."}
                </span>
              </div>
            )}

            <div className="mosaic-panel-section">
              <label className="section-label">스마트 도구</label>
              <button
                type="button"
                className="action-block-btn auto-face-btn"
                onClick={handleAutoDetectFaces}
                disabled={isDetectingFaces}
              >
                <Sparkles size={16} />
                {isDetectingFaces ? "얼굴 찾는 중..." : "얼굴 자동 찾기"}
              </button>
              <p className="tool-desc">
                PC 내부 인공지능으로 사진 속 얼굴들을 찾아 모자이크 후보로 표시합니다. (외부 전송 없음)
              </p>
            </div>

            <div className="mosaic-panel-section">
              <div className="section-header-row">
                <label className="section-label">영역 관리 ({boxes.length}개)</label>
                {selectedBoxId && (
                  <button
                    type="button"
                    className="delete-selected-btn"
                    onClick={handleDeleteSelected}
                    title="선택 영역 삭제 (Del)"
                  >
                    <Trash2 size={14} /> 선택 삭제
                  </button>
                )}
              </div>
              {boxes.length === 0 ? (
                <div className="empty-box-hint">
                  마우스로 가릴 얼굴이나 영역을 드래그하세요.
                </div>
              ) : (
                <div className="boxes-list">
                  {boxes.map((b, idx) => (
                    <div
                      key={b.id}
                      className={`box-list-item ${b.id === selectedBoxId ? "active" : ""}`}
                      onClick={() => setSelectedBoxId(b.id)}
                    >
                      <span>
                        영역 #{idx + 1} ({b.type === "pixelate" ? "모자이크" : b.type === "blur" ? "흐림" : "검은박스"})
                      </span>
                      <button
                        type="button"
                        className="item-delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setBoxes((prev) => prev.filter((item) => item.id !== b.id));
                          if (selectedBoxId === b.id) setSelectedBoxId(null);
                        }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mosaic-panel-section">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={stripExif}
                  onChange={(e) => setStripExif(e.target.checked)}
                />
                <span>EXIF 개인정보(촬영위치·기기) 완전 제거 (권장)</span>
              </label>
            </div>

            <div className="mosaic-footer-actions">
              <button
                type="button"
                className="reset-all-btn"
                onClick={() => {
                  setBoxes([]);
                  setSelectedBoxId(null);
                  setFaceDetectionAlert(null);
                }}
                disabled={boxes.length === 0}
              >
                <RotateCcw size={15} /> 전체 초기화
              </button>
              <button
                type="button"
                className="save-copy-btn"
                onClick={handleSaveCopy}
                disabled={isSaving || boxes.length === 0}
              >
                <Download size={16} />
                {isSaving ? "저장 중..." : "사본으로 저장"}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
