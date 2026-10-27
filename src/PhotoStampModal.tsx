import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  X,
  Stamp,
  Calendar,
  Type,
  ArrowUpRight,
  Square,
  Circle,
  Download,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import "./PhotoStampModal.css";

interface ShapeAnnotation {
  id: string;
  type: "arrow" | "rect" | "circle";
  startX: number; // 0.0 ~ 1.0 (이미지 비율 좌표)
  startY: number;
  endX: number;
  endY: number;
  color: string;
  lineWidth: number;
}

interface PhotoStampModalProps {
  targetPaths: string[];
  onClose: () => void;
  showToast: (msg: string) => void;
  onRefreshExplorer?: () => void;
}

type CornerPos = "br" | "bl" | "tr" | "tl";

export function PhotoStampModal({
  targetPaths,
  onClose,
  showToast,
  onRefreshExplorer,
}: PhotoStampModalProps) {
  // 현재 미리보기 중인 사진 인덱스
  const [currentIdx, setCurrentIdx] = useState<number>(0);
  const currentPath = targetPaths[currentIdx] || targetPaths[0];

  // 1. 날짜 스탬프 설정
  const [enableDate, setEnableDate] = useState<boolean>(true);
  const [dateMap, setDateMap] = useState<Record<string, string>>({});
  const [customDate, setCustomDate] = useState<string>("");
  const [dateCorner, setDateCorner] = useState<CornerPos>("br"); // 공사 사진 기본 우측 하단
  const [dateFontSize, setDateFontSize] = useState<number>(36);
  const [dateColor, setDateColor] = useState<string>("#ffeb3b"); // 노란색 기본 (공사현장 표준)
  const [dateBgStrip, setDateBgStrip] = useState<"semi-black" | "semi-white" | "none">("semi-black");

  // 2. 추가 글자 (텍스트 상자)
  const [enableText, setEnableText] = useState<boolean>(false);
  const [extraText, setExtraText] = useState<string>("");
  const [textFont, setTextFont] = useState<string>("Malgun Gothic");
  const [textCorner, setTextCorner] = useState<CornerPos>("tl");
  const [textFontSize, setTextFontSize] = useState<number>(36);
  const [textColor, setTextColor] = useState<string>("#ffffff");
  const [textBgStrip, setTextBgStrip] = useState<"semi-black" | "semi-white" | "none">("semi-black");

  // 3. 도형 어노테이션 (화살표, 사각형, 원)
  const [activeTool, setActiveTool] = useState<"select" | "arrow" | "rect" | "circle">("select");
  const [shapes, setShapes] = useState<ShapeAnnotation[]>([]);
  const [shapeColor, setShapeColor] = useState<string>("#ff2222"); // 빨간색 기본
  const [shapeLineWidth, setShapeLineWidth] = useState<number>(6);

  // 4. 일괄 적용 옵션
  const [applyToAll, setApplyToAll] = useState<boolean>(targetPaths.length > 1);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressText, setProgressText] = useState<string>("");

  // 캔버스 레퍼런스
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentImgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState<boolean>(false);
  const [natSize, setNatSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // 도형 그리기 인터랙션
  const [isDrawing, setIsDrawing] = useState<boolean>(false);

  // EXIF 촬영 날짜 로드
  useEffect(() => {
    let active = true;
    const fetchDates = async () => {
      try {
        const dates = await invoke<Record<string, string | null>>("get_batch_file_dates", {
          paths: targetPaths,
        });
        if (!active) return;
        const mapped: Record<string, string> = {};
        const today = new Date();
        const todayStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, "0")}.${String(today.getDate()).padStart(2, "0")}`;

        for (const p of targetPaths) {
          const raw = dates[p];
          if (raw) {
            // "2026:10:21 14:22:10" -> "2026.10.21"
            const datePart = raw.split(" ")[0].replace(/:/g, ".");
            mapped[p] = datePart;
          } else {
            mapped[p] = todayStr;
          }
        }
        setDateMap(mapped);
      } catch {
        // 폴백 오늘 날짜
        const today = new Date();
        const todayStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, "0")}.${String(today.getDate()).padStart(2, "0")}`;
        const fallback: Record<string, string> = {};
        for (const p of targetPaths) fallback[p] = todayStr;
        if (active) setDateMap(fallback);
      }
    };
    void fetchDates();
    return () => {
      active = false;
    };
  }, [targetPaths]);

  // 현재 사진 로드
  useEffect(() => {
    setImgLoaded(false);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = convertFileSrc(currentPath);
    img.onload = () => {
      currentImgRef.current = img;
      setNatSize({ w: img.naturalWidth, h: img.naturalHeight });
      setImgLoaded(true);
    };
    img.onerror = () => {
      showToast("이미지를 불러오지 못했습니다.");
    };
  }, [currentPath, showToast]);

  // 날짜/글자/도형을 캔버스에 렌더링하는 순수 함수
  const drawStampToContext = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      img: HTMLImageElement,
      w: number,
      h: number,
      dateString: string
    ) => {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      // 모서리 좌표 계산 헬퍼
      const getCornerCoords = (
        corner: CornerPos,
        boxW: number,
        boxH: number,
        margin: number
      ) => {
        switch (corner) {
          case "tl":
            return { x: margin, y: margin };
          case "tr":
            return { x: w - boxW - margin, y: margin };
          case "bl":
            return { x: margin, y: h - boxH - margin };
          case "br":
          default:
            return { x: w - boxW - margin, y: h - boxH - margin };
        }
      };

      // 1. 날짜 스탬프 그리기
      if (enableDate && dateString.trim().length > 0) {
        ctx.save();
        const scale = Math.max(1, w / 1600);
        const actualFontSize = Math.round(dateFontSize * scale);
        ctx.font = `bold ${actualFontSize}px "Malgun Gothic", "Noto Sans KR", Arial, sans-serif`;
        const textMetrics = ctx.measureText(dateString);
        const textW = textMetrics.width;
        const padX = actualFontSize * 0.4;
        const padY = actualFontSize * 0.25;
        const boxW = textW + padX * 2;
        const boxH = actualFontSize + padY * 2;
        const margin = Math.round(28 * scale);

        const { x, y } = getCornerCoords(dateCorner, boxW, boxH, margin);

        // 배경 띠
        if (dateBgStrip === "semi-black") {
          ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
          ctx.fillRect(x, y, boxW, boxH);
        } else if (dateBgStrip === "semi-white") {
          ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
          ctx.fillRect(x, y, boxW, boxH);
        }

        // 텍스트
        ctx.fillStyle = dateColor;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        // 살짝의 그림자 효과로 가독성 극대화
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = 4;
        ctx.fillText(dateString, x + padX, y + boxH / 2);
        ctx.restore();
      }

      // 2. 추가 텍스트 상자 그리기
      if (enableText && extraText.trim().length > 0) {
        ctx.save();
        const scale = Math.max(1, w / 1600);
        const actualFontSize = Math.round(textFontSize * scale);
        ctx.font = `bold ${actualFontSize}px "${textFont}", "Malgun Gothic", sans-serif`;
        const textMetrics = ctx.measureText(extraText);
        const textW = textMetrics.width;
        const padX = actualFontSize * 0.4;
        const padY = actualFontSize * 0.25;
        const boxW = textW + padX * 2;
        const boxH = actualFontSize + padY * 2;
        const margin = Math.round(28 * scale);

        const { x, y } = getCornerCoords(textCorner, boxW, boxH, margin);

        if (textBgStrip === "semi-black") {
          ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
          ctx.fillRect(x, y, boxW, boxH);
        } else if (textBgStrip === "semi-white") {
          ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
          ctx.fillRect(x, y, boxW, boxH);
        }

        ctx.fillStyle = textColor;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = 4;
        ctx.fillText(extraText, x + padX, y + boxH / 2);
        ctx.restore();
      }

      // 3. 도형 어노테이션 (화살표, 사각형, 원) 그리기
      for (const sh of shapes) {
        ctx.save();
        const scale = Math.max(1, w / 1600);
        ctx.strokeStyle = sh.color;
        ctx.lineWidth = Math.round(sh.lineWidth * scale);
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 4;

        const x1 = sh.startX * w;
        const y1 = sh.startY * h;
        const x2 = sh.endX * w;
        const y2 = sh.endY * h;

        if (sh.type === "rect") {
          ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        } else if (sh.type === "circle") {
          const cx = (x1 + x2) / 2;
          const cy = (y1 + y2) / 2;
          const rx = Math.abs(x2 - x1) / 2;
          const ry = Math.abs(y2 - y1) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, Math.max(2, rx), Math.max(2, ry), 0, 0, Math.PI * 2);
          ctx.stroke();
        } else if (sh.type === "arrow") {
          // 화살표 그리기 (선 + 촉)
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // 화살표 촉
          const headLen = Math.max(16, Math.round(24 * scale));
          const angle = Math.atan2(y2 - y1, x2 - x1);
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(
            x2 - headLen * Math.cos(angle - Math.PI / 6),
            y2 - headLen * Math.sin(angle - Math.PI / 6)
          );
          ctx.lineTo(
            x2 - headLen * Math.cos(angle + Math.PI / 6),
            y2 - headLen * Math.sin(angle + Math.PI / 6)
          );
          ctx.closePath();
          ctx.fillStyle = sh.color;
          ctx.fill();
        }
        ctx.restore();
      }
    },
    [
      enableDate,
      dateCorner,
      dateFontSize,
      dateColor,
      dateBgStrip,
      enableText,
      extraText,
      textFont,
      textCorner,
      textFontSize,
      textColor,
      textBgStrip,
      shapes,
    ]
  );

  // 캔버스 실시간 미리보기 갱신
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = currentImgRef.current;
    if (!canvas || !img || !imgLoaded) return;

    const { w, h } = natSize;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const displayDate = customDate.trim() || dateMap[currentPath] || "2026.10.21";
    drawStampToContext(ctx, img, w, h, displayDate);
  }, [drawStampToContext, imgLoaded, natSize, customDate, dateMap, currentPath]);

  // 마우스로 도형 그리기
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === "select" || !imgLoaded) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const startX = (e.clientX - rect.left) / rect.width;
    const startY = (e.clientY - rect.top) / rect.height;

    setIsDrawing(true);

    const newShape: ShapeAnnotation = {
      id: `shape_${Date.now()}`,
      type: activeTool,
      startX,
      startY,
      endX: startX,
      endY: startY,
      color: shapeColor,
      lineWidth: shapeLineWidth,
    };
    setShapes((prev) => [...prev, newShape]);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const curX = (e.clientX - rect.left) / rect.width;
    const curY = (e.clientY - rect.top) / rect.height;

    setShapes((prev) =>
      prev.map((sh, idx) =>
        idx === prev.length - 1 ? { ...sh, endX: curX, endY: curY } : sh
      )
    );
  };

  const handleCanvasMouseUp = () => {
    setIsDrawing(false);
  };

  // 실행 및 저장: 단일 저장 또는 다중 일괄 저장
  const handleExecuteSave = async () => {
    setIsProcessing(true);
    const pathsToProcess = applyToAll ? targetPaths : [currentPath];

    try {
      let count = 0;
      for (const p of pathsToProcess) {
        count++;
        setProgressText(`사진 처리 중 (${count}/${pathsToProcess.length})...`);

        // 이미지 로드
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = convertFileSrc(p);

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("이미지 로드 실패"));
        });

        const offCanvas = document.createElement("canvas");
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        offCanvas.width = w;
        offCanvas.height = h;
        const offCtx = offCanvas.getContext("2d");
        if (!offCtx) continue;

        // 개별 사진의 고유 EXIF 날짜
        const finalDate = customDate.trim() || dateMap[p] || "2026.10.21";
        drawStampToContext(offCtx, img, w, h, finalDate);

        const dataUrl = offCanvas.toDataURL("image/jpeg", 0.95);

        // 결과 저장 경로: 원본 폴더 내 "PrismView_결과" 또는 "_stamped.jpg"
        const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        const parentDir = slash >= 0 ? p.substring(0, slash) : "";
        const filename = slash >= 0 ? p.substring(slash + 1) : p;
        const dot = filename.lastIndexOf(".");
        const stem = dot > 0 ? filename.substring(0, dot) : filename;

        const outDir = `${parentDir}\\PrismView_결과`;
        const targetPath = `${outDir}\\${stem}_stamped.jpg`;

        await invoke("save_edited_image", {
          base64Data: dataUrl,
          targetPath,
        });
      }

      showToast(
        applyToAll
          ? `${pathsToProcess.length}장의 사진에 날짜·글자 스탬프가 성공적으로 저장되었습니다.`
          : `날짜·글자 스탬프 사본이 저장되었습니다.`
      );

      if (onRefreshExplorer) onRefreshExplorer();
      onClose();
    } catch (e) {
      showToast(`저장 오류: ${e}`);
    } finally {
      setIsProcessing(false);
      setProgressText("");
    }
  };

  return (
    <div className="stamp-modal-overlay">
      <div className="stamp-modal-container">
        {/* 상단 헤더 */}
        <header className="stamp-modal-header">
          <div className="stamp-header-title">
            <Stamp size={20} className="header-icon" />
            <h2>날짜·글자 넣기 (공사 사진 대지 등)</h2>
            <span className="stamp-badge">
              {targetPaths.length > 1
                ? `총 ${targetPaths.length}장 중 ${currentIdx + 1}번째 미리보기`
                : "단독 편집"}
            </span>
          </div>

          {targetPaths.length > 1 && (
            <div className="photo-nav-box">
              <button
                type="button"
                className="nav-btn"
                disabled={currentIdx === 0}
                onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft size={16} /> 이전
              </button>
              <span className="nav-counter">
                {currentIdx + 1} / {targetPaths.length}
              </span>
              <button
                type="button"
                className="nav-btn"
                disabled={currentIdx === targetPaths.length - 1}
                onClick={() => setCurrentIdx((i) => Math.min(targetPaths.length - 1, i + 1))}
              >
                다음 <ChevronRight size={16} />
              </button>
            </div>
          )}

          <button
            type="button"
            className="stamp-close-btn"
            onClick={onClose}
            title="닫기 (Esc)"
          >
            <X size={20} />
          </button>
        </header>

        {/* 메인 편집 뷰 */}
        <div className="stamp-main-body">
          {/* 중앙 캔버스 뷰포트 */}
          <div className="stamp-canvas-viewport">
            <canvas
              ref={canvasRef}
              className="stamp-render-canvas"
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
            />
            {activeTool !== "select" && (
              <div className="tool-guide-badge">
                마우스로 드래그하여 {activeTool === "arrow" ? "화살표" : activeTool === "rect" ? "사각형" : "원"}을 그립니다.
              </div>
            )}
          </div>

          {/* 우측 설정 사이드바 */}
          <aside className="stamp-sidebar">
            {/* 1. 날짜 넣기 섹션 */}
            <div className="stamp-section">
              <div className="section-title-row">
                <label className="checkbox-title">
                  <input
                    type="checkbox"
                    checked={enableDate}
                    onChange={(e) => setEnableDate(e.target.checked)}
                  />
                  <Calendar size={15} /> 촬영 날짜 넣기
                </label>
              </div>

              {enableDate && (
                <div className="section-body">
                  <div className="field-row">
                    <span className="field-label">날짜 형식:</span>
                    <input
                      type="text"
                      placeholder="EXIF 자동 (예: 2026.10.21)"
                      value={customDate || dateMap[currentPath] || ""}
                      onChange={(e) => setCustomDate(e.target.value)}
                      className="stamp-input"
                    />
                  </div>

                  <div className="field-row">
                    <span className="field-label">표시 모서리:</span>
                    <div className="corner-buttons">
                      <button
                        type="button"
                        className={`corner-btn ${dateCorner === "tl" ? "active" : ""}`}
                        onClick={() => setDateCorner("tl")}
                      >
                        좌상
                      </button>
                      <button
                        type="button"
                        className={`corner-btn ${dateCorner === "tr" ? "active" : ""}`}
                        onClick={() => setDateCorner("tr")}
                      >
                        우상
                      </button>
                      <button
                        type="button"
                        className={`corner-btn ${dateCorner === "bl" ? "active" : ""}`}
                        onClick={() => setDateCorner("bl")}
                      >
                        좌하
                      </button>
                      <button
                        type="button"
                        className={`corner-btn ${dateCorner === "br" ? "active" : ""}`}
                        onClick={() => setDateCorner("br")}
                      >
                        우하(기본)
                      </button>
                    </div>
                  </div>

                  <div className="field-row">
                    <span className="field-label">글자 크기:</span>
                    <input
                      type="range"
                      min={20}
                      max={72}
                      step={2}
                      value={dateFontSize}
                      onChange={(e) => setDateFontSize(Number(e.target.value))}
                      className="range-input"
                    />
                    <span className="unit-label">{dateFontSize}px</span>
                  </div>

                  <div className="field-row">
                    <span className="field-label">글자 색상:</span>
                    <div className="color-palette">
                      {["#ffeb3b", "#ffffff", "#ff3b30", "#00e676"].map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`palette-chip ${dateColor === c ? "active" : ""}`}
                          style={{ backgroundColor: c }}
                          onClick={() => setDateColor(c)}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="field-row">
                    <span className="field-label">배경 띠:</span>
                    <select
                      value={dateBgStrip}
                      onChange={(e) => setDateBgStrip(e.target.value as any)}
                      className="stamp-select"
                    >
                      <option value="semi-black">반투명 검정 (권장)</option>
                      <option value="semi-white">반투명 흰색</option>
                      <option value="none">배경 없음</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* 2. 글자 넣기 (텍스트 상자) */}
            <div className="stamp-section">
              <div className="section-title-row">
                <label className="checkbox-title">
                  <input
                    type="checkbox"
                    checked={enableText}
                    onChange={(e) => setEnableText(e.target.checked)}
                  />
                  <Type size={15} /> 설명 글자 넣기
                </label>
              </div>

              {enableText && (
                <div className="section-body">
                  <div className="field-row">
                    <input
                      type="text"
                      placeholder="예: 옥상 방수 시공 전 하자 부위"
                      value={extraText}
                      onChange={(e) => setExtraText(e.target.value)}
                      className="stamp-input"
                    />
                  </div>

                  <div className="field-row">
                    <span className="field-label">글꼴:</span>
                    <select
                      value={textFont}
                      onChange={(e) => setTextFont(e.target.value)}
                      className="stamp-select"
                    >
                      <option value="Malgun Gothic">맑은 고딕</option>
                      <option value="NanumGothic">나눔고딕</option>
                      <option value="Gulim">굴림</option>
                      <option value="Arial">Arial</option>
                    </select>
                  </div>

                  <div className="field-row">
                    <span className="field-label">위치:</span>
                    <div className="corner-buttons">
                      <button
                        type="button"
                        className={`corner-btn ${textCorner === "tl" ? "active" : ""}`}
                        onClick={() => setTextCorner("tl")}
                      >
                        좌상
                      </button>
                      <button
                        type="button"
                        className={`corner-btn ${textCorner === "tr" ? "active" : ""}`}
                        onClick={() => setTextCorner("tr")}
                      >
                        우상
                      </button>
                      <button
                        type="button"
                        className={`corner-btn ${textCorner === "bl" ? "active" : ""}`}
                        onClick={() => setTextCorner("bl")}
                      >
                        좌하
                      </button>
                      <button
                        type="button"
                        className={`corner-btn ${textCorner === "br" ? "active" : ""}`}
                        onClick={() => setTextCorner("br")}
                      >
                        우하
                      </button>
                    </div>
                  </div>

                  <div className="field-row">
                    <span className="field-label">글자 크기:</span>
                    <input
                      type="range"
                      min={20}
                      max={72}
                      step={2}
                      value={textFontSize}
                      onChange={(e) => setTextFontSize(Number(e.target.value))}
                      className="range-input"
                    />
                    <span className="unit-label">{textFontSize}px</span>
                  </div>

                  <div className="field-row">
                    <span className="field-label">글자 색상:</span>
                    <div className="color-palette">
                      {["#ffffff", "#ffeb3b", "#ff3b30", "#00e676", "#000000"].map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`palette-chip ${textColor === c ? "active" : ""}`}
                          style={{ backgroundColor: c }}
                          onClick={() => setTextColor(c)}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="field-row">
                    <span className="field-label">배경 띠:</span>
                    <select
                      value={textBgStrip}
                      onChange={(e) => setTextBgStrip(e.target.value as any)}
                      className="stamp-select"
                    >
                      <option value="semi-black">반투명 검정</option>
                      <option value="semi-white">반투명 흰색</option>
                      <option value="none">배경 없음</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* 3. 화살표·도형 표시 */}
            <div className="stamp-section">
              <div className="section-title-row">
                <span className="section-title">하자·포인트 표시 도형</span>
                {shapes.length > 0 && (
                  <button
                    type="button"
                    className="clear-shapes-btn"
                    onClick={() => setShapes([])}
                  >
                    <Trash2 size={13} /> 전체 삭제
                  </button>
                )}
              </div>

              <div className="tool-selector-row">
                <button
                  type="button"
                  className={`tool-btn ${activeTool === "select" ? "active" : ""}`}
                  onClick={() => setActiveTool("select")}
                >
                  선택
                </button>
                <button
                  type="button"
                  className={`tool-btn ${activeTool === "arrow" ? "active" : ""}`}
                  onClick={() => setActiveTool("arrow")}
                >
                  <ArrowUpRight size={14} /> 화살표
                </button>
                <button
                  type="button"
                  className={`tool-btn ${activeTool === "rect" ? "active" : ""}`}
                  onClick={() => setActiveTool("rect")}
                >
                  <Square size={14} /> 사각형
                </button>
                <button
                  type="button"
                  className={`tool-btn ${activeTool === "circle" ? "active" : ""}`}
                  onClick={() => setActiveTool("circle")}
                >
                  <Circle size={14} /> 원
                </button>
              </div>

              <div className="field-row">
                <span className="field-label">선 색상:</span>
                <div className="color-palette">
                  {["#ff2222", "#2563eb", "#eab308", "#16a34a", "#ffffff"].map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`palette-chip ${shapeColor === c ? "active" : ""}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setShapeColor(c)}
                    />
                  ))}
                </div>
              </div>

              <div className="field-row">
                <span className="field-label">선 두께:</span>
                <input
                  type="range"
                  min={2}
                  max={12}
                  step={1}
                  value={shapeLineWidth}
                  onChange={(e) => setShapeLineWidth(Number(e.target.value))}
                  className="range-input"
                />
                <span className="unit-label">{shapeLineWidth}px</span>
              </div>
            </div>

            {/* 4. 일괄 적용 옵션 (2장 이상일 때) */}
            {targetPaths.length > 1 && (
              <div className="stamp-section batch-card">
                <label className="checkbox-title bold">
                  <input
                    type="checkbox"
                    checked={applyToAll}
                    onChange={(e) => setApplyToAll(e.target.checked)}
                  />
                  <span>선택한 모든 사진 ({targetPaths.length}장)에 일괄 적용</span>
                </label>
                <span className="batch-hint">
                  각 사진의 고유 EXIF 촬영 일자를 읽어 동일한 스타일·위치로 한 번에 찍어 저장합니다.
                </span>
              </div>
            )}

            {/* 하단 저장 액션 */}
            <div className="stamp-footer-actions">
              <button
                type="button"
                className="save-stamp-btn"
                onClick={handleExecuteSave}
                disabled={isProcessing}
              >
                <Download size={16} />
                {isProcessing
                  ? (progressText || "저장 중...")
                  : applyToAll
                  ? `${targetPaths.length}장 일괄 사본 저장`
                  : "현재 사진 사본 저장"}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
