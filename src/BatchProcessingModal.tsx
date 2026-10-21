import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  RotateCw,
  FolderOpen,
  X,
  Check,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Sliders,
  CheckCircle2,
  XCircle,
  FileEdit,
  Play,
  StopCircle,
} from "lucide-react";
import type {
  BatchModalMode,
  BatchConvertOptions,
  BatchRotateOptions,
  BatchRenameItem,
  BatchProgressPayload,
  BatchRenameResult,
} from "./batchTypes";
import "./BatchProcessingModal.css";

interface BatchProcessingModalProps {
  initialMode: BatchModalMode;
  targetPaths: string[];
  onClose: () => void;
  showToast: (msg: string) => void;
  onRefreshExplorer: () => void;
  onUndoAdded: () => void;
}

export function BatchProcessingModal({
  initialMode,
  targetPaths,
  onClose,
  showToast,
  onRefreshExplorer,
  onUndoAdded,
}: BatchProcessingModalProps) {
  const [mode, setMode] = useState<BatchModalMode>(initialMode);

  // 1. 공통 저장 경로 (기본값: 원본 폴더 안 "PrismView_결과")
  const defaultOutputDir = useMemo(() => {
    if (targetPaths.length === 0) return "";
    const first = targetPaths[0];
    const lastSlash = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
    if (lastSlash > 0) {
      const parent = first.substring(0, lastSlash);
      return `${parent}\\PrismView_결과`;
    }
    return "PrismView_결과";
  }, [targetPaths]);

  const [outputDir, setOutputDir] = useState<string>(defaultOutputDir);

  // 2. 일괄 변환 옵션
  const [resizeMode, setResizeMode] = useState<"none" | "long_edge" | "percent">("long_edge");
  const [longEdgePx, setLongEdgePx] = useState<number>(1280);
  const [percent, setPercent] = useState<number>(50);
  const [format, setFormat] = useState<"jpg" | "png" | "webp">("jpg");
  const [quality, setQuality] = useState<number>(90);
  const [maxKbLimitEnabled, setMaxKbLimitEnabled] = useState<boolean>(true);
  const [maxKb, setMaxKb] = useState<number>(500);
  const [keepExif, setKeepExif] = useState<boolean>(true);

  // 3. 일괄 이름 바꾸기 옵션
  const [renameRuleMode, setRenameRuleMode] = useState<"rule" | "date">("rule");
  const [prefix, setPrefix] = useState<string>("사진_");
  const [suffix, setSuffix] = useState<string>("");
  const [startNum, setStartNum] = useState<number>(1);
  const [digits, setDigits] = useState<number>(3); // 1, 2, 3, 4
  const [dateSeparator, setDateSeparator] = useState<string>("-"); // '-', '_', '.'
  const [fileDates, setFileDates] = useState<Record<string, string>>({});
  const [isLoadingDates, setIsLoadingDates] = useState<boolean>(false);
  const [showRenameConfirm, setShowRenameConfirm] = useState<boolean>(false);

  // 4. 일괄 회전 옵션
  const [rotateMode, setRotateMode] = useState<"exif_auto" | "rotate90" | "rotate180" | "rotate270">("exif_auto");

  // 5. 진행 상태 관리
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [progressPayload, setProgressPayload] = useState<BatchProgressPayload | null>(null);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);

  // EXIF 촬영일자 로드 (이름 바꾸기 탭 또는 date 모드 시)
  useEffect(() => {
    if (mode === "rename" && renameRuleMode === "date" && Object.keys(fileDates).length === 0) {
      setIsLoadingDates(true);
      invoke<Record<string, string>>("get_batch_file_dates", { paths: targetPaths })
        .then((dates) => {
          setFileDates(dates);
        })
        .catch((err) => {
          showToast(`날짜 정보 읽기 실패: ${String(err)}`);
        })
        .finally(() => {
          setIsLoadingDates(false);
        });
    }
  }, [mode, renameRuleMode, targetPaths, fileDates, showToast]);

  // 진행률 이벤트 리스너 등록
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<BatchProgressPayload>("batch-progress", (event) => {
      setProgressPayload(event.payload);
      if (event.payload.isFinished) {
        setIsProcessing(false);
        setIsCancelling(false);
        onRefreshExplorer();
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [onRefreshExplorer]);

  // 폴더 변경 대화상자
  const handleSelectOutputDir = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: outputDir,
      });
      if (typeof selected === "string") {
        setOutputDir(selected);
      }
    } catch (err) {
      showToast(`폴더 선택 실패: ${String(err)}`);
    }
  }, [outputDir, showToast]);

  // 이름 바꾸기 실시간 미리보기 목록 계산
  const previewItems: BatchRenameItem[] = useMemo(() => {
    return targetPaths.map((fullPath, idx) => {
      const lastSlash = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"));
      const fileName = lastSlash >= 0 ? fullPath.substring(lastSlash + 1) : fullPath;
      const dotIdx = fileName.lastIndexOf(".");
      const ext = dotIdx > 0 ? fileName.substring(dotIdx) : "";

      const currentNum = startNum + idx;
      const numStr = String(currentNum).padStart(digits, "0");

      let newName = "";
      if (renameRuleMode === "rule") {
        newName = `${prefix}${numStr}${suffix}${ext}`;
      } else {
        // 날짜 기반
        const rawDate = fileDates[fullPath] || "2026-10-21";
        const formattedDate = rawDate.replace(/-/g, dateSeparator);
        newName = `${formattedDate}_${numStr}${ext}`;
      }

      return {
        oldPath: fullPath,
        newName,
      };
    });
  }, [targetPaths, startNum, digits, prefix, suffix, renameRuleMode, fileDates, dateSeparator]);

  // 이름 중복 체크
  const duplicateNameSet = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const item of previewItems) {
      const lower = item.newName.toLowerCase();
      if (seen.has(lower)) {
        dupes.add(lower);
      } else {
        seen.add(lower);
      }
    }
    return dupes;
  }, [previewItems]);

  // 작업 취소 실행
  const handleCancelTask = useCallback(async () => {
    if (!currentTaskId || isCancelling) return;
    setIsCancelling(true);
    try {
      await invoke("cancel_batch_task", { taskId: currentTaskId });
      showToast("작업을 취소하는 중입니다... (완료된 파일은 유지됩니다)");
    } catch (err) {
      showToast(`취소 요청 실패: ${String(err)}`);
    }
  }, [currentTaskId, isCancelling, showToast]);

  // 1. 일괄 변환 시작
  const handleStartConvert = useCallback(async () => {
    if (targetPaths.length === 0) return;
    const taskId = `convert_${Date.now()}`;
    setCurrentTaskId(taskId);
    setIsProcessing(true);
    setProgressPayload({
      taskId,
      total: targetPaths.length,
      currentIndex: 0,
      currentName: "작업 준비 중...",
      successCount: 0,
      failureCount: 0,
      isFinished: false,
      isCancelled: false,
      failures: [],
      outputDir,
    });

    const opts: BatchConvertOptions = {
      taskId,
      sourcePaths: targetPaths,
      outputDir,
      format,
      quality,
      resizeMode,
      longEdgePx: resizeMode === "long_edge" ? longEdgePx : undefined,
      percent: resizeMode === "percent" ? percent : undefined,
      maxKbLimit: maxKbLimitEnabled ? maxKb : undefined,
      keepExif,
    };

    try {
      await invoke("start_batch_convert", { opts });
    } catch (err) {
      setIsProcessing(false);
      showToast(`일괄 변환 시작 오류: ${String(err)}`);
    }
  }, [targetPaths, outputDir, format, quality, resizeMode, longEdgePx, percent, maxKbLimitEnabled, maxKb, keepExif, showToast]);

  // 2. 일괄 회전 시작
  const handleStartRotate = useCallback(async () => {
    if (targetPaths.length === 0) return;
    const taskId = `rotate_${Date.now()}`;
    setCurrentTaskId(taskId);
    setIsProcessing(true);
    setProgressPayload({
      taskId,
      total: targetPaths.length,
      currentIndex: 0,
      currentName: "작업 준비 중...",
      successCount: 0,
      failureCount: 0,
      isFinished: false,
      isCancelled: false,
      failures: [],
      outputDir,
    });

    const opts: BatchRotateOptions = {
      taskId,
      sourcePaths: targetPaths,
      outputDir,
      mode: rotateMode,
    };

    try {
      await invoke("start_batch_rotate", { opts });
    } catch (err) {
      setIsProcessing(false);
      showToast(`일괄 회전 시작 오류: ${String(err)}`);
    }
  }, [targetPaths, outputDir, rotateMode, showToast]);

  // 3. 일괄 이름 바꾸기 실행
  const handleExecuteRename = useCallback(async () => {
    setShowRenameConfirm(false);
    if (duplicateNameSet.size > 0) {
      showToast("변경될 파일명에 중복이 있습니다. 규칙을 확인해 주세요.");
      return;
    }

    try {
      const res = await invoke<BatchRenameResult>("execute_batch_rename", {
        items: previewItems,
      });

      if (res.successCount > 0) {
        onUndoAdded();
        onRefreshExplorer();
        showToast(
          `${res.successCount}개 파일 이름이 변경되었습니다. (Ctrl+Z로 한 번에 되돌릴 수 있습니다)`
        );
      }

      if (res.failureCount > 0) {
        showToast(`${res.failureCount}개 파일 이름 변경 실패`);
      }

      onClose();
    } catch (err) {
      showToast(`이름 바꾸기 실패: ${String(err)}`);
    }
  }, [previewItems, duplicateNameSet, onUndoAdded, onRefreshExplorer, showToast, onClose]);

  // 결과 폴더 탐색기로 열기
  const handleOpenOutputDir = useCallback(async () => {
    if (!outputDir) return;
    try {
      await invoke("show_in_folder", { path: outputDir });
    } catch (err) {
      showToast(`폴더 열기 실패: ${String(err)}`);
    }
  }, [outputDir, showToast]);

  return (
    <div className="batch-modal-overlay" onClick={onClose}>
      <div className="batch-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* 모달 상단 헤더 */}
        <div className="batch-modal-header">
          <div className="batch-header-title-row">
            <span className="batch-title-badge">14단계 B</span>
            <h2 className="batch-header-title">일괄 작업 ({targetPaths.length}개 파일 선택됨)</h2>
          </div>
          <button className="batch-close-btn" onClick={onClose} title="닫기 (Escape)">
            <X size={18} />
          </button>
        </div>

        {/* 모드 전환 탭 */}
        {!isProcessing && !progressPayload?.isFinished && (
          <div className="batch-tab-bar">
            <button
              className={`batch-tab-btn ${mode === "convert" ? "active" : ""}`}
              onClick={() => setMode("convert")}
            >
              <Sliders size={16} />
              <span>크기 조정·변환</span>
            </button>
            <button
              className={`batch-tab-btn ${mode === "rename" ? "active" : ""}`}
              onClick={() => setMode("rename")}
            >
              <FileEdit size={16} />
              <span>이름 바꾸기</span>
            </button>
            <button
              className={`batch-tab-btn ${mode === "rotate" ? "active" : ""}`}
              onClick={() => setMode("rotate")}
            >
              <RotateCw size={16} />
              <span>일괄 회전</span>
            </button>
          </div>
        )}

        {/* 메인 본문 영역 */}
        <div className="batch-modal-body">
          {/* A. 진행 중 또는 완료 화면 */}
          {(isProcessing || progressPayload) ? (
            <div className="batch-progress-view">
              <div className="batch-progress-header">
                {progressPayload?.isFinished ? (
                  progressPayload.isCancelled ? (
                    <div className="progress-status-title cancelled">
                      <StopCircle size={22} />
                      <span>작업이 취소되었습니다. (이미 처리된 파일은 유지됩니다)</span>
                    </div>
                  ) : (
                    <div className="progress-status-title success">
                      <CheckCircle2 size={22} />
                      <span>모든 일괄 작업이 완료되었습니다!</span>
                    </div>
                  )
                ) : (
                  <div className="progress-status-title processing">
                    <span className="spinner-icon" />
                    <span>
                      {isCancelling ? "취소 처리 중..." : "백그라운드 일괄 처리 중..."}
                    </span>
                  </div>
                )}
              </div>

              {/* 진행률 바 */}
              <div className="batch-progress-bar-wrapper">
                {(() => {
                  const total = progressPayload?.total || targetPaths.length;
                  const current = (progressPayload?.successCount || 0) + (progressPayload?.failureCount || 0);
                  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
                  return (
                    <>
                      <div className="batch-progress-track">
                        <div
                          className="batch-progress-fill"
                          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                        />
                      </div>
                      <div className="batch-progress-info-row">
                        <span>진행률: <strong>{pct}%</strong></span>
                        <span>
                          처리: <strong>{current} / {total}개</strong> (남은 개수: {Math.max(0, total - current)}개)
                        </span>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* 현재 처리 중인 파일 */}
              {!progressPayload?.isFinished && progressPayload?.currentName && (
                <div className="batch-current-file">
                  <span className="current-file-label">현재 처리:</span>
                  <span className="current-file-name" title={progressPayload.currentName}>
                    {progressPayload.currentName}
                  </span>
                </div>
              )}

              {/* 성공/실패 카운트 */}
              <div className="batch-stats-cards">
                <div className="stat-card success">
                  <Check size={16} />
                  <span>성공: <strong>{progressPayload?.successCount || 0}개</strong></span>
                </div>
                <div className="stat-card failure">
                  <XCircle size={16} />
                  <span>실패: <strong>{progressPayload?.failureCount || 0}개</strong></span>
                </div>
              </div>

              {/* 실패 목록이 있는 경우 */}
              {progressPayload?.failures && progressPayload.failures.length > 0 && (
                <div className="batch-failures-box">
                  <h4 className="failures-title">
                    <AlertTriangle size={15} />
                    <span>실패한 파일 목록 ({progressPayload.failures.length}건)</span>
                  </h4>
                  <div className="failures-scroll-list">
                    {progressPayload.failures.map((f, idx) => (
                      <div key={idx} className="failure-item">
                        <span className="failure-path">{f.path}</span>
                        <span className="failure-error">{f.error}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 저장 폴더 안내 */}
              <div className="batch-result-dir-info">
                <span>저장 폴더:</span>
                <code>{outputDir}</code>
              </div>
            </div>
          ) : (
            <>
              {/* B. 탭 1: 크기 조정·변환 모드 */}
              {mode === "convert" && (
                <div className="batch-form-view">
                  {/* 크기 설정 섹션 */}
                  <div className="batch-section">
                    <label className="batch-section-label">1. 크기 조정 (해상도)</label>
                    <div className="batch-radio-group">
                      <label className="batch-radio-item">
                        <input
                          type="radio"
                          name="resizeMode"
                          checked={resizeMode === "none"}
                          onChange={() => setResizeMode("none")}
                        />
                        <span>원본 크기 유지</span>
                      </label>
                      <label className="batch-radio-item">
                        <input
                          type="radio"
                          name="resizeMode"
                          checked={resizeMode === "long_edge"}
                          onChange={() => setResizeMode("long_edge")}
                        />
                        <span>긴 변 기준 (px)</span>
                      </label>
                      <label className="batch-radio-item">
                        <input
                          type="radio"
                          name="resizeMode"
                          checked={resizeMode === "percent"}
                          onChange={() => setResizeMode("percent")}
                        />
                        <span>비율 (%)</span>
                      </label>
                    </div>

                    {resizeMode === "long_edge" && (
                      <div className="batch-sub-row">
                        <div className="batch-input-with-unit">
                          <input
                            type="number"
                            min={100}
                            max={10000}
                            step={10}
                            value={longEdgePx}
                            onChange={(e) => setLongEdgePx(Math.max(100, Number(e.target.value) || 1280))}
                          />
                          <span className="unit">px</span>
                        </div>
                        <div className="quick-buttons">
                          <button
                            type="button"
                            className={`btn-quick ${longEdgePx === 1920 ? "active" : ""}`}
                            onClick={() => setLongEdgePx(1920)}
                          >
                            1920 (FHD)
                          </button>
                          <button
                            type="button"
                            className={`btn-quick ${longEdgePx === 1280 ? "active" : ""}`}
                            onClick={() => setLongEdgePx(1280)}
                          >
                            1280 (HD)
                          </button>
                          <button
                            type="button"
                            className={`btn-quick ${longEdgePx === 800 ? "active" : ""}`}
                            onClick={() => setLongEdgePx(800)}
                          >
                            800 (웹/모바일)
                          </button>
                        </div>
                      </div>
                    )}

                    {resizeMode === "percent" && (
                      <div className="batch-sub-row">
                        <div className="batch-input-with-unit">
                          <input
                            type="number"
                            min={5}
                            max={500}
                            value={percent}
                            onChange={(e) => setPercent(Math.max(5, Number(e.target.value) || 50))}
                          />
                          <span className="unit">%</span>
                        </div>
                        <div className="quick-buttons">
                          <button
                            type="button"
                            className={`btn-quick ${percent === 25 ? "active" : ""}`}
                            onClick={() => setPercent(25)}
                          >
                            25%
                          </button>
                          <button
                            type="button"
                            className={`btn-quick ${percent === 50 ? "active" : ""}`}
                            onClick={() => setPercent(50)}
                          >
                            50%
                          </button>
                          <button
                            type="button"
                            className={`btn-quick ${percent === 75 ? "active" : ""}`}
                            onClick={() => setPercent(75)}
                          >
                            75%
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 형식 및 품질 설정 */}
                  <div className="batch-section">
                    <label className="batch-section-label">2. 파일 형식 및 품질</label>
                    <div className="batch-format-row">
                      <div className="format-selector">
                        {(["jpg", "png", "webp"] as const).map((fmt) => (
                          <button
                            key={fmt}
                            type="button"
                            className={`btn-fmt ${format === fmt ? "active" : ""}`}
                            onClick={() => setFormat(fmt)}
                          >
                            {fmt.toUpperCase()}
                          </button>
                        ))}
                      </div>

                      {format !== "png" && (
                        <div className="quality-slider-group">
                          <span className="slider-label">품질: {quality}%</span>
                          <input
                            type="range"
                            min={10}
                            max={100}
                            value={quality}
                            onChange={(e) => setQuality(Number(e.target.value))}
                          />
                        </div>
                      )}
                    </div>

                    {/* 최대 용량 KB 이하 제한 옵션 */}
                    <div className="batch-checkbox-row" style={{ marginTop: "12px" }}>
                      <label className="checkbox-container">
                        <input
                          type="checkbox"
                          checked={maxKbLimitEnabled}
                          onChange={(e) => setMaxKbLimitEnabled(e.target.checked)}
                        />
                        <span className="checkbox-text">
                          최대 용량
                          <input
                            type="number"
                            className="inline-kb-input"
                            min={20}
                            max={50000}
                            step={50}
                            value={maxKb}
                            disabled={!maxKbLimitEnabled}
                            onChange={(e) => setMaxKb(Math.max(20, Number(e.target.value) || 500))}
                            onClick={(e) => e.stopPropagation()}
                          />
                          KB 이하로 자동 압축 (업무 시스템 업로드 용량 제한 대비)
                        </span>
                      </label>
                    </div>

                    {/* EXIF 메타데이터 유지 옵션 */}
                    <div className="batch-checkbox-row" style={{ marginTop: "6px" }}>
                      <label className="checkbox-container">
                        <input
                          type="checkbox"
                          checked={keepExif}
                          onChange={(e) => setKeepExif(e.target.checked)}
                        />
                        <span className="checkbox-text">EXIF 메타데이터 유지 (체크 해제 시 촬영 정보 제거로 용량 절감)</span>
                      </label>
                    </div>
                  </div>

                  {/* 저장 위치 설정 */}
                  <div className="batch-section">
                    <label className="batch-section-label">3. 저장 위치 (새 폴더에 사본 저장)</label>
                    <div className="batch-dir-row">
                      <input
                        type="text"
                        className="batch-dir-input"
                        value={outputDir}
                        onChange={(e) => setOutputDir(e.target.value)}
                      />
                      <button type="button" className="btn-dir-select" onClick={handleSelectOutputDir}>
                        <FolderOpen size={16} />
                        <span>폴더 변경...</span>
                      </button>
                    </div>
                    <p className="batch-hint">원본 파일은 안전하게 유지되며, 지정한 결과 폴더에 변환된 사본이 저장됩니다.</p>
                  </div>
                </div>
              )}

              {/* C. 탭 2: 이름 바꾸기 모드 */}
              {mode === "rename" && (
                <div className="batch-form-view">
                  <div className="batch-section">
                    <div className="rename-mode-tabs">
                      <button
                        type="button"
                        className={`btn-subtab ${renameRuleMode === "rule" ? "active" : ""}`}
                        onClick={() => setRenameRuleMode("rule")}
                      >
                        규칙 번호 매기기 (접두어 + 번호 + 접미어)
                      </button>
                      <button
                        type="button"
                        className={`btn-subtab ${renameRuleMode === "date" ? "active" : ""}`}
                        onClick={() => setRenameRuleMode("date")}
                      >
                        촬영 날짜(EXIF) 기반 ("2026-10-21_001")
                      </button>
                    </div>

                    {renameRuleMode === "rule" ? (
                      <div className="rule-inputs-grid">
                        <div className="input-field">
                          <label>접두어 (앞에 붙을 말)</label>
                          <input
                            type="text"
                            value={prefix}
                            placeholder="예: 사진_"
                            onChange={(e) => setPrefix(e.target.value)}
                          />
                        </div>
                        <div className="input-field">
                          <label>시작 번호</label>
                          <input
                            type="number"
                            min={0}
                            value={startNum}
                            onChange={(e) => setStartNum(Number(e.target.value) || 1)}
                          />
                        </div>
                        <div className="input-field">
                          <label>번호 자릿수</label>
                          <select value={digits} onChange={(e) => setDigits(Number(e.target.value))}>
                            <option value={1}>1자리 (1, 2, 3...)</option>
                            <option value={2}>2자리 (01, 02...)</option>
                            <option value={3}>3자리 (001, 002...)</option>
                            <option value={4}>4자리 (0001, 0002...)</option>
                          </select>
                        </div>
                        <div className="input-field">
                          <label>접미어 (뒤에 붙을 말)</label>
                          <input
                            type="text"
                            value={suffix}
                            placeholder="예: _수정"
                            onChange={(e) => setSuffix(e.target.value)}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="rule-inputs-grid">
                        <div className="input-field">
                          <label>날짜 구분자</label>
                          <select value={dateSeparator} onChange={(e) => setDateSeparator(e.target.value)}>
                            <option value="-">하이픈 (2026-10-21)</option>
                            <option value="_">밑줄 (2026_10_21)</option>
                            <option value=".">점 (2026.10.21)</option>
                          </select>
                        </div>
                        <div className="input-field">
                          <label>시작 번호</label>
                          <input
                            type="number"
                            min={0}
                            value={startNum}
                            onChange={(e) => setStartNum(Number(e.target.value) || 1)}
                          />
                        </div>
                        <div className="input-field">
                          <label>번호 자릿수</label>
                          <select value={digits} onChange={(e) => setDigits(Number(e.target.value))}>
                            <option value={3}>3자리 (001, 002...)</option>
                            <option value={4}>4자리 (0001, 0002...)</option>
                            <option value={2}>2자리 (01, 02...)</option>
                          </select>
                        </div>
                        <div className="input-field">
                          <label>설명</label>
                          <div style={{ fontSize: "11px", color: "var(--fg-dim)", paddingTop: "8px" }}>
                            {isLoadingDates ? "EXIF 날짜 추출 중..." : "사진 메타데이터에 기록된 촬영 일자 기준 자동 생성"}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* "바뀌기 전 → 바뀐 후" 미리보기 표 */}
                  <div className="batch-section" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                    <div className="preview-table-header">
                      <span>실시간 미리보기 표 ({previewItems.length}개)</span>
                      {duplicateNameSet.size > 0 && (
                        <span className="warning-text">
                          <AlertTriangle size={14} /> 중복된 이름이 있습니다!
                        </span>
                      )}
                    </div>
                    <div className="preview-table-wrapper">
                      <table className="preview-table">
                        <thead>
                          <tr>
                            <th style={{ width: "40px" }}>#</th>
                            <th>바뀌기 전 (현재 파일명)</th>
                            <th style={{ width: "30px", textAlign: "center" }}>➔</th>
                            <th>바뀐 후 (새 파일명)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {previewItems.map((item, idx) => {
                            const lastSlash = Math.max(item.oldPath.lastIndexOf("/"), item.oldPath.lastIndexOf("\\"));
                            const curName = lastSlash >= 0 ? item.oldPath.substring(lastSlash + 1) : item.oldPath;
                            const isDupe = duplicateNameSet.has(item.newName.toLowerCase());
                            return (
                              <tr key={idx} className={isDupe ? "row-error" : ""}>
                                <td style={{ color: "var(--fg-dim)" }}>{idx + 1}</td>
                                <td className="orig-cell" title={curName}>{curName}</td>
                                <td style={{ textAlign: "center", color: "var(--accent)" }}>➔</td>
                                <td className="new-cell" title={item.newName}>
                                  <strong>{item.newName}</strong>
                                  {isDupe && <span className="dupe-badge">중복</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="batch-hint warning" style={{ marginTop: "8px" }}>
                      ⚠️ 이름 바꾸기는 <strong>원본 파일의 이름을 직접 변경</strong>합니다. 완료 후 <strong>Ctrl+Z</strong>를 누르면 한 번에 원래 이름으로 되돌릴 수 있습니다.
                    </p>
                  </div>
                </div>
              )}

              {/* D. 탭 3: 일괄 회전 모드 */}
              {mode === "rotate" && (
                <div className="batch-form-view">
                  <div className="batch-section">
                    <label className="batch-section-label">1. 회전 방식 선택</label>
                    <div className="rotate-modes-list">
                      <label className={`rotate-option-card ${rotateMode === "exif_auto" ? "active" : ""}`}>
                        <input
                          type="radio"
                          name="rotateMode"
                          checked={rotateMode === "exif_auto"}
                          onChange={() => setRotateMode("exif_auto")}
                        />
                        <div className="rotate-option-content">
                          <div className="option-title-row">
                            <Sparkles size={17} style={{ color: "#3b82f6" }} />
                            <strong>EXIF 방향대로 바로잡기 (자동 회전 추천)</strong>
                          </div>
                          <p>카메라나 스마트폰이 사진에 기록한 EXIF 회전 센서값을 읽어, 비뚤어진 사진만 자동으로 올바른 정방향으로 회전합니다.</p>
                        </div>
                      </label>

                      <label className={`rotate-option-card ${rotateMode === "rotate90" ? "active" : ""}`}>
                        <input
                          type="radio"
                          name="rotateMode"
                          checked={rotateMode === "rotate90"}
                          onChange={() => setRotateMode("rotate90")}
                        />
                        <div className="rotate-option-content">
                          <div className="option-title-row">
                            <RotateCw size={17} />
                            <strong>시계 방향 90° 회전 (오른쪽으로 돌리기)</strong>
                          </div>
                          <p>선택한 모든 사진을 시계 방향으로 90도 회전하여 사본으로 저장합니다.</p>
                        </div>
                      </label>

                      <label className={`rotate-option-card ${rotateMode === "rotate270" ? "active" : ""}`}>
                        <input
                          type="radio"
                          name="rotateMode"
                          checked={rotateMode === "rotate270"}
                          onChange={() => setRotateMode("rotate270")}
                        />
                        <div className="rotate-option-content">
                          <div className="option-title-row">
                            <RotateCcw size={17} />
                            <strong>반시계 방향 90° 회전 (왼쪽으로 돌리기)</strong>
                          </div>
                          <p>선택한 모든 사진을 반시계 방향으로 90도 회전하여 사본으로 저장합니다.</p>
                        </div>
                      </label>

                      <label className={`rotate-option-card ${rotateMode === "rotate180" ? "active" : ""}`}>
                        <input
                          type="radio"
                          name="rotateMode"
                          checked={rotateMode === "rotate180"}
                          onChange={() => setRotateMode("rotate180")}
                        />
                        <div className="rotate-option-content">
                          <div className="option-title-row">
                            <RotateCw size={17} />
                            <strong>180° 상하 반전 회전</strong>
                          </div>
                          <p>선택한 모든 사진을 위아래 180도 회전하여 사본으로 저장합니다.</p>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* 저장 위치 */}
                  <div className="batch-section">
                    <label className="batch-section-label">2. 저장 위치 (새 폴더에 사본 저장)</label>
                    <div className="batch-dir-row">
                      <input
                        type="text"
                        className="batch-dir-input"
                        value={outputDir}
                        onChange={(e) => setOutputDir(e.target.value)}
                      />
                      <button type="button" className="btn-dir-select" onClick={handleSelectOutputDir}>
                        <FolderOpen size={16} />
                        <span>폴더 변경...</span>
                      </button>
                    </div>
                    <p className="batch-hint">원본 파일은 손상되지 않으며, 회전된 사진이 결과 폴더에 사본으로 저장됩니다.</p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* 모달 하단 액션 버튼 바 */}
        <div className="batch-modal-footer">
          {progressPayload?.isFinished ? (
            <div className="footer-finished-actions">
              <button type="button" className="btn-secondary" onClick={handleOpenOutputDir}>
                <FolderOpen size={16} />
                <span>결과 폴더 열기</span>
              </button>
              <button type="button" className="btn-primary" onClick={onClose}>
                <span>확인 / 닫기</span>
              </button>
            </div>
          ) : isProcessing ? (
            <div className="footer-processing-actions">
              <button
                type="button"
                className="btn-danger-cancel"
                disabled={isCancelling}
                onClick={handleCancelTask}
              >
                <StopCircle size={16} />
                <span>{isCancelling ? "취소 중..." : "작업 취소"}</span>
              </button>
            </div>
          ) : (
            <div className="footer-ready-actions">
              <button type="button" className="btn-secondary" onClick={onClose}>
                취소
              </button>
              {mode === "convert" && (
                <button type="button" className="btn-primary" onClick={handleStartConvert}>
                  <Play size={16} />
                  <span>일괄 변환 시작 ({targetPaths.length}개)</span>
                </button>
              )}
              {mode === "rename" && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={duplicateNameSet.size > 0}
                  onClick={() => setShowRenameConfirm(true)}
                >
                  <FileEdit size={16} />
                  <span>이름 바꾸기 적용 ({targetPaths.length}개)</span>
                </button>
              )}
              {mode === "rotate" && (
                <button type="button" className="btn-primary" onClick={handleStartRotate}>
                  <RotateCw size={16} />
                  <span>일괄 회전 시작 ({targetPaths.length}개)</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 이름 바꾸기 최종 확인 모달 */}
      {showRenameConfirm && (
        <div className="batch-confirm-overlay" onClick={() => setShowRenameConfirm(false)}>
          <div className="batch-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-icon-row">
              <AlertTriangle size={32} style={{ color: "#f59e0b" }} />
              <h3>일괄 이름 바꾸기를 실행하시겠습니까?</h3>
            </div>
            <p className="confirm-desc">
              선택한 <strong>{targetPaths.length}개</strong> 원본 파일의 이름이 즉시 변경됩니다.
              <br />
              (실행 후 마음에 들지 않으면 <strong>Ctrl+Z</strong>를 눌러 언제든 원래 이름으로 되돌릴 수 있습니다.)
            </p>
            <div className="confirm-buttons">
              <button type="button" className="btn-secondary" onClick={() => setShowRenameConfirm(false)}>
                취소
              </button>
              <button type="button" className="btn-primary-danger" onClick={handleExecuteRename}>
                이름 변경 실행
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
