import React, { useState } from "react";
import { SlidersHorizontal, RotateCcw, Sparkles, Check, X } from "lucide-react";
import "./AdjustModal.css";

export interface AdjustParams {
  brightness: number; // -100 ~ 100
  contrast: number;   // -100 ~ 100
  saturation: number; // -100 ~ 100
  sharpness: number;  // 0 ~ 100
}

interface AdjustModalProps {
  initialValues?: AdjustParams;
  onChange: (values: AdjustParams) => void;
  onApply: (values: AdjustParams) => void;
  onCancel: () => void;
}

export const AdjustModal: React.FC<AdjustModalProps> = ({
  initialValues = { brightness: 0, contrast: 0, saturation: 0, sharpness: 0 },
  onChange,
  onApply,
  onCancel,
}) => {
  const [values, setValues] = useState<AdjustParams>(initialValues);

  const updateField = (field: keyof AdjustParams, val: number) => {
    const updated = { ...values, [field]: val };
    setValues(updated);
    onChange(updated);
  };

  const handleReset = () => {
    const reset = { brightness: 0, contrast: 0, saturation: 0, sharpness: 0 };
    setValues(reset);
    onChange(reset);
  };

  const handleAutoLevel = () => {
    // 자동 레벨 보정: 화사함과 선명도 최적화
    const auto = { brightness: 12, contrast: 18, saturation: 10, sharpness: 25 };
    setValues(auto);
    onChange(auto);
  };

  return (
    <div className="adjust-modal-floating">
      <div className="adjust-modal-header">
        <div className="adjust-header-title">
          <SlidersHorizontal size={14} className="adjust-icon" />
          <span>간단 사진 보정</span>
        </div>
        <button
          type="button"
          className="adjust-close-btn"
          onClick={onCancel}
          aria-label="닫기"
        >
          <X size={14} />
        </button>
      </div>

      <div className="adjust-modal-body">
        {/* 밝기 */}
        <div className="adjust-slider-row">
          <div className="adjust-slider-label">
            <span>밝기</span>
            <span className="adjust-slider-val">{values.brightness > 0 ? `+${values.brightness}` : values.brightness}</span>
          </div>
          <input
            type="range"
            min="-100"
            max="100"
            value={values.brightness}
            onChange={(e) => updateField("brightness", parseInt(e.target.value) || 0)}
          />
        </div>

        {/* 대비 */}
        <div className="adjust-slider-row">
          <div className="adjust-slider-label">
            <span>대비</span>
            <span className="adjust-slider-val">{values.contrast > 0 ? `+${values.contrast}` : values.contrast}</span>
          </div>
          <input
            type="range"
            min="-100"
            max="100"
            value={values.contrast}
            onChange={(e) => updateField("contrast", parseInt(e.target.value) || 0)}
          />
        </div>

        {/* 채도 */}
        <div className="adjust-slider-row">
          <div className="adjust-slider-label">
            <span>채도</span>
            <span className="adjust-slider-val">{values.saturation > 0 ? `+${values.saturation}` : values.saturation}</span>
          </div>
          <input
            type="range"
            min="-100"
            max="100"
            value={values.saturation}
            onChange={(e) => updateField("saturation", parseInt(e.target.value) || 0)}
          />
        </div>

        {/* 선명도 */}
        <div className="adjust-slider-row">
          <div className="adjust-slider-label">
            <span>선명도</span>
            <span className="adjust-slider-val">{values.sharpness}</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={values.sharpness}
            onChange={(e) => updateField("sharpness", parseInt(e.target.value) || 0)}
          />
        </div>

        {/* 자동 보정 & 원래대로 버튼 */}
        <div className="adjust-quick-actions">
          <button
            type="button"
            className="adjust-quick-btn"
            onClick={handleAutoLevel}
            title="자동 레벨 최적화"
          >
            <Sparkles size={13} />
            <span>자동 보정</span>
          </button>
          <button
            type="button"
            className="adjust-quick-btn"
            onClick={handleReset}
            title="모든 보정 초기화"
          >
            <RotateCcw size={13} />
            <span>원래대로</span>
          </button>
        </div>
      </div>

      <div className="adjust-modal-footer">
        <button
          type="button"
          className="adjust-cancel-btn"
          onClick={onCancel}
        >
          취소
        </button>
        <button
          type="button"
          className="adjust-apply-btn"
          onClick={() => onApply(values)}
        >
          <Check size={14} />
          <span>보정 적용</span>
        </button>
      </div>
    </div>
  );
};
