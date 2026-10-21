export type IdPhotoGuideSettings = {
  crownPercent: number; // 정수리선 위치 (% from top)
  chinPercent: number; // 턱선 위치 (% from top)
  eyePercent: number; // 눈높이선 위치 (% from top)
  ovalWidthPercent: number; // 얼굴 타원 너비 (% of crop width)
  ovalHeightPercent: number; // 얼굴 타원 높이 (% of crop height)
};

export type IdPhotoPreset = {
  id: string;
  name: string;
  widthPx: number;
  heightPx: number;
  widthCm: number;
  heightCm: number;
  dpi: number;
  maxBytes?: number; // 최대 허용 파일 용량 (예: 150,000바이트)
  format: "jpg";
  isLocked: boolean; // 공무원증 등 수정/삭제 잠금 여부
  description: string;
  guide: IdPhotoGuideSettings;
};

export type IdPhotoValidationResult = {
  path: string;
  fileSize: number;
  width: number;
  height: number;
  isExactSize: boolean;
  isValidJpg: boolean;
  isUnderSizeLimit: boolean;
  passOfficialSpec: boolean;
  message: string;
};

export type DetectedFace = {
  x: number; // 원본 이미지 픽셀 좌표
  y: number;
  width: number;
  height: number;
  confidence: number;
};

export const DEFAULT_PRESETS: IdPhotoPreset[] = [
  {
    id: "civil_service",
    name: "공무원증",
    widthPx: 354,
    heightPx: 472,
    widthCm: 3.0,
    heightCm: 4.0,
    dpi: 300,
    maxBytes: 150000, // 150,000 바이트 미만 (엄격한 기준)
    format: "jpg",
    isLocked: true, // 실수 방지를 위해 잠금
    description: "354×472 px · JPG · 150KB 미만 · 메타데이터 제거",
    guide: {
      crownPercent: 15,
      chinPercent: 78,
      eyePercent: 40,
      ovalWidthPercent: 54,
      ovalHeightPercent: 63,
    },
  },
  {
    id: "id_photo_3x4",
    name: "증명사진 3x4cm",
    widthPx: 354,
    heightPx: 472,
    widthCm: 3.0,
    heightCm: 4.0,
    dpi: 300,
    maxBytes: 500000,
    format: "jpg",
    isLocked: false,
    description: "일반 서류·이력서용 (3x4cm)",
    guide: {
      crownPercent: 16,
      chinPercent: 78,
      eyePercent: 41,
      ovalWidthPercent: 52,
      ovalHeightPercent: 62,
    },
  },
  {
    id: "passport_35x45",
    name: "여권·주민등록증·운전면허 3.5x4.5cm",
    widthPx: 413,
    heightPx: 531,
    widthCm: 3.5,
    heightCm: 4.5,
    dpi: 300,
    maxBytes: 500000,
    format: "jpg",
    isLocked: false,
    description: "온라인 제출용 (413×531 px · JPG)",
    guide: {
      crownPercent: 12,
      chinPercent: 82,
      eyePercent: 38,
      ovalWidthPercent: 58,
      ovalHeightPercent: 70,
    },
  },
  {
    id: "half_namecard_3x4",
    name: "반명함 3x4cm",
    widthPx: 354,
    heightPx: 472,
    widthCm: 3.0,
    heightCm: 4.0,
    dpi: 300,
    maxBytes: 500000,
    format: "jpg",
    isLocked: false,
    description: "반명함판 규격 (3x4cm)",
    guide: {
      crownPercent: 16,
      chinPercent: 78,
      eyePercent: 41,
      ovalWidthPercent: 52,
      ovalHeightPercent: 62,
    },
  },
];
