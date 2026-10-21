import React, { useState, useEffect, useCallback } from "react";
import { Check, X, Ratio } from "lucide-react";
import "./CropOverlay.css";

export interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AspectRatioType =
  | "free"
  | "1:1"
  | "4:3"
  | "3:2"
  | "16:9"
  | "a4_portrait"
  | "a4_landscape"
  | "custom";

interface CropOverlayProps {
  imageWidth: number;
  imageHeight: number;
  displayedRect: { left: number; top: number; width: number; height: number };
  onApplyCrop: (crop: CropArea) => void;
  onCancel: () => void;
}

export const CropOverlay: React.FC<CropOverlayProps> = ({
  imageWidth,
  imageHeight,
  displayedRect,
  onApplyCrop,
  onCancel,
}) => {
  const [aspect, setAspect] = useState<AspectRatioType>("free");
  const [customRatio, setCustomRatio] = useState<{ w: number; h: number }>({ w: 16, h: 9 });
  const [crop, setCrop] = useState<CropArea>(() => ({
    x: 0,
    y: 0,
    width: imageWidth,
    height: imageHeight,
  }));

  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragHandle, setDragHandle] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; crop: CropArea } | null>(null);

  // 화면 좌표 <-> 이미지 원본 좌표 변환
  const scale = displayedRect.width / imageWidth;

  const toScreenX = (imgX: number) => displayedRect.left + imgX * scale;
  const toScreenY = (imgY: number) => displayedRect.top + imgY * scale;

  // 비율에 맞게 크기 보정
  const applyAspectToCrop = useCallback(
    (currentCrop: CropArea, currentAspect: AspectRatioType, ratioW: number, ratioH: number): CropArea => {
      let targetRatio: number | null = null;
      if (currentAspect === "1:1") targetRatio = 1.0;
      else if (currentAspect === "4:3") targetRatio = 4 / 3;
      else if (currentAspect === "3:2") targetRatio = 3 / 2;
      else if (currentAspect === "16:9") targetRatio = 16 / 9;
      else if (currentAspect === "a4_portrait") targetRatio = 1 / 1.4142;
      else if (currentAspect === "a4_landscape") targetRatio = 1.4142;
      else if (currentAspect === "custom" && ratioW > 0 && ratioH > 0) targetRatio = ratioW / ratioH;

      if (!targetRatio) return currentCrop;

      let newW = currentCrop.width;
      let newH = newW / targetRatio;

      if (newH > imageHeight) {
        newH = imageHeight;
        newW = newH * targetRatio;
      }
      if (newW > imageWidth) {
        newW = imageWidth;
        newH = newW / targetRatio;
      }

      let newX = Math.max(0, Math.min(imageWidth - newW, currentCrop.x));
      let newY = Math.max(0, Math.min(imageHeight - newH, currentCrop.y));

      return { x: newX, y: newY, width: newW, height: newH };
    },
    [imageWidth, imageHeight]
  );

  const handleAspectChange = (newAspect: AspectRatioType) => {
    setAspect(newAspect);
    setCrop((prev) => applyAspectToCrop(prev, newAspect, customRatio.w, customRatio.h));
  };

  // 단축키: KeyboardEvent.code 기준 (Enter: 적용, Escape: 취소)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Enter") {
        e.preventDefault();
        onApplyCrop(crop);
      } else if (e.code === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [crop, onApplyCrop, onCancel]);

  const handleMouseDown = (e: React.MouseEvent, handle: string) => {
    e.stopPropagation();
    setIsDragging(true);
    setDragHandle(handle);
    setDragStart({ x: e.clientX, y: e.clientY, crop: { ...crop } });
  };

  useEffect(() => {
    if (!isDragging || !dragStart) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragStart.x) / scale;
      const dy = (e.clientY - dragStart.y) / scale;
      const c = dragStart.crop;

      let newX = c.x;
      let newY = c.y;
      let newW = c.width;
      let newH = c.height;

      let targetRatio: number | null = null;
      if (aspect === "1:1") targetRatio = 1.0;
      else if (aspect === "4:3") targetRatio = 4 / 3;
      else if (aspect === "3:2") targetRatio = 3 / 2;
      else if (aspect === "16:9") targetRatio = 16 / 9;
      else if (aspect === "a4_portrait") targetRatio = 1 / 1.4142;
      else if (aspect === "a4_landscape") targetRatio = 1.4142;
      else if (aspect === "custom" && customRatio.w > 0 && customRatio.h > 0)
        targetRatio = customRatio.w / customRatio.h;

      if (dragHandle === "move") {
        newX = Math.max(0, Math.min(imageWidth - c.width, c.x + dx));
        newY = Math.max(0, Math.min(imageHeight - c.height, c.y + dy));
      } else if (dragHandle === "se") {
        newW = Math.max(20, Math.min(imageWidth - c.x, c.width + dx));
        newH = targetRatio ? newW / targetRatio : Math.max(20, Math.min(imageHeight - c.y, c.height + dy));
        if (targetRatio && (newY + newH > imageHeight)) {
          newH = imageHeight - newY;
          newW = newH * targetRatio;
        }
      } else if (dragHandle === "nw") {
        const potentialW = Math.max(20, c.width - dx);
        const potentialH = targetRatio ? potentialW / targetRatio : Math.max(20, c.height - dy);
        newX = Math.max(0, c.x + c.width - potentialW);
        newY = Math.max(0, c.y + c.height - potentialH);
        newW = c.x + c.width - newX;
        newH = c.y + c.height - newY;
      } else if (dragHandle === "ne") {
        newW = Math.max(20, Math.min(imageWidth - c.x, c.width + dx));
        const potentialH = targetRatio ? newW / targetRatio : Math.max(20, c.height - dy);
        newY = Math.max(0, c.y + c.height - potentialH);
        newH = c.y + c.height - newY;
      } else if (dragHandle === "sw") {
        const potentialW = Math.max(20, c.width - dx);
        newX = Math.max(0, c.x + c.width - potentialW);
        newW = c.x + c.width - newX;
        newH = targetRatio ? newW / targetRatio : Math.max(20, Math.min(imageHeight - c.y, c.height + dy));
      } else if (dragHandle === "e") {
        newW = Math.max(20, Math.min(imageWidth - c.x, c.width + dx));
        if (targetRatio) newH = newW / targetRatio;
      } else if (dragHandle === "s") {
        newH = Math.max(20, Math.min(imageHeight - c.y, c.height + dy));
        if (targetRatio) newW = newH * targetRatio;
      } else if (dragHandle === "w") {
        const potentialW = Math.max(20, c.width - dx);
        newX = Math.max(0, c.x + c.width - potentialW);
        newW = c.x + c.width - newX;
        if (targetRatio) newH = newW / targetRatio;
      } else if (dragHandle === "n") {
        const potentialH = Math.max(20, c.height - dy);
        newY = Math.max(0, c.y + c.height - potentialH);
        newH = c.y + c.height - newY;
        if (targetRatio) newW = newH * targetRatio;
      }

      setCrop({
        x: Math.round(newX),
        y: Math.round(newY),
        width: Math.round(newW),
        height: Math.round(newH),
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setDragHandle(null);
      setDragStart(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, dragHandle, dragStart, scale, aspect, customRatio, imageWidth, imageHeight]);

  const screenBox = {
    left: toScreenX(crop.x),
    top: toScreenY(crop.y),
    width: crop.width * scale,
    height: crop.height * scale,
  };

  return (
    <div className="crop-overlay-root">
      {/* 상단 자르기 도구 툴바 */}
      <div className="crop-top-bar">
        <div className="crop-ratio-group">
          <Ratio size={14} className="crop-bar-icon" />
          <span className="crop-bar-title">비율:</span>
          {(
            [
              ["free", "자유"],
              ["1:1", "1:1"],
              ["4:3", "4:3"],
              ["3:2", "3:2"],
              ["16:9", "16:9"],
              ["a4_portrait", "A4 세로"],
              ["a4_landscape", "A4 가로"],
              ["custom", "직접 입력"],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              type="button"
              className={`crop-ratio-btn${aspect === val ? " is-active" : ""}`}
              onClick={() => handleAspectChange(val)}
            >
              {label}
            </button>
          ))}
          {aspect === "custom" && (
            <div className="crop-custom-ratio-inputs">
              <input
                type="number"
                min="1"
                value={customRatio.w}
                onChange={(e) => {
                  const val = Math.max(1, parseInt(e.target.value) || 1);
                  setCustomRatio((p) => ({ ...p, w: val }));
                  setCrop((prev) => applyAspectToCrop(prev, "custom", val, customRatio.h));
                }}
              />
              <span>:</span>
              <input
                type="number"
                min="1"
                value={customRatio.h}
                onChange={(e) => {
                  const val = Math.max(1, parseInt(e.target.value) || 1);
                  setCustomRatio((p) => ({ ...p, h: val }));
                  setCrop((prev) => applyAspectToCrop(prev, "custom", customRatio.w, val));
                }}
              />
            </div>
          )}
        </div>

        <div className="crop-action-group">
          <button
            type="button"
            className="crop-btn-cancel"
            onClick={onCancel}
            title="취소 (Esc)"
          >
            <X size={14} />
            <span>취소 (Esc)</span>
          </button>
          <button
            type="button"
            className="crop-btn-apply"
            onClick={() => onApplyCrop(crop)}
            title="자르기 적용 (Enter)"
          >
            <Check size={14} />
            <span>자르기 적용 (Enter)</span>
          </button>
        </div>
      </div>

      {/* 화면 어둡게 마스크 (4개 박스) */}
      <div
        className="crop-dim-mask"
        style={{ top: 0, left: 0, right: 0, height: Math.max(0, screenBox.top) }}
      />
      <div
        className="crop-dim-mask"
        style={{
          top: Math.max(0, screenBox.top),
          left: 0,
          width: Math.max(0, screenBox.left),
          height: screenBox.height,
        }}
      />
      <div
        className="crop-dim-mask"
        style={{
          top: Math.max(0, screenBox.top),
          left: screenBox.left + screenBox.width,
          right: 0,
          height: screenBox.height,
        }}
      />
      <div
        className="crop-dim-mask"
        style={{
          top: screenBox.top + screenBox.height,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      />

      {/* 자르기 사각형 및 조절 핸들 */}
      <div
        className="crop-selection-box"
        style={{
          left: screenBox.left,
          top: screenBox.top,
          width: screenBox.width,
          height: screenBox.height,
        }}
        onMouseDown={(e) => handleMouseDown(e, "move")}
      >
        {/* 삼분할선 격자 */}
        <div className="crop-grid-line crop-grid-h1" />
        <div className="crop-grid-line crop-grid-h2" />
        <div className="crop-grid-line crop-grid-v1" />
        <div className="crop-grid-line crop-grid-v2" />

        {/* 8개 조절 핸들 */}
        <div className="crop-handle crop-handle-nw" onMouseDown={(e) => handleMouseDown(e, "nw")} />
        <div className="crop-handle crop-handle-ne" onMouseDown={(e) => handleMouseDown(e, "ne")} />
        <div className="crop-handle crop-handle-sw" onMouseDown={(e) => handleMouseDown(e, "sw")} />
        <div className="crop-handle crop-handle-se" onMouseDown={(e) => handleMouseDown(e, "se")} />
        <div className="crop-handle crop-handle-n" onMouseDown={(e) => handleMouseDown(e, "n")} />
        <div className="crop-handle crop-handle-s" onMouseDown={(e) => handleMouseDown(e, "s")} />
        <div className="crop-handle crop-handle-w" onMouseDown={(e) => handleMouseDown(e, "w")} />
        <div className="crop-handle crop-handle-e" onMouseDown={(e) => handleMouseDown(e, "e")} />

        {/* 실시간 픽셀 크기 배지 */}
        <div className="crop-dimension-badge">
          {Math.round(crop.width)} × {Math.round(crop.height)} px
        </div>
      </div>
    </div>
  );
};
