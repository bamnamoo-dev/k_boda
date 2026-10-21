import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  X,
  FileText,
  ChevronUp,
  ChevronDown,
  CheckCircle2,
  FolderOpen,
  FileDown,
  ExternalLink,
} from "lucide-react";
import "./PdfBindingModal.css";

interface PdfBindingItem {
  id: string;
  path: string;
  filename: string;
  filesize: string;
}

interface PdfBindingModalProps {
  targetPaths: string[];
  onClose: () => void;
  showToast: (msg: string) => void;
  onRefreshExplorer?: () => void;
}

interface GeneratePdfResult {
  outputPath: string;
  pageCount: number;
  fileSize: number;
}

export function PdfBindingModal({
  targetPaths,
  onClose,
  showToast,
  onRefreshExplorer,
}: PdfBindingModalProps) {
  // 1. 항목 목록 (순서 재배치 가능)
  const [items, setItems] = useState<PdfBindingItem[]>(() =>
    targetPaths.map((p, idx) => {
      const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
      const filename = slash >= 0 ? p.substring(slash + 1) : p;
      return {
        id: `pdf_item_${idx}_${Date.now()}`,
        path: p,
        filename,
        filesize: "",
      };
    })
  );

  // 2. 옵션 상태
  const [orientation, setOrientation] = useState<"portrait" | "landscape" | "auto">("portrait");
  const [layout, setLayout] = useState<1 | 2 | 4>(1);
  const [marginMm, setMarginMm] = useState<number>(10);
  const [showFilename, setShowFilename] = useState<boolean>(true);
  const [targetDpi, setTargetDpi] = useState<150 | 300>(150); // 기본 150DPI (공문 제출용)

  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generationProgress, setGenerationProgress] = useState<string>("");
  const [completedResult, setCompletedResult] = useState<GeneratePdfResult | null>(null);

  // 항목 순서 변경
  const moveItem = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= items.length) return;
    setItems((prev) => {
      const next = [...prev];
      const tmp = next[index];
      next[index] = next[target];
      next[target] = tmp;
      return next;
    });
  };

  // 항목 삭제
  const removeItem = (index: number) => {
    if (items.length <= 1) {
      showToast("최소 1장 이상의 사진이 필요합니다.");
      return;
    }
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  // 한국어 파일명 배너 렌더링 (모든 PDF 뷰어에서 100% 한글 깨짐 없이 선명하게 표시)
  const renderCaptionImageBase64 = (text: string): string => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 70;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#333333";
    ctx.font = 'bold 30px "Malgun Gothic", "Noto Sans KR", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 40);

    return canvas.toDataURL("image/jpeg", 0.9);
  };

  // PDF 생성 실행
  const handleGeneratePdf = async () => {
    if (items.length === 0) return;

    setIsGenerating(true);
    setGenerationProgress("사진과 파일명을 준비하는 중...");

    try {
      // 1. 파일명 캡션 렌더링
      const preparedItems = items.map((item, idx) => {
        setGenerationProgress(`캡션 준비 중 (${idx + 1}/${items.length})...`);
        const captionBase64 = showFilename ? renderCaptionImageBase64(item.filename) : undefined;
        return {
          path: item.path,
          filename: item.filename,
          captionBase64,
        };
      });

      // 2. 출력 파일 경로 결정: 원본 폴더 안 "PrismView_결과\증빙자료_묶음_날짜.pdf"
      const first = items[0].path;
      const slash = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
      const parentDir = slash >= 0 ? first.substring(0, slash) : "";
      const resultDir = `${parentDir}\\PrismView_결과`;

      const now = new Date();
      const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      const outputPath = `${resultDir}\\증빙자료_묶음_${dateStr}.pdf`;

      setGenerationProgress("Rust에서 A4 규격 고품질 PDF를 생성하는 중...");

      const res = await invoke<GeneratePdfResult>("generate_images_pdf", {
        opts: {
          items: preparedItems,
          outputPath,
          orientation,
          layout,
          marginMm,
          showFilename,
          targetDpi,
        },
      });

      setCompletedResult(res);
      showToast(`PDF 묶음 파일이 생성되었습니다: ${res.outputPath}`);
      if (onRefreshExplorer) onRefreshExplorer();
    } catch (e) {
      showToast(`PDF 생성 오류: ${e}`);
    } finally {
      setIsGenerating(false);
      setGenerationProgress("");
    }
  };

  // 생성된 파일 폴더 열기
  const handleShowInFolder = async () => {
    if (!completedResult) return;
    try {
      await invoke("show_in_folder", { path: completedResult.outputPath });
    } catch (e) {
      showToast(`폴더 열기 실패: ${e}`);
    }
  };

  // 기본 PDF 뷰어로 열기
  const handleOpenPdf = async () => {
    if (!completedResult) return;
    try {
      await invoke("open_in_external_editor", { path: completedResult.outputPath });
    } catch (e) {
      showToast(`PDF 열기 실패: ${e}`);
    }
  };

  const estimatedPages = Math.ceil(items.length / layout);

  return (
    <div className="pdf-modal-overlay">
      <div className="pdf-modal-container">
        {/* 상단 헤더 */}
        <header className="pdf-modal-header">
          <div className="pdf-header-title">
            <FileText size={20} className="header-icon" />
            <h2>PDF 한 파일로 묶기 (증빙자료 제출용)</h2>
            <span className="pdf-badge">선택 사진 {items.length}장</span>
          </div>
          <button
            type="button"
            className="pdf-close-btn"
            onClick={onClose}
            title="닫기 (Esc)"
          >
            <X size={20} />
          </button>
        </header>

        {completedResult ? (
          /* 완료 결과 화면 */
          <div className="pdf-success-view">
            <div className="success-icon-box">
              <CheckCircle2 size={54} color="#10b981" />
            </div>
            <h3>PDF 파일이 성공적으로 생성되었습니다!</h3>
            <p className="success-path">{completedResult.outputPath}</p>

            <div className="success-stats-box">
              <div className="stat-card">
                <span className="stat-label">총 페이지 수</span>
                <span className="stat-val">{completedResult.pageCount} 페이지</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">포함된 사진</span>
                <span className="stat-val">{items.length} 장</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">파일 크기</span>
                <span className="stat-val">
                  {(completedResult.fileSize / (1024 * 1024)).toFixed(2)} MB
                </span>
              </div>
            </div>

            <p className="success-hint">
              한글(HWP), K-에듀파인, 나이스 공문서 첨부 및 인쇄에 바로 사용하실 수 있습니다.
            </p>

            <div className="success-action-btns">
              <button
                type="button"
                className="action-btn primary"
                onClick={handleOpenPdf}
              >
                <ExternalLink size={16} /> PDF 파일 열기
              </button>
              <button
                type="button"
                className="action-btn secondary"
                onClick={handleShowInFolder}
              >
                <FolderOpen size={16} /> 폴더에서 보기
              </button>
              <button
                type="button"
                className="action-btn tertiary"
                onClick={onClose}
              >
                닫기
              </button>
            </div>
          </div>
        ) : (
          /* 메인 설정 및 순서 화면 */
          <div className="pdf-main-body">
            {/* 좌측 사진 목록 및 순서 조절 */}
            <div className="pdf-items-pane">
              <div className="pane-header-row">
                <span className="pane-title">
                  사진 순서 (드래그/버튼으로 변경 가능)
                </span>
                <span className="pane-subtitle">
                  예상 페이지: {estimatedPages}쪽 (한 장당 {layout}장 배치)
                </span>
              </div>

              <div className="pdf-items-list">
                {items.map((item, idx) => (
                  <div key={item.id} className="pdf-item-row">
                    <span className="item-order-num">{idx + 1}</span>
                    <img
                      src={convertFileSrc(item.path)}
                      alt={item.filename}
                      className="item-thumb"
                    />
                    <div className="item-info-col">
                      <span className="item-filename" title={item.filename}>
                        {item.filename}
                      </span>
                      <span className="item-page-hint">
                        {Math.floor(idx / layout) + 1}페이지에 배치
                      </span>
                    </div>

                    <div className="item-move-btns">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => moveItem(idx, "up")}
                        title="위로 이동"
                      >
                        <ChevronUp size={15} />
                      </button>
                      <button
                        type="button"
                        disabled={idx === items.length - 1}
                        onClick={() => moveItem(idx, "down")}
                        title="아래로 이동"
                      >
                        <ChevronDown size={15} />
                      </button>
                      <button
                        type="button"
                        className="item-remove-btn"
                        onClick={() => removeItem(idx)}
                        title="제외"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 우측 PDF 옵션 설정 */}
            <aside className="pdf-options-sidebar">
              {/* 1. 용지 방향 */}
              <div className="pdf-option-group">
                <label className="option-label">용지 방향</label>
                <div className="option-button-row">
                  <button
                    type="button"
                    className={`opt-btn ${orientation === "portrait" ? "active" : ""}`}
                    onClick={() => setOrientation("portrait")}
                  >
                    A4 세로
                  </button>
                  <button
                    type="button"
                    className={`opt-btn ${orientation === "landscape" ? "active" : ""}`}
                    onClick={() => setOrientation("landscape")}
                  >
                    A4 가로
                  </button>
                  <button
                    type="button"
                    className={`opt-btn ${orientation === "auto" ? "active" : ""}`}
                    onClick={() => setOrientation("auto")}
                  >
                    방향 자동
                  </button>
                </div>
              </div>

              {/* 2. 한 페이지당 배치 */}
              <div className="pdf-option-group">
                <label className="option-label">한 페이지당 사진 배치</label>
                <div className="option-button-row">
                  <button
                    type="button"
                    className={`opt-btn ${layout === 1 ? "active" : ""}`}
                    onClick={() => setLayout(1)}
                  >
                    1장씩
                  </button>
                  <button
                    type="button"
                    className={`opt-btn ${layout === 2 ? "active" : ""}`}
                    onClick={() => setLayout(2)}
                  >
                    2장씩
                  </button>
                  <button
                    type="button"
                    className={`opt-btn ${layout === 4 ? "active" : ""}`}
                    onClick={() => setLayout(4)}
                  >
                    4장씩 (2x2)
                  </button>
                </div>
              </div>

              {/* 3. 여백 */}
              <div className="pdf-option-group">
                <label className="option-label">여백</label>
                <div className="option-button-row">
                  <button
                    type="button"
                    className={`opt-btn ${marginMm === 0 ? "active" : ""}`}
                    onClick={() => setMarginMm(0)}
                  >
                    여백 없음
                  </button>
                  <button
                    type="button"
                    className={`opt-btn ${marginMm === 10 ? "active" : ""}`}
                    onClick={() => setMarginMm(10)}
                  >
                    좁게 (10mm)
                  </button>
                  <button
                    type="button"
                    className={`opt-btn ${marginMm === 20 ? "active" : ""}`}
                    onClick={() => setMarginMm(20)}
                  >
                    보통 (20mm)
                  </button>
                </div>
              </div>

              {/* 4. 파일명 표시 여부 */}
              <div className="pdf-option-group">
                <label className="checkbox-opt-label">
                  <input
                    type="checkbox"
                    checked={showFilename}
                    onChange={(e) => setShowFilename(e.target.checked)}
                  />
                  <span>사진 아래 파일명 표시 (한글 지원)</span>
                </label>
              </div>

              {/* 5. 해상도 및 용량 최적화 */}
              <div className="pdf-option-group">
                <label className="option-label">용량 및 해상도 최적화</label>
                <div className="option-button-col">
                  <label className="radio-opt-card">
                    <input
                      type="radio"
                      name="dpi"
                      checked={targetDpi === 150}
                      onChange={() => setTargetDpi(150)}
                    />
                    <div className="card-texts">
                      <span className="card-title">화면·공문 제출용 (150 DPI) — 권장</span>
                      <span className="card-desc">
                        용량이 대폭 줄어 K-에듀파인, 나이스 업무 시스템 업로드에 최적화됩니다.
                      </span>
                    </div>
                  </label>
                  <label className="radio-opt-card">
                    <input
                      type="radio"
                      name="dpi"
                      checked={targetDpi === 300}
                      onChange={() => setTargetDpi(300)}
                    />
                    <div className="card-texts">
                      <span className="card-title">인쇄용 최고 품질 (300 DPI)</span>
                      <span className="card-desc">
                        컬러 레이저 프린터 출력 및 고품질 인쇄물 제작에 적합합니다.
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              {/* 하단 생성 버튼 */}
              <div className="pdf-sidebar-footer">
                <button
                  type="button"
                  className="generate-pdf-btn"
                  onClick={handleGeneratePdf}
                  disabled={isGenerating || items.length === 0}
                >
                  <FileDown size={17} />
                  {isGenerating ? (generationProgress || "생성 중...") : `A4 PDF로 묶기 (${estimatedPages}쪽)`}
                </button>
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
