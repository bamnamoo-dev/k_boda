import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import DxfParser from "dxf-parser";
import {
  Maximize2,
  Scan,
  ZoomIn,
  ZoomOut,
  Layers,
  SunMedium,
  ExternalLink,
  Printer,
  Download,
  X,
  AlertCircle,
  Info,
  CheckSquare,
  Square,
} from "lucide-react";
import "./CadViewer.css";

// ACI (AutoCAD Color Index) 기본 1~9 및 주요 색상 테이블
const ACI_COLORS: Record<number, string> = {
  1: "#ff0000", // Red
  2: "#ffff00", // Yellow
  3: "#00ff00", // Green
  4: "#00ffff", // Cyan
  5: "#0000ff", // Blue
  6: "#ff00ff", // Magenta
  7: "#ffffff", // White / Black (배경에 따라)
  8: "#808080", // Dark Grey
  9: "#c0c0c0", // Light Grey
};

// 10~255번 색상 보간 계산 헬퍼
function getAciColor(colorIndex: number | undefined, isWhiteBg: boolean): string {
  if (colorIndex === undefined || colorIndex === 0 || colorIndex === 256) {
    // ByLayer or ByBlock -> 기본 색상
    return isWhiteBg ? "#000000" : "#ffffff";
  }
  if (colorIndex === 7) {
    return isWhiteBg ? "#000000" : "#ffffff";
  }
  if (ACI_COLORS[colorIndex]) {
    const col = ACI_COLORS[colorIndex];
    if (isWhiteBg && (colorIndex === 2 || col === "#ffff00")) {
      return "#b8860b"; // 흰 배경에서 노란색 가독성 보정
    }
    return col;
  }
  // 기본 안전 색상
  return isWhiteBg ? "#222222" : "#dddddd";
}

// DXF MText 포맷팅 태그 클린업 (예: \P, \A1;, \H0.8x; 등)
function cleanDxfText(raw: string): string {
  if (!raw) return "";
  let s = raw.replace(/\\P/g, "\n"); // \P는 줄바꿈
  s = s.replace(/\\A[0-2];/g, ""); // 정렬 태그
  s = s.replace(/\\H[0-9.]+x?;/g, ""); // 높이 태그
  s = s.replace(/\\W[0-9.]+x?;/g, ""); // 폭 태그
  s = s.replace(/\\T[0-9.]+;/g, ""); // 트래킹
  s = s.replace(/\\Q[0-9.-]+;/g, ""); // 기울기
  s = s.replace(/\\C[0-9]+;/g, ""); // 색상 태그
  s = s.replace(/\\F[^;]+;/g, ""); // 글꼴 태그
  s = s.replace(/\{|\}/g, ""); // 블록 괄호
  s = s.replace(/%%[udopc%]/gi, ""); // 특수 제어 코드
  return s.trim();
}

interface CadLayerItem {
  name: string;
  color: string;
  visible: boolean;
  count: number;
}

interface CadViewerProps {
  filePath: string;
  onClose?: () => void;
  showToast: (msg: string) => void;
  isWhiteBackground?: boolean;
  onToggleBg?: () => void;
}

