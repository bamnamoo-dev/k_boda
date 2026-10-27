import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  IdPhotoPreset,
  IdPhotoValidationResult,
  DEFAULT_PRESETS,
} from "./idPhotoTypes";
import { detectFaceOffline } from "./faceDetection";
import {
  X,
  RotateCw,
  RotateCcw,
  Sparkles,
  Grid,
  Save,
  Printer,
  ChevronRight,
  ChevronLeft,
  Settings,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import "./IdPhotoEditor.css";

interface IdPhotoEditorProps {
  initialPaths: string[]; // 편집 대상 사진 목록 (1장 또는 탐색기 다중 선택)
  onClose: () => void;
  showToast: (msg: string) => void;
  initialSaveDir?: string | null;
  onUpdateSaveDir?: (dir: string) => void;
}

export const IdPhotoEditor: React.FC<IdPhotoEditorProps> = ({
  initialPaths,
  onClose,
  showToast,
  initialSaveDir,
  onUpdateSaveDir,
}) => {
  const [filePaths] = useState<string[]>(initialPaths.length > 0 ? initialPaths : []);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const currentPath = filePaths[currentIndex] || "";

  // 프리셋 목록
  const [presets, setPresets] = useState<IdPhotoPreset[]>(DEFAULT_PRESETS);
  const [currentPresetId, setCurrentPresetId] = useState<string>("civil_service");
  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === currentPresetId) || presets[0] || DEFAULT_PRESETS[0],
    [presets, currentPresetId]
  );

  // 저장 폴더 및 파일명 이름 입력칸
  const [saveDir, setSaveDir] = useState<string>(initialSaveDir || "");
  const [nameInput, setNameInput] = useState<string>("");

  // 자르기 조작 상태: scale, panX, panY, rotation (-10 ~ +10도)
  const [scale, setScale] = useState<number>(1.0);
  const [panX, setPanX] = useState<number>(0);
  const [panY, setPanY] = useState<number>(0);
  const [rotationDeg, setRotationDeg] = useState<number>(0);

  // 간단 보정 상태
  const [brightness, setBrightness] = useState<number>(0); // -50 ~ +50
  const [contrast, setContrast] = useState<number>(0); // -50 ~ +50
  const [saturation, setSaturation] = useState<number>(0); // -50 ~ +50

  // 가이드선 토글
  const [showGuides, setShowGuides] = useState<boolean>(true);

  // 저장 검증 상태
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [lastValidation, setLastValidation] = useState<IdPhotoValidationResult | null>(null);

  // 인화지 배치 모달
  const [printSheetModalOpen, setPrintSheetModalOpen] = useState<boolean>(false);
  const [printSheetPath, setPrintSheetPath] = useState<string | null>(null);
  const [isGeneratingSheet, setIsGeneratingSheet] = useState<boolean>(false);

  // 프리셋 관리 모달
  const [presetModalOpen, setPresetModalOpen] = useState<boolean>(false);

  // 뷰포트 및 이미지 참조
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgNaturalSize, setImgNaturalSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  // 드래그 상태 관리
  const isDraggingRef = useRef<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number }>({
    x: 0,
    y: 0,
    panX: 0,
    panY: 0,
  });

  // 1. 프리셋 로드
  useEffect(() => {
    invoke<IdPhotoPreset[]>("load_id_photo_presets")
      .then((loaded) => {
        if (loaded && loaded.length > 0) {
          setPresets(loaded);
        }
      })
      .catch(() => {
        setPresets(DEFAULT_PRESETS);
      });
  }, []);

  // 화면상 고정된 자르기 틀의 픽셀 크기 (3:4 비율, 뷰포트 크기에 맞춰 약 354x472px 또는 비례 확대)
  const [cropBoxSize, setCropBoxSize] = useState<{ width: number; height: number }>({
    width: 354,
    height: 472,
  });

  // 뷰포트 크기 변화에 따라 틀 크기 계산 (화면 중앙에 적절한 크기로 배치)
  const updateCropBoxSize = useCallback(() => {
    if (!viewportRef.current) return;
    const vpRect = viewportRef.current.getBoundingClientRect();
    const padding = 60;
    const availW = vpRect.width - padding * 2;
    const availH = vpRect.height - padding * 2;

    const targetRatio = selectedPreset.widthPx / selectedPreset.heightPx;
    let boxW = availW;
    let boxH = boxW / targetRatio;

    if (boxH > availH) {
      boxH = availH;
      boxW = boxH * targetRatio;
    }

    // 기본적으로 공무원증 기준 354x472 이상, 화면이 크면 최대 500x667 내외로 렌더링
    boxW = Math.max(280, Math.min(boxW, 520));
    boxH = boxW / targetRatio;

    setCropBoxSize({ width: Math.round(boxW), height: Math.round(boxH) });
  }, [selectedPreset]);

  useEffect(() => {
    updateCropBoxSize();
    window.addEventListener("resize", updateCropBoxSize);
    return () => window.removeEventListener("resize", updateCropBoxSize);
  }, [updateCropBoxSize]);

  // ★ 빈 공간(여백) 방지 Clamp 수학 공식 함수
  const clampTransform = useCallback(
    (
      targetScale: number,
      targetPanX: number,
      targetPanY: number,
      rotDeg: number,
      boxW: number,
      boxH: number,
      natW: number,
      natH: number
    ) => {
      if (natW <= 0 || natH <= 0 || boxW <= 0 || boxH <= 0) {
        return { scale: targetScale, panX: targetPanX, panY: targetPanY };
      }

      const theta = (rotDeg * Math.PI) / 180.0;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const absCos = Math.abs(cosT);
      const absSin = Math.abs(sinT);

      // 틀의 코너가 사진 로컬 좌표계에서 차지하는 최대 반경
      const uMax = (boxW / 2) * absCos + (boxH / 2) * absSin;
      const vMax = (boxW / 2) * absSin + (boxH / 2) * absCos;

      // 틀을 완전히 덮기 위해 필요한 최소 스케일
      const minScale = Math.max((2 * uMax) / natW, (2 * vMax) / natH);
      const clampedScale = Math.max(targetScale, minScale);

      // 사진 로컬 회전 좌표계에서의 이동량 du, dv
      const du = targetPanX * cosT + targetPanY * sinT;
      const dv = -targetPanX * sinT + targetPanY * cosT;

      const maxDu = Math.max(0, (natW * clampedScale) / 2 - uMax);
      const maxDv = Math.max(0, (natH * clampedScale) / 2 - vMax);

      const clampedDu = Math.max(-maxDu, Math.min(maxDu, du));
      const clampedDv = Math.max(-maxDv, Math.min(maxDv, dv));

      // 다시 화면 좌표계(dx, dy)로 역변환
      const clampedPanX = clampedDu * cosT - clampedDv * sinT;
      const clampedPanY = clampedDu * sinT + clampedDv * cosT;

      return {
        scale: clampedScale,
        panX: clampedPanX,
        panY: clampedPanY,
      };
    },
    []
  );

  // 얼굴 자동 맞춤 실행 함수
  const handleAutoFitFace = useCallback(async () => {
    if (!imgRef.current || imgNaturalSize.width <= 0) return;

    try {
      showToast("얼굴 감지 중...");
      const { face, isFallback } = await detectFaceOffline(imgRef.current);

      if (face) {
        const { width: boxW, height: boxH } = cropBoxSize;
        const natW = imgNaturalSize.width;
        const natH = imgNaturalSize.height;

        // 프리셋 가이드 타원 중심 및 크기 목표
        const crownRatio = selectedPreset.guide.crownPercent / 100;
        const chinRatio = selectedPreset.guide.chinPercent / 100;
        const targetOvalH = (chinRatio - crownRatio) * boxH;
        const targetCenterY = ((crownRatio + chinRatio) / 2) * boxH;

        // 얼굴 높이에 맞춘 줌 스케일
        const faceH = Math.max(30, face.height);
        let desiredScale = targetOvalH / (faceH * 1.15);

        // 얼굴 중심을 틀의 가이드선 타원 중심으로 배치
        const faceCenterX = face.x + face.width / 2;
        const faceCenterY = face.y + face.height / 2;

        const desiredPanX = (natW / 2 - faceCenterX) * desiredScale;
        const desiredPanY = (natH / 2 - faceCenterY) * desiredScale + (targetCenterY - boxH / 2);

        // 여백 방지 clamp 적용
        const clamped = clampTransform(
          desiredScale,
          desiredPanX,
          desiredPanY,
          0,
          boxW,
          boxH,
          natW,
          natH
        );

        setScale(clamped.scale);
        setPanX(clamped.panX);
        setPanY(clamped.panY);
        setRotationDeg(0);
        if (isFallback) {
          showToast("자동 인식 정확도가 낮습니다. 직접 확인하세요.");
        } else {
          showToast("✔ 얼굴 자동 맞춤 완료");
        }
      } else {
        // 얼굴 미검출 시 기본 틀 맞춤
        showToast("얼굴을 찾을 수 없습니다. 수동으로 조절해 주세요.");
        const { width: boxW, height: boxH } = cropBoxSize;
        const initialScale = Math.max(boxW / imgNaturalSize.width, boxH / imgNaturalSize.height);
        const clamped = clampTransform(
          initialScale,
          0,
          0,
          0,
          boxW,
          boxH,
          imgNaturalSize.width,
          imgNaturalSize.height
        );
        setScale(clamped.scale);
        setPanX(clamped.panX);
        setPanY(clamped.panY);
      }
    } catch {
      showToast("얼굴 분석 중 오류가 발생했습니다.");
    }
  }, [cropBoxSize, imgNaturalSize, selectedPreset, clampTransform, showToast]);

  // 이미지 로드 완료 시
  const onImageLoad = useCallback(() => {
    if (!imgRef.current) return;
    const w = imgRef.current.naturalWidth;
    const h = imgRef.current.naturalHeight;
    setImgNaturalSize({ width: w, height: h });

    // 열자마자 얼굴 자동 맞춤 바로 적용!
    setTimeout(() => {
      handleAutoFitFace();
    }, 50);
  }, [handleAutoFitFace]);

  // 마우스 드래그 패닝
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // 좌클릭만
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

    const newPanX = dragStartRef.current.panX + dx;
    const newPanY = dragStartRef.current.panY + dy;

    const clamped = clampTransform(
      scale,
      newPanX,
      newPanY,
      rotationDeg,
      cropBoxSize.width,
      cropBoxSize.height,
      imgNaturalSize.width,
      imgNaturalSize.height
    );

    setPanX(clamped.panX);
    setPanY(clamped.panY);
  };

  const onMouseUp = () => {
    isDraggingRef.current = false;
  };

  // 마우스 휠 줌
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.05 : 0.95;
    const newScale = Math.min(8.0, Math.max(0.05, scale * factor));

    const clamped = clampTransform(
      newScale,
      panX,
      panY,
      rotationDeg,
      cropBoxSize.width,
      cropBoxSize.height,
      imgNaturalSize.width,
      imgNaturalSize.height
    );

    setScale(clamped.scale);
    setPanX(clamped.panX);
    setPanY(clamped.panY);
  };

  // 회전 슬라이더 변경 시
  const handleRotationChange = (deg: number) => {
    setRotationDeg(deg);
    const clamped = clampTransform(
      scale,
      panX,
      panY,
      deg,
      cropBoxSize.width,
      cropBoxSize.height,
      imgNaturalSize.width,
      imgNaturalSize.height
    );
    setScale(clamped.scale);
    setPanX(clamped.panX);
    setPanY(clamped.panY);
  };

  // 줌 슬라이더 변경 시
  const handleZoomSliderChange = (newScale: number) => {
    const clamped = clampTransform(
      newScale,
      panX,
      panY,
      rotationDeg,
      cropBoxSize.width,
      cropBoxSize.height,
      imgNaturalSize.width,
      imgNaturalSize.height
    );
    setScale(clamped.scale);
    setPanX(clamped.panX);
    setPanY(clamped.panY);
  };

  // 보정 원래대로 리셋
  const handleResetAdjustments = () => {
    setBrightness(0);
    setContrast(0);
    setSaturation(0);
    setRotationDeg(0);
    handleAutoFitFace();
  };

  // 원본 해상도 검사: 틀에 매핑된 실제 원본 영역이 규격보다 작은가?
  const cropOrigW = scale > 0 ? cropBoxSize.width / scale : 0;
  const cropOrigH = scale > 0 ? cropBoxSize.height / scale : 0;
  const isResolutionLow =
    cropOrigW > 0 &&
    (cropOrigW < selectedPreset.widthPx || cropOrigH < selectedPreset.heightPx);

  // 저장 파일명 결정
  const currentFileName = useMemo(() => {
    const p = currentPath.replace(/\\/g, "/");
    const lastSlash = p.lastIndexOf("/");
    const fullName = lastSlash >= 0 ? p.substring(lastSlash + 1) : p;
    const dotIdx = fullName.lastIndexOf(".");
    return dotIdx >= 0 ? fullName.substring(0, dotIdx) : fullName;
  }, [currentPath]);

  const outputFileName = useMemo(() => {
    const stem = nameInput.trim() ? nameInput.trim() : currentFileName;
    return `${stem}_${selectedPreset.name}.jpg`;
  }, [nameInput, currentFileName, selectedPreset]);

  // 저장 폴더 선택 다이얼로그
  const handleSelectSaveDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "증명사진 저장 폴더 선택",
      });
      if (typeof selected === "string") {
        setSaveDir(selected);
        onUpdateSaveDir?.(selected);
      }
    } catch {
      // 취소됨
    }
  };

  // 저장 실행
  const handleSave = async () => {
    if (!currentPath || isSaving) return;
    setIsSaving(true);
    setLastValidation(null);

    try {
      // 대상 저장 폴더 결정
      let finalDir = saveDir;
      if (!finalDir) {
        // 원본 폴더를 기본으로 사용
        const p = currentPath.replace(/\\/g, "/");
        const lastSlash = p.lastIndexOf("/");
        finalDir = lastSlash >= 0 ? p.substring(0, lastSlash) : "";
      }

      let targetPath = "";
      if (finalDir) {
        targetPath = `${finalDir.replace(/\\/g, "/")}/${outputFileName}`;
      } else {
        const dialogRes = await save({
          defaultPath: outputFileName,
          filters: [{ name: "JPEG Image", extensions: ["jpg"] }],
        });
        if (!dialogRes) {
          setIsSaving(false);
          return;
        }
        targetPath = dialogRes;
      }

      // 틀 중심을 원본 이미지 픽셀 좌표계로 역변환
      const natW = imgNaturalSize.width;
      const natH = imgNaturalSize.height;

      // 사진 중심으로부터 틀 중심까지의 오프셋 (화면 픽셀): (-panX, -panY)
      const cropCenterX = natW / 2 - panX / scale;
      const cropCenterY = natH / 2 - panY / scale;
      const cropWidthOrig = cropBoxSize.width / scale;
      const cropHeightOrig = cropBoxSize.height / scale;

      const contrastFactor = 1.0 + contrast / 100.0;
      const saturationFactor = 1.0 + saturation / 100.0;

      // Rust invoke 호출: Lanczos3 리사이즈, 메타데이터 제거, 150KB 이하 압축 루프, 저장 후 재검증
      const result = await invoke<IdPhotoValidationResult>("save_id_photo", {
        sourcePath: currentPath,
        targetPath,
        cropCenterX,
        cropCenterY,
        cropWidth: cropWidthOrig,
        cropHeight: cropHeightOrig,
        rotationDeg,
        targetWidth: selectedPreset.widthPx,
        targetHeight: selectedPreset.heightPx,
        brightness,
        contrast: contrastFactor,
        saturation: saturationFactor,
        maxBytes: selectedPreset.maxBytes,
        dpi: selectedPreset.dpi,
      });

      setLastValidation(result);

      if (result.passOfficialSpec) {
        showToast(result.message);

        // 배치 모드(여러 장)인 경우 다음 장으로 자동 이동!
        if (currentIndex < filePaths.length - 1) {
          setTimeout(() => {
            setCurrentIndex((prev) => prev + 1);
            setNameInput("");
            setLastValidation(null);
          }, 350);
        } else if (filePaths.length > 1) {
          showToast("모든 사진의 증명사진 저장이 완료되었습니다!");
        }
      } else {
        showToast(result.message);
      }
    } catch (err) {
      showToast(`저장 실패: ${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  // 인화지 배치 생성
  const handleGeneratePrintSheet = async () => {
    if (!lastValidation?.path && !currentPath) {
      showToast("먼저 사진을 한 번 저장해 주세요.");
      return;
    }
    setIsGeneratingSheet(true);

    try {
      const sourcePhoto = lastValidation?.path || currentPath;
      const outDir = saveDir || (sourcePhoto.replace(/\\/g, "/").substring(0, sourcePhoto.lastIndexOf("/")));
      const sheetTarget = `${outDir}/인화지_4x6_${outputFileName}`;

      const finalPath = await invoke<string>("generate_id_photo_print_sheet", {
        photoPath: sourcePhoto,
        targetPath: sheetTarget,
      });

      setPrintSheetPath(finalPath);
      setPrintSheetModalOpen(true);
      showToast("✔ 4x6인치 300DPI 인화지 배치 생성 완료");
    } catch (err) {
      showToast(`인화지 생성 실패: ${String(err)}`);
    } finally {
      setIsGeneratingSheet(false);
    }
  };

  // 키보드 단축키 처리 (KeyboardEvent.code 기준)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 모달 열림 상태 체크
      if (presetModalOpen || printSheetModalOpen) {
        if (e.code === "Escape") {
          setPresetModalOpen(false);
          setPrintSheetModalOpen(false);
          e.preventDefault();
        }
        return;
      }

      if (e.code === "Escape") {
        onClose();
        e.preventDefault();
      } else if (e.code === "Enter" && !e.shiftKey && !e.ctrlKey) {
        // 엔터 누르면 즉시 저장
        handleSave();
        e.preventDefault();
      } else if (e.code === "KeyG") {
        setShowGuides((prev) => !prev);
      } else if (e.code === "KeyP" && e.ctrlKey) {
        // 인쇄 단축키
        handleGeneratePrintSheet();
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, handleSave, handleGeneratePrintSheet, presetModalOpen, printSheetModalOpen]);

  return (
    <div className="id-photo-overlay" onMouseUp={onMouseUp}>
      {/* 상단 툴바 헤더 */}
      <div className="id-photo-header">
        <div className="id-photo-title-area">
          <span className="id-photo-badge">규격</span>
          <span className="id-photo-title">증명사진 만들기</span>
          {filePaths.length > 1 && (
            <span className="id-photo-batch-badge">
              {currentIndex + 1} / {filePaths.length}
            </span>
          )}
          <span style={{ fontSize: 13, color: "#94a3b8", marginLeft: 4 }}>
            {outputFileName}
          </span>
        </div>

        <div className="id-photo-header-controls">
          {filePaths.length > 1 && (
            <>
              <button
                className="id-photo-btn id-photo-btn-secondary"
                disabled={currentIndex === 0}
                onClick={() => {
                  setCurrentIndex((prev) => prev - 1);
                  setLastValidation(null);
                }}
                title="이전 사진"
              >
                <ChevronLeft size={16} /> 이전
              </button>
              <button
                className="id-photo-btn id-photo-btn-secondary"
                disabled={currentIndex === filePaths.length - 1}
                onClick={() => {
                  setCurrentIndex((prev) => prev + 1);
                  setLastValidation(null);
                }}
                title="다음 사진 건너뛰기"
              >
                다음 <ChevronRight size={16} />
              </button>
            </>
          )}

          <button
            className="id-photo-btn id-photo-btn-secondary"
            onClick={onClose}
            title="닫기 (Escape)"
          >
            <X size={16} /> 뷰어로 복귀 (Esc)
          </button>
        </div>
      </div>

      {/* 메인 편집 영역 */}
      <div className="id-photo-main">
        {/* 중앙 뷰포트 (고정된 틀 & 사진 이동) */}
        <div
          ref={viewportRef}
          className="id-photo-viewport"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onWheel={onWheel}
        >
          {/* 해상도 경고 표시 */}
          {isResolutionLow && (
            <div className="id-photo-res-warning">
              <AlertTriangle size={15} />
              <span>화질이 떨어질 수 있습니다 (출력 규격보다 크게 확대됨)</span>
            </div>
          )}

          {/* 사진 렌더링 래퍼 (미세 회전 & 줌 & 패닝) */}
          <div
            className="id-photo-image-wrapper"
            style={{
              transform: `translate(${panX}px, ${panY}px) rotate(${rotationDeg}deg)`,
            }}
          >
            <img
              ref={imgRef}
              // 얼굴 인식(WebGL)이 asset 이미지 픽셀을 읽을 수 있도록 교차 출처 허용 요청
              crossOrigin="anonymous"
              src={convertFileSrc(currentPath)}
              alt="Source"
              className="id-photo-image"
              style={{
                width: imgNaturalSize.width * scale,
                height: imgNaturalSize.height * scale,
                filter: `brightness(${100 + brightness}%) contrast(${100 + contrast}%) saturate(${100 + saturation}%)`,
              }}
              onLoad={onImageLoad}
              draggable={false}
            />
          </div>

          {/* 어두운 마스크 SVG (틀 바깥 영역을 어둡게 처리) */}
          <svg className="id-photo-mask-svg">
            <defs>
              <mask id="crop-mask">
                <rect width="100%" height="100%" fill="white" />
                <rect
                  x={`calc(50% - ${cropBoxSize.width / 2}px)`}
                  y={`calc(50% - ${cropBoxSize.height / 2}px)`}
                  width={cropBoxSize.width}
                  height={cropBoxSize.height}
                  fill="black"
                />
              </mask>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill="rgba(8, 10, 14, 0.75)"
              mask="url(#crop-mask)"
            />
          </svg>

          {/* 고정된 사각형 자르기 틀 테두리 */}
          <div
            className="id-photo-crop-border"
            style={{
              width: cropBoxSize.width,
              height: cropBoxSize.height,
            }}
          >
            {/* 가이드선 (정수리선, 턱선, 눈높이선, 중심선, 얼굴 타원) */}
            {showGuides && (
              <div className="id-photo-guides">
                {/* 세로 중심선 */}
                <div className="id-photo-guide-line v-center" />

                {/* 정수리선 */}
                <div
                  className="id-photo-guide-line"
                  style={{ top: `${selectedPreset.guide.crownPercent}%` }}
                >
                  <span className="id-photo-guide-label">정수리선</span>
                </div>

                {/* 눈높이선 */}
                <div
                  className="id-photo-guide-line"
                  style={{ top: `${selectedPreset.guide.eyePercent}%` }}
                >
                  <span className="id-photo-guide-label">눈높이선</span>
                </div>

                {/* 턱선 */}
                <div
                  className="id-photo-guide-line"
                  style={{ top: `${selectedPreset.guide.chinPercent}%` }}
                >
                  <span className="id-photo-guide-label">턱선</span>
                </div>

                {/* 얼굴 위치 가이드 타원 */}
                {(() => {
                  const crown = selectedPreset.guide.crownPercent;
                  const chin = selectedPreset.guide.chinPercent;
                  const ovalH = chin - crown;
                  const ovalW = selectedPreset.guide.ovalWidthPercent;
                  const top = crown;
                  const left = (100 - ovalW) / 2;
                  return (
                    <div
                      className="id-photo-guide-oval"
                      style={{
                        top: `${top}%`,
                        left: `${left}%`,
                        width: `${ovalW}%`,
                        height: `${ovalH}%`,
                      }}
                    />
                  );
                })()}
              </div>
            )}
          </div>

          {/* 뷰포트 하단 플로팅 툴바 (줌 슬라이더, 가이드 토글, 얼굴 자동 맞춤) */}
          <div className="id-photo-floating-bar">
            <button
              className={`id-photo-btn ${showGuides ? "id-photo-btn-primary" : "id-photo-btn-secondary"}`}
              onClick={() => setShowGuides(!showGuides)}
              title="가이드선 토글 (G)"
            >
              <Grid size={15} /> 가이드선
            </button>

            <button
              className="id-photo-btn id-photo-btn-secondary"
              onClick={handleAutoFitFace}
              title="PC 안에서 오프라인으로 얼굴을 찾아 틀에 맞춥니다"
            >
              <Sparkles size={15} style={{ color: "#38bdf8" }} /> 얼굴 자동 맞춤
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "#94a3b8" }}>확대/축소</span>
              <input
                type="range"
                min="0.1"
                max="3.0"
                step="0.01"
                value={scale}
                onChange={(e) => handleZoomSliderChange(parseFloat(e.target.value))}
                className="id-photo-slider"
                style={{ width: 110 }}
              />
              <span style={{ fontSize: 11, color: "#cbd5e1", minWidth: 36 }}>
                {Math.round(scale * 100)}%
              </span>
            </div>
          </div>
        </div>

        {/* 우측 조작 및 설정 패널 */}
        <div className="id-photo-sidebar">
          {/* 규격 프리셋 선택 */}
          <div className="id-photo-sidebar-section">
            <div className="id-photo-section-title">
              <span>규격 프리셋</span>
              <button
                className="id-photo-btn id-photo-btn-secondary"
                style={{ padding: "3px 7px", fontSize: 11 }}
                onClick={() => setPresetModalOpen(true)}
              >
                <Settings size={13} /> 관리
              </button>
            </div>

            <select
              value={currentPresetId}
              onChange={(e) => {
                setCurrentPresetId(e.target.value);
                setLastValidation(null);
              }}
              className="id-photo-preset-select"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.widthPx}×{p.heightPx}px)
                </option>
              ))}
            </select>

            <div className="id-photo-preset-desc">
              <div>{selectedPreset.description}</div>
              <div style={{ marginTop: 4, color: "#cbd5e1" }}>
                출력: {selectedPreset.widthPx} × {selectedPreset.heightPx} px (
                {selectedPreset.widthCm}×{selectedPreset.heightCm}cm, {selectedPreset.dpi}DPI)
              </div>
              {selectedPreset.maxBytes && (
                <div style={{ color: "#38bdf8" }}>
                  용량 제한: {selectedPreset.maxBytes / 1000}KB 미만 자동 압축
                </div>
              )}
            </div>
          </div>

          {/* 미세 회전 조절 (-10도 ~ +10도) */}
          <div className="id-photo-sidebar-section">
            <div className="id-photo-section-title">
              <span>수평 미세 회전</span>
              <button
                className="id-photo-btn id-photo-btn-secondary"
                style={{ padding: "2px 6px", fontSize: 11 }}
                onClick={() => handleRotationChange(0)}
              >
                0° 리셋
              </button>
            </div>

            <div className="id-photo-slider-row">
              <div className="id-photo-slider-label">
                <span>기울기 각도</span>
                <span>{rotationDeg.toFixed(1)}°</span>
              </div>
              <input
                type="range"
                min="-10.0"
                max="10.0"
                step="0.1"
                value={rotationDeg}
                onChange={(e) => handleRotationChange(parseFloat(e.target.value))}
                className="id-photo-slider"
              />
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <button
                className="id-photo-btn id-photo-btn-secondary"
                style={{ flex: 1 }}
                onClick={() => handleRotationChange(Math.max(-10, rotationDeg - 0.5))}
              >
                <RotateCcw size={13} /> -0.5°
              </button>
              <button
                className="id-photo-btn id-photo-btn-secondary"
                style={{ flex: 1 }}
                onClick={() => handleRotationChange(Math.min(10, rotationDeg + 0.5))}
              >
                <RotateCw size={13} /> +0.5°
              </button>
            </div>
          </div>

          {/* 간단 보정 (밝기, 대비, 채도) */}
          <div className="id-photo-sidebar-section">
            <div className="id-photo-section-title">
              <span>간단 보정</span>
              <button
                className="id-photo-btn id-photo-btn-secondary"
                style={{ padding: "2px 6px", fontSize: 11 }}
                onClick={handleResetAdjustments}
              >
                <RefreshCw size={12} /> 원래대로
              </button>
            </div>

            <div className="id-photo-slider-row">
              <div className="id-photo-slider-label">
                <span>밝기</span>
                <span>{brightness > 0 ? `+${brightness}` : brightness}</span>
              </div>
              <input
                type="range"
                min="-50"
                max="50"
                step="1"
                value={brightness}
                onChange={(e) => setBrightness(parseInt(e.target.value))}
                className="id-photo-slider"
              />
            </div>

            <div className="id-photo-slider-row">
              <div className="id-photo-slider-label">
                <span>대비</span>
                <span>{contrast > 0 ? `+${contrast}` : contrast}</span>
              </div>
              <input
                type="range"
                min="-50"
                max="50"
                step="1"
                value={contrast}
                onChange={(e) => setContrast(parseInt(e.target.value))}
                className="id-photo-slider"
              />
            </div>

            <div className="id-photo-slider-row">
              <div className="id-photo-slider-label">
                <span>채도</span>
                <span>{saturation > 0 ? `+${saturation}` : saturation}</span>
              </div>
              <input
                type="range"
                min="-50"
                max="50"
                step="1"
                value={saturation}
                onChange={(e) => setSaturation(parseInt(e.target.value))}
                className="id-photo-slider"
              />
            </div>
          </div>

          {/* 저장 설정 & 파일명 */}
          <div className="id-photo-sidebar-section">
            <div className="id-photo-section-title">
              <span>저장 설정</span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, color: "#94a3b8" }}>이름 (선택 입력)</label>
              <input
                type="text"
                placeholder="이름 입력 (예: 홍길동)"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                className="id-photo-input"
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <label style={{ fontSize: 11, color: "#94a3b8" }}>저장 위치</label>
                <button
                  style={{
                    background: "none",
                    border: "none",
                    color: "#38bdf8",
                    fontSize: 11,
                    cursor: "pointer",
                    padding: 0,
                  }}
                  onClick={handleSelectSaveDir}
                >
                  폴더 변경
                </button>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "#cbd5e1",
                  background: "rgba(0,0,0,0.25)",
                  padding: "6px 8px",
                  borderRadius: 4,
                  wordBreak: "break-all",
                }}
              >
                {saveDir || "원본과 같은 폴더"}
              </div>
            </div>

            {/* 검증 결과 표시 상자 */}
            {lastValidation && (
              <div
                className={`id-photo-result-box ${lastValidation.passOfficialSpec ? "pass" : "fail"}`}
              >
                <div style={{ fontWeight: 600 }}>{lastValidation.message}</div>
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
                  저장 파일: {lastValidation.path}
                </div>
              </div>
            )}
          </div>

          {/* 사이드바 하단 저장 & 인쇄 버튼 */}
          <div className="id-photo-footer">
            <button
              className="id-photo-btn id-photo-btn-primary"
              style={{ padding: "10px 14px", fontSize: 14, fontWeight: 600 }}
              onClick={handleSave}
              disabled={isSaving}
            >
              <Save size={16} />
              {isSaving
                ? "규격 검사 및 저장 중..."
                : filePaths.length > 1
                ? `저장하고 다음 사진 (Enter)`
                : `증명사진 저장 (Enter)`}
            </button>

            <button
              className="id-photo-btn id-photo-btn-secondary"
              onClick={handleGeneratePrintSheet}
              disabled={isGeneratingSheet}
            >
              <Printer size={15} /> 4x6 인화지 배치 생성 (Ctrl+P)
            </button>
          </div>
        </div>
      </div>

      {/* 인화지 배치 미리보기 모달 */}
      {printSheetModalOpen && printSheetPath && (
        <div className="id-photo-modal-backdrop" onClick={() => setPrintSheetModalOpen(false)}>
          <div className="id-photo-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="id-photo-modal-title">4x6인치 (10x15cm) 인화지 배치 완료</div>
            <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>
              정확히 1800×1200 픽셀 (300DPI) 규격으로 8장/6장 자동 정렬 및 재단선이 포함되었습니다.
            </p>

            <div
              style={{
                background: "#000",
                padding: 10,
                borderRadius: 8,
                display: "flex",
                justifyContent: "center",
                maxHeight: 380,
                overflow: "hidden",
              }}
            >
              <img
                src={convertFileSrc(printSheetPath)}
                alt="Print Sheet"
                style={{ maxWidth: "100%", maxHeight: 360, objectFit: "contain" }}
              />
            </div>

            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                className="id-photo-btn id-photo-btn-secondary"
                onClick={() => setPrintSheetModalOpen(false)}
              >
                닫기
              </button>
              <button
                className="id-photo-btn id-photo-btn-primary"
                onClick={() => {
                  window.print();
                }}
              >
                <Printer size={15} /> 바로 인쇄
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 프리셋 관리 모달 */}
      {presetModalOpen && (
        <div className="id-photo-modal-backdrop" onClick={() => setPresetModalOpen(false)}>
          <div
            className="id-photo-modal-card"
            style={{ maxWidth: 600 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="id-photo-modal-title">증명사진 규격 프리셋 관리</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  style={{
                    background: "#232730",
                    padding: "10px 14px",
                    borderRadius: 6,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, display: "flex", gap: 6 }}>
                      <span>{preset.name}</span>
                      {preset.isLocked && (
                        <span
                          style={{
                            background: "#ef4444",
                            color: "#fff",
                            fontSize: 10,
                            padding: "1px 5px",
                            borderRadius: 3,
                          }}
                        >
                          잠금
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>
                      {preset.widthPx} × {preset.heightPx} px · {preset.dpi}DPI ·{" "}
                      {preset.maxBytes ? `${preset.maxBytes / 1000}KB 이하` : "무제한"}
                    </div>
                  </div>

                  {!preset.isLocked && (
                    <button
                      className="id-photo-btn id-photo-btn-secondary"
                      style={{ color: "#ef4444", padding: "4px 8px", fontSize: 11 }}
                      onClick={async () => {
                        const updated = presets.filter((p) => p.id !== preset.id);
                        setPresets(updated);
                        await invoke("save_id_photo_presets", { presets: updated });
                        showToast(`프리셋 '${preset.name}' 삭제됨`);
                      }}
                    >
                      삭제
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
              <button
                className="id-photo-btn id-photo-btn-primary"
                onClick={() => setPresetModalOpen(false)}
              >
                완료
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
