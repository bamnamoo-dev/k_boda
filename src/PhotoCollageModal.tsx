import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  X,
  LayoutGrid,
  Download,
  Move,
  ZoomIn,
  ZoomOut,
  Type,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import "./PhotoCollageModal.css";

interface CollageItem {
  id: string;
  path: string;
  name: string;
  caption: string;
  panX: number; // 픽셀 오프셋
  panY: number;
  zoom: number; // 1.0 ~ 3.0
  loadedImg?: HTMLImageElement;
}

interface PhotoCollageModalProps {
  targetPaths: string[];
  onClose: () => void;
  showToast: (msg: string) => void;
  onRefreshExplorer?: () => void;
}

type OutputPreset = "a4_landscape" | "a4_portrait" | "screen_fhd" | "custom";

export function PhotoCollageModal({
  targetPaths,
  onClose,
  showToast,
  onRefreshExplorer,
}: PhotoCollageModalProps) {
  // 1. 항목 상태 (순서 변경, 캡션, 줌, 팬)
  const [items, setItems] = useState<CollageItem[]>(() =>
    targetPaths.slice(0, 9).map((p, idx) => {
      const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
      const name = slash >= 0 ? p.substring(slash + 1) : p;
      const dot = name.lastIndexOf(".");
      const cleanName = dot > 0 ? name.substring(0, dot) : name;
      return {
        id: `item_${idx}_${Date.now()}`,
        path: p,
        name: cleanName,
        caption: "",
        panX: 0,
        panY: 0,
        zoom: 1.0,
      };
    })
  );

  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number>(0);
  const [mainTitle, setMainTitle] = useState<string>("");
  const [layoutGrid, setLayoutGrid] = useState<string>(() => {
    const len = targetPaths.length;
    if (len === 2) return "1x2";
    if (len === 3) return "1x3";
    if (len === 4) return "2x2";
    if (len <= 6) return "3x2";
    return "3x3";
  });

  // 레이아웃 스타일 설정
  const [outputPreset, setOutputPreset] = useState<OutputPreset>("a4_landscape");
  const [customWidth, setCustomWidth] = useState<number>(3508);
  const [customHeight, setCustomHeight] = useState<number>(2480);
  const [marginPx, setMarginPx] = useState<number>(36);
  const [gapPx, setGapPx] = useState<number>(18);
  const [bgColor, setBgColor] = useState<string>("#ffffff");
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // 캔버스 레퍼런스
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDraggingSlot, setIsDraggingSlot] = useState<boolean>(false);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // 2. 이미지 사전 로딩
  useEffect(() => {
    let active = true;
    items.forEach((item, idx) => {
      if (item.loadedImg) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = convertFileSrc(item.path);
      img.onload = () => {
        if (!active) return;
        setItems((prev) =>
          prev.map((it, i) => (i === idx ? { ...it, loadedImg: img } : it))
        );
      };
    });
    return () => {
      active = false;
    };
  }, [items]);

  // 그리드 열/행 계산
  const getGridDims = useCallback(() => {
    switch (layoutGrid) {
      case "1x2": return { cols: 2, rows: 1 };
      case "2x1": return { cols: 1, rows: 2 };
      case "1x3": return { cols: 3, rows: 1 };
      case "3x1": return { cols: 1, rows: 3 };
      case "2x2": return { cols: 2, rows: 2 };
      case "3x2": return { cols: 3, rows: 2 };
      case "2x3": return { cols: 2, rows: 3 };
      case "3x3": return { cols: 3, rows: 3 };
      default: return { cols: 2, rows: 2 };
    }
  }, [layoutGrid]);

  // 출력 해상도 계산
  const getCanvasDimensions = useCallback(() => {
    if (outputPreset === "a4_landscape") return { w: 3508, h: 2480 };
    if (outputPreset === "a4_portrait") return { w: 2480, h: 3508 };
    if (outputPreset === "screen_fhd") return { w: 1920, h: 1080 };
    return { w: Math.max(800, customWidth), h: Math.max(600, customHeight) };
  }, [outputPreset, customWidth, customHeight]);

  // 3. 캔버스 렌더링 (A4 해상도 또는 뷰포트용 실시간 렌더링)
  const drawCollage = useCallback(
    (targetCanvas: HTMLCanvasElement, targetW: number, targetH: number) => {
      const ctx = targetCanvas.getContext("2d");
      if (!ctx) return;

      targetCanvas.width = targetW;
      targetCanvas.height = targetH;

      // 배경 채우기
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, targetW, targetH);

      // 상단 타이틀 렌더링
      let titleOffsetTop = marginPx;
      if (mainTitle.trim().length > 0) {
        const titleFontSize = Math.round(targetH * 0.038);
        ctx.font = `bold ${titleFontSize}px "Malgun Gothic", "Noto Sans KR", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = bgColor === "#ffffff" ? "#111111" : "#ffffff";

        const titleY = marginPx + titleFontSize * 0.7;
        ctx.fillText(mainTitle.trim(), targetW / 2, titleY);

        titleOffsetTop = titleY + titleFontSize * 0.8;
      }

      // 배치 영역 계산
      const contentX = marginPx;
      const contentY = titleOffsetTop;
      const contentW = targetW - marginPx * 2;
      const contentH = targetH - titleOffsetTop - marginPx;

      const { cols, rows } = getGridDims();
      const slotW = (contentW - gapPx * (cols - 1)) / cols;
      const slotH = (contentH - gapPx * (rows - 1)) / rows;

      // 각 칸 렌더링
      items.forEach((item, idx) => {
        if (idx >= cols * rows) return;
        const col = idx % cols;
        const row = Math.floor(idx / cols);

        const slotX = contentX + col * (slotW + gapPx);
        const slotY = contentY + row * (slotH + gapPx);

        // 캡션 높이 확보 (캡션 텍스트가 있으면 아래 6% 할당)
        const hasCaption = item.caption.trim().length > 0;
        const captionH = hasCaption ? Math.round(slotH * 0.12) : 0;
        const imgSlotH = slotH - captionH;

        // 칸 배경 및 테두리
        ctx.save();
        ctx.beginPath();
        ctx.rect(slotX, slotY, slotW, imgSlotH);
        ctx.clip(); // 칸 영역으로 클리핑

        if (item.loadedImg) {
          const img = item.loadedImg;
          const iw = img.naturalWidth || img.width;
          const ih = img.naturalHeight || img.height;

          // cover 맞춤 비율 계산
          const scale = Math.max(slotW / iw, imgSlotH / ih) * item.zoom;
          const drawW = iw * scale;
          const drawH = ih * scale;

          const centerX = slotX + slotW / 2 + item.panX;
          const centerY = slotY + imgSlotH / 2 + item.panY;

          ctx.drawImage(img, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);
        } else {
          // 로딩 중 플레이스홀더
          ctx.fillStyle = "#e2e8f0";
          ctx.fillRect(slotX, slotY, slotW, imgSlotH);
        }
        ctx.restore();

        // 캡션 렌더링
        if (hasCaption) {
          const capY = slotY + imgSlotH;
          ctx.fillStyle = bgColor;
          ctx.fillRect(slotX, capY, slotW, captionH);

          const fontSize = Math.max(14, Math.round(slotH * 0.055));
          ctx.font = `500 ${fontSize}px "Malgun Gothic", "Noto Sans KR", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = bgColor === "#ffffff" ? "#222222" : "#f1f5f9";

          // 긴 텍스트 말줄임
          ctx.fillText(item.caption.trim(), slotX + slotW / 2, capY + captionH / 2, slotW - 12);
        }

        // 선택 슬롯 강조 테두리 (미리보기 화면용)
        if (targetCanvas === canvasRef.current && idx === selectedSlotIndex) {
          ctx.strokeStyle = "#3b82f6";
          ctx.lineWidth = 4;
          ctx.strokeRect(slotX, slotY, slotW, slotH);
        }
      });
    },
    [bgColor, mainTitle, marginPx, gapPx, getGridDims, items, selectedSlotIndex]
  );

  // 실시간 뷰포트 프리뷰 갱신
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = getCanvasDimensions();
    drawCollage(canvas, w, h);
  }, [drawCollage, getCanvasDimensions]);

  // 마우스 팬(Pan) 조작
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const clickX = (e.clientX - rect.left) * scaleX;
    const clickY = (e.clientY - rect.top) * scaleY;

    // 어느 슬롯을 클릭했는지 판별
    const { cols, rows } = getGridDims();
    const titleOffsetTop = mainTitle.trim().length > 0 ? marginPx + canvas.height * 0.038 * 1.5 : marginPx;
    const contentX = marginPx;
    const contentY = titleOffsetTop;
    const contentW = canvas.width - marginPx * 2;
    const contentH = canvas.height - titleOffsetTop - marginPx;

    const slotW = (contentW - gapPx * (cols - 1)) / cols;
    const slotH = (contentH - gapPx * (rows - 1)) / rows;

    for (let i = 0; i < items.length && i < cols * rows; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const sx = contentX + c * (slotW + gapPx);
      const sy = contentY + r * (slotH + gapPx);

      if (clickX >= sx && clickX <= sx + slotW && clickY >= sy && clickY <= sy + slotH) {
        setSelectedSlotIndex(i);
        setIsDraggingSlot(true);
        setDragStartPos({ x: e.clientX, y: e.clientY });
        return;
      }
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDraggingSlot) return;
    const dx = e.clientX - dragStartPos.x;
    const dy = e.clientY - dragStartPos.y;

    const canvas = canvasRef.current;
    const scale = canvas ? canvas.width / canvas.getBoundingClientRect().width : 1;

    setItems((prev) =>
      prev.map((it, idx) =>
        idx === selectedSlotIndex
          ? { ...it, panX: it.panX + dx * scale, panY: it.panY + dy * scale }
          : it
      )
    );
    setDragStartPos({ x: e.clientX, y: e.clientY });
  };

  const handleCanvasMouseUp = () => {
    setIsDraggingSlot(false);
  };

  // 마우스 휠 확대/축소
  const handleCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    setItems((prev) =>
      prev.map((it, idx) => {
        if (idx !== selectedSlotIndex) return it;
        const newZoom = Math.min(3.0, Math.max(1.0, it.zoom + delta));
        return { ...it, zoom: newZoom };
      })
    );
  };

  // 순서 변경 (위로 / 아래로)
  const moveItem = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= items.length) return;

    setItems((prev) => {
      const next = [...prev];
      const temp = next[index];
      next[index] = next[targetIndex];
      next[targetIndex] = temp;
      return next;
    });
    setSelectedSlotIndex(targetIndex);
  };

  // 최종 저장: A4 300DPI 고해상도 사본 저장
  const handleSaveCollage = async () => {
    setIsSaving(true);
    try {
      const { w, h } = getCanvasDimensions();
      const exportCanvas = document.createElement("canvas");
      drawCollage(exportCanvas, w, h);

      const dataUrl = exportCanvas.toDataURL("image/jpeg", 0.94);

      // 출력 파일명 결정
      const firstPath = items[0]?.path || "";
      const slash = Math.max(firstPath.lastIndexOf("/"), firstPath.lastIndexOf("\\"));
      const parentDir = slash >= 0 ? firstPath.substring(0, slash) : "";

      const cleanTitle = mainTitle.trim().replace(/[\\/:*?"<>|]/g, "_");
      const fileName = cleanTitle.length > 0 ? `${cleanTitle}_합치기.jpg` : `활동사진_합치기_${Date.now()}.jpg`;
      const targetPath = `${parentDir}\\${fileName}`;

      const savedPath = await invoke<string>("save_edited_image", {
        base64Data: dataUrl,
        targetPath,
      });

      showToast(`사진 합치기 결과가 저장되었습니다: ${savedPath}`);
      if (onRefreshExplorer) onRefreshExplorer();
      onClose();
    } catch (e) {
      showToast(`저장 실패: ${e}`);
    } finally {
      setIsSaving(false);
    }
  };

  const selectedItem = items[selectedSlotIndex];

  return (
    <div className="collage-modal-overlay">
      <div className="collage-modal-container">
        {/* 상단 헤더 */}
        <header className="collage-modal-header">
          <div className="collage-header-title">
            <LayoutGrid size={20} className="header-icon" />
            <h2>사진 합치기 (활동·증빙사진 생성)</h2>
            <span className="collage-badge">{items.length}장 선택됨</span>
          </div>
          <button
            type="button"
            className="collage-close-btn"
            onClick={onClose}
            title="닫기 (Esc)"
          >
            <X size={20} />
          </button>
        </header>

        {/* 메인 작업 영역 */}
        <div className="collage-main-body">
          {/* 중앙 프리뷰 뷰포트 */}
          <div className="collage-canvas-viewport">
            <div className="canvas-wrapper">
              <canvas
                ref={canvasRef}
                className="collage-render-canvas"
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onWheel={handleCanvasWheel}
              />
            </div>
            <div className="canvas-floating-hint">
              <Move size={13} /> 칸 클릭 후 드래그로 위치 조절 · 마우스 휠로 확대/축소
            </div>
          </div>

          {/* 우측 설정 사이드바 */}
          <aside className="collage-sidebar">
            {/* 1. 상단 제목 입력 */}
            <div className="collage-section">
              <label className="sidebar-label">
                <Type size={14} /> 상단 제목 한 줄 (선택)
              </label>
              <input
                type="text"
                placeholder="예: 2026학년도 현장체험학습 활동 사진"
                value={mainTitle}
                onChange={(e) => setMainTitle(e.target.value)}
                className="collage-input-text"
              />
            </div>

            {/* 2. 배치 틀 선택 */}
            <div className="collage-section">
              <label className="sidebar-label">배치 틀 선택</label>
              <div className="grid-preset-buttons">
                {items.length <= 2 && (
                  <>
                    <button
                      type="button"
                      className={`grid-opt-btn ${layoutGrid === "1x2" ? "active" : ""}`}
                      onClick={() => setLayoutGrid("1x2")}
                    >
                      가로 2장 (1x2)
                    </button>
                    <button
                      type="button"
                      className={`grid-opt-btn ${layoutGrid === "2x1" ? "active" : ""}`}
                      onClick={() => setLayoutGrid("2x1")}
                    >
                      세로 2장 (2x1)
                    </button>
                  </>
                )}
                {items.length === 3 && (
                  <>
                    <button
                      type="button"
                      className={`grid-opt-btn ${layoutGrid === "1x3" ? "active" : ""}`}
                      onClick={() => setLayoutGrid("1x3")}
                    >
                      가로 3장 (1x3)
                    </button>
                    <button
                      type="button"
                      className={`grid-opt-btn ${layoutGrid === "3x1" ? "active" : ""}`}
                      onClick={() => setLayoutGrid("3x1")}
                    >
                      세로 3장 (3x1)
                    </button>
                  </>
                )}
                {items.length >= 4 && (
                  <>
                    <button
                      type="button"
                      className={`grid-opt-btn ${layoutGrid === "2x2" ? "active" : ""}`}
                      onClick={() => setLayoutGrid("2x2")}
                    >
                      4장 (2x2)
                    </button>
                    <button
                      type="button"
                      className={`grid-opt-btn ${layoutGrid === "3x2" ? "active" : ""}`}
                      onClick={() => setLayoutGrid("3x2")}
                    >
                      6장 (3x2)
                    </button>
                    <button
                      type="button"
                      className={`grid-opt-btn ${layoutGrid === "2x3" ? "active" : ""}`}
                      onClick={() => setLayoutGrid("2x3")}
                    >
                      6장 (2x3)
                    </button>
                    <button
                      type="button"
                      className={`grid-opt-btn ${layoutGrid === "3x3" ? "active" : ""}`}
                      onClick={() => setLayoutGrid("3x3")}
                    >
                      9장 (3x3)
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 3. 결과 규격 및 여백 */}
            <div className="collage-section">
              <label className="sidebar-label">출력 크기</label>
              <div className="size-select-group">
                <button
                  type="button"
                  className={`size-btn ${outputPreset === "a4_landscape" ? "active" : ""}`}
                  onClick={() => setOutputPreset("a4_landscape")}
                >
                  A4 가로
                </button>
                <button
                  type="button"
                  className={`size-btn ${outputPreset === "a4_portrait" ? "active" : ""}`}
                  onClick={() => setOutputPreset("a4_portrait")}
                >
                  A4 세로
                </button>
                <button
                  type="button"
                  className={`size-btn ${outputPreset === "custom" ? "active" : ""}`}
                  onClick={() => setOutputPreset("custom")}
                >
                  직접 입력
                </button>
              </div>
              {outputPreset === "custom" && (
                <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "4px" }}>
                  <input
                    type="number"
                    value={customWidth}
                    onChange={(e) => setCustomWidth(Math.max(400, Number(e.target.value)))}
                    className="collage-input-text"
                    style={{ flex: 1, textAlign: "center" }}
                    placeholder="가로 px"
                  />
                  <span style={{ color: "#888" }}>×</span>
                  <input
                    type="number"
                    value={customHeight}
                    onChange={(e) => setCustomHeight(Math.max(400, Number(e.target.value)))}
                    className="collage-input-text"
                    style={{ flex: 1, textAlign: "center" }}
                    placeholder="세로 px"
                  />
                </div>
              )}
              <div className="style-controls-row">
                <div className="control-item">
                  <span>바깥 여백</span>
                  <input
                    type="range"
                    min={0}
                    max={80}
                    step={4}
                    value={marginPx}
                    onChange={(e) => setMarginPx(Number(e.target.value))}
                  />
                  <span>{marginPx}px</span>
                </div>
                <div className="control-item">
                  <span>사진 간격</span>
                  <input
                    type="range"
                    min={0}
                    max={40}
                    step={2}
                    value={gapPx}
                    onChange={(e) => setGapPx(Number(e.target.value))}
                  />
                  <span>{gapPx}px</span>
                </div>
                <div className="control-item color-item">
                  <span>배경색</span>
                  <div className="color-picker-box">
                    <input
                      type="color"
                      value={bgColor}
                      onChange={(e) => setBgColor(e.target.value)}
                    />
                    <span>{bgColor}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 4. 선택된 사진 설명 및 조절 */}
            {selectedItem && (
              <div className="collage-section slot-edit-section">
                <div className="slot-header">
                  <label className="sidebar-label">
                    선택된 사진 #{selectedSlotIndex + 1}
                  </label>
                  <span className="slot-name-badge">{selectedItem.name}</span>
                </div>

                <div className="slot-caption-box">
                  <span>사진 설명 글자 (캡션):</span>
                  <input
                    type="text"
                    placeholder="예: 체험학습 출발, 기념 단체사진"
                    value={selectedItem.caption}
                    onChange={(e) => {
                      const val = e.target.value;
                      setItems((prev) =>
                        prev.map((it, i) =>
                          i === selectedSlotIndex ? { ...it, caption: val } : it
                        )
                      );
                    }}
                    className="collage-input-text"
                  />
                </div>

                <div className="slot-zoom-row">
                  <span>확대:</span>
                  <button
                    type="button"
                    className="zoom-btn"
                    onClick={() =>
                      setItems((prev) =>
                        prev.map((it, i) =>
                          i === selectedSlotIndex
                            ? { ...it, zoom: Math.max(1.0, it.zoom - 0.2) }
                            : it
                        )
                      )
                    }
                  >
                    <ZoomOut size={14} />
                  </button>
                  <span className="zoom-val">{Math.round(selectedItem.zoom * 100)}%</span>
                  <button
                    type="button"
                    className="zoom-btn"
                    onClick={() =>
                      setItems((prev) =>
                        prev.map((it, i) =>
                          i === selectedSlotIndex
                            ? { ...it, zoom: Math.min(3.0, it.zoom + 0.2) }
                            : it
                        )
                      )
                    }
                  >
                    <ZoomIn size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* 5. 사진 순서 변경 목록 */}
            <div className="collage-section list-section">
              <label className="sidebar-label">칸 순서 ({items.length}장)</label>
              <div className="items-reorder-list">
                {items.map((it, idx) => (
                  <div
                    key={it.id}
                    className={`reorder-item ${idx === selectedSlotIndex ? "active" : ""}`}
                    onClick={() => setSelectedSlotIndex(idx)}
                  >
                    <span className="item-index-badge">{idx + 1}</span>
                    <span className="item-name-text">
                      {it.caption || it.name}
                    </span>
                    <div className="reorder-btns">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          moveItem(idx, "up");
                        }}
                        title="위로 이동"
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        type="button"
                        disabled={idx === items.length - 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          moveItem(idx, "down");
                        }}
                        title="아래로 이동"
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 하단 저장 액션 */}
            <div className="collage-footer-actions">
              <button
                type="button"
                className="save-collage-btn"
                onClick={handleSaveCollage}
                disabled={isSaving}
              >
                <Download size={16} />
                {isSaving ? "합치는 중..." : "새 이미지로 저장 (A4 300DPI)"}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