interface CadBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const CadViewer: React.FC<CadViewerProps> = ({
  filePath,
  showToast,
  isWhiteBackground = false,
  onToggleBg,
}) => {
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadingText, setLoadingText] = useState<string>("도면 불러오는 중...");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 상단 간이 보기 안내 배너 닫힘 상태
  const [bannerClosed, setBannerClosed] = useState<boolean>(false);

  // 레이어 패널 토글 상태
  const [showLayerPanel, setShowLayerPanel] = useState<boolean>(false);
  const [layers, setLayers] = useState<CadLayerItem[]>([]);

  // 파싱된 DXF 데이터
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [dxfData, setDxfData] = useState<any | null>(null);
  const [bbox, setBbox] = useState<CadBoundingBox | null>(null);

  // 뷰포트 변환 상태: scale, panX, panY
  const [scale, setScale] = useState<number>(1.0);
  const [panX, setPanX] = useState<number>(0);
  const [panY, setPanY] = useState<number>(0);

  // 캔버스 및 뷰포트 참조
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // 드래그 상태
  const isDraggingRef = useRef<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number }>({
    x: 0,
    y: 0,
    panX: 0,
    panY: 0,
  });

  const fileName = useMemo(() => {
    const p = filePath.replace(/\\/g, "/");
    return p.substring(p.lastIndexOf("/") + 1);
  }, [filePath]);

  const isDwg = useMemo(() => {
    return filePath.toLowerCase().endsWith(".dwg");
  }, [filePath]);

  // 1. 도면 파일 로드 및 DXF 파싱
  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);
    setErrorMessage(null);

    const loadCad = async () => {
      try {
        let dxfFilePath = filePath;

        if (isDwg) {
          setLoadingText("DWG 도면 변환 중... (LibreDWG)");
          const convRes = await invoke<{ dxfPath: string; isCached: boolean }>("convert_dwg_to_dxf", {
            dwgPath: filePath,
          });
          if (!isMounted) return;
          dxfFilePath = convRes.dxfPath;
        }

        setLoadingText("도면 구조 파싱 중...");
        const textContent = await invoke<string>("read_cad_file_text", {
          filePath: dxfFilePath,
        });
        if (!isMounted) return;

        const parser = new DxfParser();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let parsed: any;
        try {
          parsed = parser.parseSync(textContent);
        } catch (parseErr) {
          throw new Error(`DXF 파싱 오류: ${String(parseErr)}`);
        }

        if (!isMounted) return;

        // 레이어 정보 추출
        const layerMap: Record<string, { color: string; count: number }> = {};
        if (parsed.tables?.layer?.layers) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          Object.values(parsed.tables.layer.layers).forEach((l: any) => {
            layerMap[l.name] = {
              color: getAciColor(l.colorNumber, isWhiteBackground),
              count: 0,
            };
          });
        }

        // 바운딩 박스 계산 및 엔티티 레이어 카운트
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const includePoint = (px: number, py: number) => {
          if (isNaN(px) || isNaN(py)) return;
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        };

        if (parsed.entities && Array.isArray(parsed.entities)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parsed.entities.forEach((e: any) => {
            // 모델 공간만 표시 (inPaperSpace 제외)
            if (e.inPaperSpace) return;

            const lName = e.layer || "0";
            if (!layerMap[lName]) {
              layerMap[lName] = { color: "#ffffff", count: 0 };
            }
            layerMap[lName].count++;

            if (e.type === "LINE") {
              if (e.vertices && e.vertices.length >= 2) {
                includePoint(e.vertices[0].x, e.vertices[0].y);
                includePoint(e.vertices[1].x, e.vertices[1].y);
              }
            } else if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
              if (e.vertices && Array.isArray(e.vertices)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                e.vertices.forEach((v: any) => includePoint(v.x, v.y));
              }
            } else if (e.type === "CIRCLE" || e.type === "ARC") {
              if (e.center && typeof e.radius === "number") {
                includePoint(e.center.x - e.radius, e.center.y - e.radius);
                includePoint(e.center.x + e.radius, e.center.y + e.radius);
              }
            } else if (e.type === "TEXT" || e.type === "MTEXT") {
              if (e.startPoint) {
                includePoint(e.startPoint.x, e.startPoint.y);
              } else if (e.position) {
                includePoint(e.position.x, e.position.y);
              }
            } else if (e.type === "INSERT") {
              if (e.position) {
                includePoint(e.position.x, e.position.y);
              }
            }
          });
        }

        const layerList: CadLayerItem[] = Object.keys(layerMap).map((name) => ({
          name,
          color: layerMap[name].color,
          visible: true,
          count: layerMap[name].count,
        }));
        layerList.sort((a, b) => a.name.localeCompare(b.name));
        setLayers(layerList);

        if (minX === Infinity || maxX === -Infinity) {
          // 기본 바운딩 박스
          minX = 0;
          minY = 0;
          maxX = 1000;
          maxY = 1000;
        }

        setBbox({ minX, minY, maxX, maxY });
        setDxfData(parsed);
        setIsLoading(false);
      } catch (err) {
        if (!isMounted) return;
        setIsLoading(false);
        setErrorMessage(String(err));
        showToast("도면을 열 수 없습니다.");
      }
    };

    loadCad();

    return () => {
      isMounted = false;
    };
  }, [filePath, isDwg, isWhiteBackground, showToast]);

  // 2. 화면 맞춤 (Fit to screen)
  const fitToScreen = useCallback(() => {
    if (!bbox || !viewportRef.current) return;
    const vp = viewportRef.current.getBoundingClientRect();
    const dw = bbox.maxX - bbox.minX;
    const dh = bbox.maxY - bbox.minY;
    if (dw <= 0 || dh <= 0) return;

    const padding = 40;
    const availW = Math.max(100, vp.width - padding * 2);
    const availH = Math.max(100, vp.height - padding * 2);

    const fitScale = Math.min(availW / dw, availH / dh);
    setScale(fitScale);

    // 중앙 정렬
    const centerX = (bbox.minX + bbox.maxX) / 2;
    const centerY = (bbox.minY + bbox.maxY) / 2;

    const newPanX = vp.width / 2 - centerX * fitScale;
    const newPanY = vp.height / 2 + centerY * fitScale;

    setPanX(newPanX);
    setPanY(newPanY);
  }, [bbox]);

  // 도면 데이터 로드 후 최초 1회 화면 맞춤
  useEffect(() => {
    if (bbox && dxfData) {
      setTimeout(() => fitToScreen(), 30);
    }
  }, [bbox, dxfData, fitToScreen]);

  // 3. Canvas 2D 렌더링 루프
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dxfData || !bbox) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const vpW = canvas.width;
    const vpH = canvas.height;

    // 배경 채우기
    ctx.fillStyle = isWhiteBackground ? "#ffffff" : "#121418";
    ctx.fillRect(0, 0, vpW, vpH);

    // 가시적인 레이어 Set
    const visibleLayerSet = new Set(
      layers.filter((l) => l.visible).map((l) => l.name)
    );

    // CAD 좌표계 (Y-up) -> Canvas 좌표계 (Y-down) 변환 함수
    const toScreenX = (x: number) => x * scale + panX;
    const toScreenY = (y: number) => -y * scale + panY;

    // 블록 렌더링 헬퍼
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderEntities = (entities: any[], parentX = 0, parentY = 0, parentScale = 1) => {
      if (!entities || !Array.isArray(entities)) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      entities.forEach((entity: any) => {
        if (entity.inPaperSpace) return; // 모델 공간만 표시
        if (entity.layer && !visibleLayerSet.has(entity.layer)) return;

        // 색상 결정
        const strokeColor = getAciColor(entity.colorNumber, isWhiteBackground);
        ctx.strokeStyle = strokeColor;
        ctx.fillStyle = strokeColor;
        ctx.lineWidth = Math.max(1, (entity.lineWeight || 1) * 0.8);

        if (entity.type === "LINE") {
          if (entity.vertices && entity.vertices.length >= 2) {
            const v0 = entity.vertices[0];
            const v1 = entity.vertices[1];
            ctx.beginPath();
            ctx.moveTo(
              toScreenX(parentX + v0.x * parentScale),
              toScreenY(parentY + v0.y * parentScale)
            );
            ctx.lineTo(
              toScreenX(parentX + v1.x * parentScale),
              toScreenY(parentY + v1.y * parentScale)
            );
            ctx.stroke();
          }
        } else if (entity.type === "LWPOLYLINE" || entity.type === "POLYLINE") {
          const verts = entity.vertices;
          if (verts && verts.length >= 2) {
            ctx.beginPath();
            ctx.moveTo(
              toScreenX(parentX + verts[0].x * parentScale),
              toScreenY(parentY + verts[0].y * parentScale)
            );
            for (let i = 1; i < verts.length; i++) {
              ctx.lineTo(
                toScreenX(parentX + verts[i].x * parentScale),
                toScreenY(parentY + verts[i].y * parentScale)
              );
            }
            if (entity.shape || entity.closed) {
              ctx.closePath();
            }
            ctx.stroke();
          }
        } else if (entity.type === "CIRCLE") {
          if (entity.center && typeof entity.radius === "number") {
            const cx = toScreenX(parentX + entity.center.x * parentScale);
            const cy = toScreenY(parentY + entity.center.y * parentScale);
            const r = entity.radius * scale * parentScale;
            if (r > 0) {
              ctx.beginPath();
              ctx.arc(cx, cy, r, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        } else if (entity.type === "ARC") {
          if (entity.center && typeof entity.radius === "number") {
            const cx = toScreenX(parentX + entity.center.x * parentScale);
            const cy = toScreenY(parentY + entity.center.y * parentScale);
            const r = entity.radius * scale * parentScale;
            if (r > 0) {
              // DXF 각도는 라디안 또는 도(degree), Y축 반전 반영
              const sAngle = -(entity.endAngle || 0);
              const eAngle = -(entity.startAngle || 0);
              ctx.beginPath();
              ctx.arc(cx, cy, r, sAngle, eAngle);
              ctx.stroke();
            }
          }
        } else if (entity.type === "SOLID") {
          const pts = entity.points;
          if (pts && pts.length >= 3) {
            ctx.beginPath();
            ctx.moveTo(toScreenX(parentX + pts[0].x * parentScale), toScreenY(parentY + pts[0].y * parentScale));
            ctx.lineTo(toScreenX(parentX + pts[1].x * parentScale), toScreenY(parentY + pts[1].y * parentScale));
            ctx.lineTo(toScreenX(parentX + pts[3]?.x || pts[2].x * parentScale), toScreenY(parentY + pts[3]?.y || pts[2].y * parentScale));
            ctx.lineTo(toScreenX(parentX + pts[2].x * parentScale), toScreenY(parentY + pts[2].y * parentScale));
            ctx.closePath();
            ctx.fill();
          }
        } else if (entity.type === "TEXT" || entity.type === "MTEXT") {
          const rawText = entity.text || entity.string || "";
          const cleaned = cleanDxfText(rawText);
          if (cleaned) {
            const pt = entity.startPoint || entity.position || { x: 0, y: 0 };
            const sx = toScreenX(parentX + pt.x * parentScale);
            const sy = toScreenY(parentY + pt.y * parentScale);

            const textH = Math.max(9, (entity.textHeight || 12) * scale * parentScale);
            ctx.font = `${Math.round(textH)}px 'Malgun Gothic', '맑은 고딕', sans-serif`;
            ctx.textBaseline = "middle";

            const lines = cleaned.split("\n");
            lines.forEach((line, lineIdx) => {
              ctx.fillText(line, sx, sy + lineIdx * (textH * 1.3));
            });
          }
        } else if (entity.type === "INSERT") {
          // 블록 삽입 엔티티
          const blockName = entity.name;
          const block = dxfData.blocks?.[blockName];
          if (block && block.entities) {
            const ix = parentX + (entity.position?.x || 0) * parentScale;
            const iy = parentY + (entity.position?.y || 0) * parentScale;
            const iscale = parentScale * (entity.xScale || 1.0);
            renderEntities(block.entities, ix, iy, iscale);
          }
        }
      });
    };

    renderEntities(dxfData.entities);
  }, [dxfData, bbox, scale, panX, panY, layers, isWhiteBackground]);

  // 뷰포트 크기 변경 시 캔버스 버퍼 리사이즈
  useEffect(() => {
    const handleResize = () => {
      if (!viewportRef.current || !canvasRef.current) return;
      const rect = viewportRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvasRef.current.width = rect.width * dpr;
      canvasRef.current.height = rect.height * dpr;
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
      }
      renderCanvas();
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [renderCanvas]);

  // 변환 상태나 레이어 변경 시 재렌더링
  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // 마우스 인터랙션: 휠 줌 (커서 중심)
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (!viewportRef.current) return;
    const vp = viewportRef.current.getBoundingClientRect();
    const mouseX = e.clientX - vp.left;
    const mouseY = e.clientY - vp.top;

    const zoomFactor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const newScale = Math.max(0.0001, Math.min(500, scale * zoomFactor));

    // 커서 위치 기준 줌
    const newPanX = mouseX - (mouseX - panX) * (newScale / scale);
    const newPanY = mouseY - (mouseY - panY) * (newScale / scale);

    setScale(newScale);
    setPanX(newPanX);
    setPanY(newPanY);
  };

  // 마우스 드래그 패닝
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX,
      panY,
    };
    e.preventDefault();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPanX(dragStartRef.current.panX + dx);
    setPanY(dragStartRef.current.panY + dy);
  };

  const onMouseUp = () => {
    isDraggingRef.current = false;
  };

  // 100% 뷰
  const setActualSize = () => {
    setScale(1.0);
    if (viewportRef.current && bbox) {
      const vp = viewportRef.current.getBoundingClientRect();
      setPanX(vp.width / 2);
      setPanY(vp.height / 2);
    }
  };

  // 인쇄 (Ctrl+P)
  const handlePrint = () => {
    window.print();
  };

  // 현재 화면 PNG로 저장
  const handleSavePng = async () => {
    if (!canvasRef.current) return;
    try {
      const dataUrl = canvasRef.current.toDataURL("image/png");
      const base64Data = dataUrl.split(",")[1];

      const savePath = await save({
        defaultPath: `${fileName.replace(/\.[^/.]+$/, "")}_cad_view.png`,
        filters: [{ name: "PNG Image", extensions: ["png"] }],
      });

      if (savePath) {
        await invoke("save_clipboard_image", {
          base64Data,
          targetPath: savePath,
        });
        showToast("✔ 도면 화면이 PNG로 저장되었습니다.");
      }
    } catch (err) {
      showToast(`저장 실패: ${String(err)}`);
    }
  };

  // 윈도우 연결 CAD 프로그램으로 열기
  const handleOpenExternal = async () => {
    try {
      await invoke("open_in_cad_program", { filePath });
      showToast("외부 CAD 프로그램을 실행했습니다.");
    } catch (err) {
      showToast(`실행 실패: ${String(err)}`);
    }
  };

  // 키보드 단축키
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Digit0" || e.code === "Numpad0") {
        fitToScreen();
      } else if (e.code === "Digit1" || e.code === "Numpad1") {
        setActualSize();
      } else if (e.code === "Equal" || e.code === "NumpadAdd") {
        setScale((s) => s * 1.2);
      } else if (e.code === "Minus" || e.code === "NumpadSubtract") {
        setScale((s) => s / 1.2);
      } else if (e.code === "KeyP" && e.ctrlKey) {
        handlePrint();
        e.preventDefault();
      } else if (e.code === "KeyB") {
        onToggleBg?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fitToScreen, onToggleBg]);

  return (
    <div className="cad-viewer-container" onMouseUp={onMouseUp}>
      {/* 12. 상단 간이 보기 안내줄 */}
      {!bannerClosed && (
        <div className="cad-disclaimer-banner">
          <div className="cad-disclaimer-text">
            <Info size={14} style={{ color: "#38bdf8" }} />
            <span>간이 보기용입니다. 정확한 도면은 원본 프로그램에서 확인하세요.</span>
          </div>
          <button
            className="cad-disclaimer-close"
            onClick={() => setBannerClosed(true)}
            title="안내줄 닫기"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* CAD 전용 툴바 */}
      <div className="cad-toolbar">
        <div className="cad-toolbar-left">
          <span className="cad-file-badge">{isDwg ? "DWG" : "DXF"}</span>
          <span className="cad-file-name" title={filePath}>
            {fileName}
          </span>
        </div>

        <div className="cad-toolbar-right">
          {/* 6. 화면 맞춤 & 줌 */}
          <button className="cad-btn" onClick={fitToScreen} title="화면 맞춤 (0)">
            <Maximize2 size={14} /> 화면 맞춤
          </button>
          <button className="cad-btn" onClick={setActualSize} title="100% 원본 (1)">
            <Scan size={14} /> 100%
          </button>
          <button className="cad-btn" onClick={() => setScale((s) => s * 1.25)} title="확대 (+)">
            <ZoomIn size={14} />
          </button>
          <button className="cad-btn" onClick={() => setScale((s) => s / 1.25)} title="축소 (-)">
            <ZoomOut size={14} />
          </button>

          {/* 8. 배경 전환 (검정 / 흰색) */}
          <button
            className={`cad-btn ${isWhiteBackground ? "active" : ""}`}
            onClick={onToggleBg}
            title="배경색 전환: 검정(캐드 기본) / 흰색(인쇄 확인용) (B)"
          >
            <SunMedium size={14} /> {isWhiteBackground ? "흰색 배경" : "검정 배경"}
          </button>

          {/* 7. 레이어 패널 토글 */}
          <button
            className={`cad-btn ${showLayerPanel ? "active" : ""}`}
            onClick={() => setShowLayerPanel(!showLayerPanel)}
            title="레이어 목록 보기"
          >
            <Layers size={14} /> 레이어 ({layers.length})
          </button>

          {/* 11. PNG 저장 & 인쇄 */}
          <button className="cad-btn" onClick={handleSavePng} title="현재 화면을 PNG로 저장">
            <Download size={14} /> PNG 저장
          </button>
          <button className="cad-btn" onClick={handlePrint} title="인쇄 (Ctrl+P)">
            <Printer size={14} /> 인쇄
          </button>

          {/* 13. 다른 프로그램으로 열기 */}
          <button
            className="cad-btn"
            onClick={handleOpenExternal}
            title="AutoCAD, DWG TrueView 등 기본 CAD 프로그램으로 엽니다"
          >
            <ExternalLink size={14} /> CAD로 열기
          </button>
        </div>
      </div>

      {/* 뷰포트 & 캔버스 */}
      <div
        ref={viewportRef}
        className="cad-viewport"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onWheel={onWheel}
        onDoubleClick={fitToScreen}
      >
        <canvas ref={canvasRef} className="cad-canvas" />

        {/* 로딩 인디케이터 */}
        {isLoading && (
          <div className="cad-loading-overlay">
            <div className="cad-spinner" />
            <div style={{ fontSize: 14, fontWeight: 600 }}>{loadingText}</div>
            <div style={{ fontSize: 12, color: "#94a3b8" }}>
              LibreDWG 엔진을 통해 안전하게 처리 중입니다...
            </div>
          </div>
        )}

        {/* 에러 카드 */}
        {errorMessage && (
          <div className="cad-loading-overlay">
            <div className="cad-error-card">
              <AlertCircle size={36} style={{ color: "#ef4444" }} />
              <div style={{ fontSize: 15, fontWeight: 700, color: "#f8fafc" }}>
                도면을 표시할 수 없습니다
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.5 }}>
                {errorMessage}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="cad-btn" onClick={handleOpenExternal}>
                  <ExternalLink size={14} /> 외부 프로그램으로 열기
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 7. 레이어 목록 플로팅 패널 */}
        {showLayerPanel && (
          <div className="cad-layer-panel">
            <div className="cad-layer-header">
              <span className="cad-layer-title">도면 레이어</span>
              <div className="cad-layer-actions">
                <button
                  className="cad-btn"
                  style={{ padding: "2px 6px", fontSize: 11 }}
                  onClick={() => {
                    setLayers((prev) => prev.map((l) => ({ ...l, visible: true })));
                  }}
                  title="모든 레이어 켜기"
                >
                  <CheckSquare size={12} /> 전체 켜기
                </button>
                <button
                  className="cad-btn"
                  style={{ padding: "2px 6px", fontSize: 11 }}
                  onClick={() => {
                    setLayers((prev) => prev.map((l) => ({ ...l, visible: false })));
                  }}
                  title="모든 레이어 끄기"
                >
                  <Square size={12} /> 전체 끄기
                </button>
              </div>
            </div>

            <div className="cad-layer-list">
              {layers.map((layer) => (
                <div
                  key={layer.name}
                  className="cad-layer-item"
                  onClick={() => {
                    setLayers((prev) =>
                      prev.map((l) =>
                        l.name === layer.name ? { ...l, visible: !l.visible } : l
                      )
                    );
                  }}
                >
                  <input
                    type="checkbox"
                    checked={layer.visible}
                    onChange={() => {}}
                    style={{ cursor: "pointer" }}
                  />
                  <div
                    className="cad-color-chip"
                    style={{ backgroundColor: layer.color }}
                  />
                  <span className="cad-layer-name" title={layer.name}>
                    {layer.name}
                  </span>
                  <span style={{ fontSize: 10, color: "#64748b" }}>
                    {layer.count}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 하단 상태바 */}
      <div className="cad-status-bar">
        <div>
          모델 공간 (ModelSpace) · 글꼴: 맑은 고딕(대체) · 레이어:{" "}
          {layers.filter((l) => l.visible).length} / {layers.length} 활성
        </div>
        <div>
          {bbox && (
            <span>
              배율: {Math.round(scale * 100)}% · 범위: ({Math.round(bbox.minX)},{" "}
              {Math.round(bbox.minY)}) ~ ({Math.round(bbox.maxX)},{" "}
              {Math.round(bbox.maxY)})
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
