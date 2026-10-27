import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import {
  type AppCommand,
  type CommandId,
  TOOLBAR_GROUPS_VIEWER,
  TOOLBAR_GROUPS_EXPLORER,
  CONTEXT_MENU_GROUPS,
  buildCommands,
} from "./commands";
import {
  Folder,
  FolderOpen as FolderOpenIcon,
  HardDrive,
  FileArchive,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  Sliders,
  Image as ImageIcon,
  ArrowUp,
  RefreshCw,
  Check,
  Star,
  Clock,
  Filter,
} from "lucide-react";
import "./App.css";
import { IdPhotoEditor } from "./IdPhotoEditor";
import { CadViewer } from "./CadViewer";
import { BatchProcessingModal } from "./BatchProcessingModal";
import type { BatchModalMode } from "./batchTypes";
import { MosaicEditorModal } from "./MosaicEditorModal";
import { PhotoCollageModal } from "./PhotoCollageModal";
import { PdfBindingModal } from "./PdfBindingModal";
import { PhotoStampModal } from "./PhotoStampModal";
import { CropOverlay, type CropArea } from "./CropOverlay";
import { AdjustModal, type AdjustParams } from "./AdjustModal";

const APP_NAME = "k-boda";
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "jfif", "png", "gif", "webp", "avif", "bmp", "svg", "tif", "tiff", "heic", "heif"];
const ARCHIVE_EXTENSIONS = ["zip", "cbz"];
const CAD_EXTENSIONS = ["dwg", "dxf"];
const ALL_SUPPORTED_EXTENSIONS = [...IMAGE_EXTENSIONS, ...ARCHIVE_EXTENSIONS, ...CAD_EXTENSIONS];

const isCadPath = (p?: string | null): boolean => {
  if (!p) return false;
  const lower = p.toLowerCase();
  return lower.endsWith(".dwg") || lower.endsWith(".dxf");
};

// 미리 읽기 대상 인덱스: 현재 장 기준 앞뒤 2장 (목록 범위 밖은 제외)
const getPreloadIndices = (current: number, length: number): number[] =>
  [current - 2, current - 1, current + 1, current + 2].filter((i) => i >= 0 && i < length);

// 줌 배율 범위 (2% ~ 6400%)
const MIN_SCALE = 0.02;
const MAX_SCALE = 64.0;
// 화면 밖으로 완전히 사라지지 않도록 남겨둘 최소 가시 영역(px)
const MIN_VISIBLE_PX = 60;
// 필름스트립 썸네일 아이템 너비 (68px + gap 8px)
const THUMB_ITEM_WIDTH = 76;

export type SortBy = "name" | "dateModified" | "dateTaken" | "fileSize" | "fileType";
export type SortOrder = "asc" | "desc";
export type BgMode = "black" | "dark" | "checker";
export type ReadingDirection = "ltr" | "rtl";
export type ZoomMode = "fitIfLarge" | "fitAlways" | "originalAlways" | "fitWidth";
export type WheelAction = "navigate" | "zoom";
export type InterpolationMode = "smooth" | "pixelated";
export type ExplorerFilter = "all" | "jpg" | "png" | "gif" | "webp" | "other";

export type RecentItem = {
  path: string;
  name: string;
  isFolder: boolean;
};

export type ExternalEditor = {
  id: string;
  name: string;
  path: string;
};

export type AppSettings = {
  theme: "dark" | "light";
  sortBy: SortBy;
  sortOrder: SortOrder;
  autoNextFolder: boolean;
  defaultBg: BgMode;
  showToolbar: boolean;
  showStatusBar: boolean;
  lastFolder?: string | null;
  folderTreeWidth: number;
  thumbnailSize: number;
  zoomMode: ZoomMode;
  wheelAction: WheelAction;
  keepTransform: boolean;
  interpolation: InterpolationMode;
  slideshowInterval: number;
  slideshowRandom: boolean;
  slideshowLoop: boolean;
  // 10단계 새 설정
  recentItems: RecentItem[];
  favoriteFolders: string[];
  recentTargetFolders: string[];
  externalEditors: ExternalEditor[];
  explorerFilter: ExplorerFilter;
  cadFileAssociation?: boolean;
};

export type SystemLocation = {
  name: string;
  path: string;
  kind: "quickAccess" | "drive";
};

export type SubfolderItem = {
  name: string;
  path: string;
  hasChildren: boolean;
};

export type ExplorerItem = {
  name: string;
  path: string;
  kind: "folder" | "archive" | "image" | "cad";
  size: number;
  modified: number;
  extension: string;
};

export type ExplorerFolderResult = {
  currentPath: string;
  parentPath: string | null;
  items: ExplorerItem[];
  totalFolders: number;
  totalImages: number;
  totalArchives: number;
};

export type ImageEntry = {
  path: string;
  fileName: string;
  fileSize: number;
  modified: number;
  isArchiveEntry?: boolean;
  archivePath?: string;
  entryName?: string;
};

type FolderScanResult = {
  currentIndex: number;
  items: ImageEntry[];
  orientation: number;
};

type ImageDetails = {
  path: string;
  fileName: string;
  fileSize: number;
  modified: number;
  width: number;
  height: number;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  dateTimeOriginal?: string;
  fNumber?: string;
  exposureTime?: string;
  iso?: string;
  focalLength?: string;
  aiPrompt?: string;
};

type ViewState =
  | { kind: "empty" }
  | {
      kind: "image";
      src: string;
      fileName: string;
      path: string;
      isArchive?: boolean;
      isClipboard?: boolean;
      clipboardData?: string;
    }
  | { kind: "error"; fileName: string; message: string; path?: string };

type Transform = {
  x: number;
  y: number;
  scale: number;
};

type ImageMeta = {
  naturalWidth: number;
  naturalHeight: number;
};

const FORBIDDEN_CHARS_REGEX = /[\\/:*?"<>|]/;
const WINDOWS_RESERVED_NAMES = [
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
];

function validateFileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "파일 이름을 입력해주세요.";
  if (FORBIDDEN_CHARS_REGEX.test(trimmed)) {
    return '파일 이름에 다음 문자를 포함할 수 없습니다: \\ / : * ? " < > |';
  }
  const dotIdx = trimmed.indexOf(".");
  const stem = (dotIdx === -1 ? trimmed : trimmed.slice(0, dotIdx)).toUpperCase();
  if (WINDOWS_RESERVED_NAMES.includes(stem)) {
    return `"${stem}"은(는) 윈도우 예약어이므로 사용할 수 없습니다.`;
  }
  return null;
}

/** 윈도우 경로(\, /, UNC 포함)에서 파일명만 꺼낸다 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTimestamp(sec: number): string {
  if (!sec) return "-";
  const d = new Date(sec * 1000);
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function setWindowTitle(fileName?: string, curIndex?: number, total?: number) {
  let title = APP_NAME;
  if (fileName) {
    title = total && total > 1 ? `[${curIndex! + 1}/${total}] ${fileName} - ${APP_NAME}` : `${fileName} - ${APP_NAME}`;
  }
  document.title = title;
  getCurrentWindow().setTitle(title).catch(() => {
    /* 제목 변경 실패 무시 */
  });
}

function clampPosition(
  x: number,
  y: number,
  scale: number,
  bw: number,
  bh: number,
  vw: number,
  vh: number,
  rot = 0
): { x: number; y: number } {
  const isSideways = rot === 90 || rot === 270;
  const effW = (isSideways ? bh : bw) * scale;
  const effH = (isSideways ? bw : bh) * scale;

  const minVisX = Math.min(MIN_VISIBLE_PX, effW);
  const minVisY = Math.min(MIN_VISIBLE_PX, effH);

  let minOffX = 0;
  let minOffY = 0;
  if (rot === 90) {
    minOffX = -bh * scale;
    minOffY = 0;
  } else if (rot === 180) {
    minOffX = -bw * scale;
    minOffY = -bh * scale;
  } else if (rot === 270) {
    minOffX = 0;
    minOffY = -bw * scale;
  }

  const curLeft = x + minOffX;
  const curTop = y + minOffY;

  const minX = minVisX - effW;
  const maxX = vw - minVisX;
  const clampedLeft = minX <= maxX ? Math.max(minX, Math.min(maxX, curLeft)) : (vw - effW) / 2;

  const minY = minVisY - effH;
  const maxY = vh - minVisY;
  const clampedTop = minY <= maxY ? Math.max(minY, Math.min(maxY, curTop)) : (vh - effH) / 2;

  return { x: clampedLeft - minOffX, y: clampedTop - minOffY };
}

function App() {
  const [view, setView] = useState<ViewState>({ kind: "empty" });
  const [loaded, setLoaded] = useState(false);
  const [secondLoaded, setSecondLoaded] = useState(false);
  const [draggingFile, setDraggingFile] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  // 폴더 내 이미지 목록 및 인덱스
  const [items, setItems] = useState<ImageEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  // 4단계 & 5단계 기능 상태
  const [showFilmstrip, setShowFilmstrip] = useState(false);
  const [showInfoPanel, setShowInfoPanel] = useState(false);
  const [imageDetails, setImageDetails] = useState<ImageDetails | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // 5단계: 화면 회전 각도 (0, 90, 180, 270)
  const [rotation, setRotation] = useState<number>(0);

  // 5단계: 배경색 모드 ("black" | "dark" | "checker")
  const [bgMode, setBgMode] = useState<BgMode>("black");

  // 5단계: 양면 보기 및 읽기 방향
  const [isDoublePage, setIsDoublePage] = useState<boolean>(false);
  const [readingDirection] = useState<ReadingDirection>("ltr");

  // 5단계: 삭제 확인 모달
  const [showDeleteModal, setShowDeleteModal] = useState<boolean>(false);

  // 필름스트립 가상 스크롤
  const [filmstripScrollLeft, setFilmstripScrollLeft] = useState(0);
  const [filmstripWidth, setFilmstripWidth] = useState(800);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  // 8단계: 화면 모드 ("viewer" | "explorer")
  const [appMode, setAppMode] = useState<"viewer" | "explorer">("viewer");

  // 12단계: 증명사진 만들기 대상 파일 목록
  const [idPhotoTargetPaths, setIdPhotoTargetPaths] = useState<string[] | null>(null);

  // 14단계 B: 일괄 작업 (변환, 이름 바꾸기, 회전) 모달 상태
  const [batchModalState, setBatchModalState] = useState<{ mode: BatchModalMode; paths: string[] } | null>(null);

  // 14단계 C: 학교 행정실 사진 작업 (모자이크, 사진 합치기, PDF 묶기, 날짜·글자 넣기) 모달 상태
  const [mosaicModalPath, setMosaicModalPath] = useState<string | null>(null);
  const [photoCollagePaths, setPhotoCollagePaths] = useState<string[] | null>(null);
  const [pdfBindingPaths, setPdfBindingPaths] = useState<string[] | null>(null);
  const [photoStampPaths, setPhotoStampPaths] = useState<string[] | null>(null);

  // 14단계 A: 자르기, 간단 보정, TIFF 다중페이지, HEIC 변환 상태
  const [isCropping, setIsCropping] = useState<boolean>(false);
  const [activeCrop, setActiveCrop] = useState<CropArea | null>(null);
  const [showAdjustModal, setShowAdjustModal] = useState<boolean>(false);
  const [activeAdjust, setActiveAdjust] = useState<AdjustParams>({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });
  const [liveAdjust, setLiveAdjust] = useState<AdjustParams>({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });
  const [tiffPageInfo, setTiffPageInfo] = useState<{ totalPages: number; currentPage: number } | null>(null);
  const [heicCodecMissing, setHeicCodecMissing] = useState<boolean>(false);
  const [pendingNavigate, setPendingNavigate] = useState<(() => void) | null>(null);

  // 8단계: 탐색기 모드 전용 상태
  const [currentExplorerPath, setCurrentExplorerPath] = useState<string>("");
  const [explorerResult, setExplorerResult] = useState<ExplorerFolderResult | null>(null);
  const [systemLocations, setSystemLocations] = useState<SystemLocation[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [subfoldersMap, setSubfoldersMap] = useState<Record<string, SubfolderItem[]>>({});
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [lastClickedIndex, setLastClickedIndex] = useState<number>(-1);
  const [addressInput, setAddressInput] = useState<string>("");
  const [isEditingAddress, setIsEditingAddress] = useState<boolean>(false);
  const [folderTreeWidth, setFolderTreeWidth] = useState<number>(240);
  const [thumbnailSize, setThumbnailSize] = useState<number>(120);
  const [explorerThumbnails, setExplorerThumbnails] = useState<Record<string, string>>({});
  const [gridScrollTop, setGridScrollTop] = useState<number>(0);
  const [gridDimensions, setGridDimensions] = useState<{ width: number; height: number }>({ width: 800, height: 600 });
  const [isResizingTree, setIsResizingTree] = useState<boolean>(false);

  // 6단계 & 7단계 & 9단계: 설정 및 도움말 모달 상태
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [helpModalTab, setHelpModalTab] = useState<"shortcuts" | "about" | "license">("shortcuts");
  const [appEnvInfo, setAppEnvInfo] = useState<{
    isPortable: boolean;
    isReadOnly: boolean;
    dataDir: string;
    version: string;
  } | null>(null);
  const [settingsTab, setSettingsTab] = useState<"general" | "view">("general");
  const [settings, setSettings] = useState<AppSettings>({
    theme: "dark",
    sortBy: "name",
    sortOrder: "asc",
    autoNextFolder: false,
    defaultBg: "black",
    showToolbar: true,
    showStatusBar: true,
    lastFolder: null,
    folderTreeWidth: 240,
    thumbnailSize: 120,
    zoomMode: "fitIfLarge",
    wheelAction: "navigate",
    keepTransform: false,
    interpolation: "smooth",
    slideshowInterval: 3,
    slideshowRandom: false,
    slideshowLoop: true,
    recentItems: [],
    favoriteFolders: [],
    recentTargetFolders: [],
    externalEditors: [],
    explorerFilter: "all",
    cadFileAssociation: false,
  });

  // 10단계: 이름 바꾸기(F2) 모달 상태
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameTargetItem, setRenameTargetItem] = useState<{ path: string; oldName: string; isDir?: boolean } | null>(null);
  const [renameNewName, setRenameNewName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 10단계: 폴더로 복사(F7) / 이동(F8) 모달 상태
  const [showCopyMoveModal, setShowCopyMoveModal] = useState(false);
  const [copyMoveMode, setCopyMoveMode] = useState<"copy" | "move">("copy");
  const [copyMoveSourcePaths, setCopyMoveSourcePaths] = useState<string[]>([]);
  const [copyMoveTargetFolder, setCopyMoveTargetFolder] = useState<string>("");
  const [copyMoveConflict, setCopyMoveConflict] = useState<"rename" | "overwrite" | "skip">("rename");

  // 10단계: 최근 항목 드롭다운 상태
  const [showRecentDropdown, setShowRecentDropdown] = useState(false);

  // 10단계: 외부 편집기 등록 폼 상태 (설정 창 내부)
  const [newEditorName, setNewEditorName] = useState("");
  const [newEditorPath, setNewEditorPath] = useState("");

  // 10단계: 실행 취소(Ctrl+Z), 최근 항목 존재 여부 맵, 즐겨찾기 드래그 순서 변경
  const [undoCount, setUndoCount] = useState(0);
  const [itemExistsMap, setItemExistsMap] = useState<Record<string, boolean>>({});
  const [draggedFavIdx, setDraggedFavIdx] = useState<number | null>(null);

  // 9단계: 좌우 반전 / 상하 반전 상태
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);

  // 9단계: 다른 이름으로 저장 모달 상태
  const [showSaveAsModal, setShowSaveAsModal] = useState(false);
  const [saveAsTargetPath, setSaveAsTargetPath] = useState("");
  const [saveAsFormat, setSaveAsFormat] = useState<"jpg" | "png" | "webp" | "bmp">("jpg");
  const [saveAsQuality, setSaveAsQuality] = useState(90);
  const [saveAsResizeW, setSaveAsResizeW] = useState<number | undefined>(undefined);
  const [saveAsResizeH, setSaveAsResizeH] = useState<number | undefined>(undefined);

  // 9단계: 크기 조정 모달 상태
  const [showResizeModal, setShowResizeModal] = useState(false);
  const [resizeUnit, setResizeUnit] = useState<"pixel" | "percent">("pixel");
  const [resizeKeepRatio, setResizeKeepRatio] = useState(true);
  const [resizeCustomW, setResizeCustomW] = useState(0);
  const [resizeCustomH, setResizeCustomH] = useState(0);

  // 9단계: 정렬 메뉴 드롭다운 상태
  const [showSortDropdown, setShowSortDropdown] = useState(false);

  // 9단계: 슬라이드쇼 상태
  const [isSlideshowActive, setIsSlideshowActive] = useState(false);
  const [isSlideshowPaused, setIsSlideshowPaused] = useState(false);
  const [slideshowRemainingSec, setSlideshowRemainingSec] = useState(3);
  const [showSlideshowBadge, setShowSlideshowBadge] = useState(false);

  // 7단계: 전체화면 여부, 상단 마우스 감지(전체화면 툴바 노출), 우클릭 컨텍스트 메뉴
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMouseAtTop, setIsMouseAtTop] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 토스트 안내 문구
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // 상단 바 표시 여부
  const [showTopBar, setShowTopBar] = useState(false);

  // 이미지 원본 크기
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [secondMeta, setSecondMeta] = useState<ImageMeta | null>(null);

  // 뷰포트 대비 위치 및 스케일
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const [isFit, setIsFit] = useState(true);

  const viewerRef = useRef<HTMLElement>(null);
  const filmstripScrollRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const dialogOpen = useRef(false);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const gridContainerRef = useRef<HTMLDivElement>(null);
  const folderRefreshTimerRef = useRef<number | null>(null);
  const loadingThumbsRef = useRef<Set<string>>(new Set());

  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;

  const transformRef = useRef(transform);
  transformRef.current = transform;

  const isFitRef = useRef(isFit);
  isFitRef.current = isFit;

  const metaRef = useRef(meta);
  metaRef.current = meta;

  const secondMetaRef = useRef(secondMeta);
  secondMetaRef.current = secondMeta;

  const dragStartRef = useRef<{
    clientX: number;
    clientY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const rAFRef = useRef<number | null>(null);
  const topBarTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  // 미리 읽기 캐시
  const preloadCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());

  // 토스트 띄우기
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 1600);
  }, []);

  // 상단 바 타이머 트리거
  const pingTopBar = useCallback(() => {
    setShowTopBar(true);
    if (topBarTimerRef.current !== null) {
      window.clearTimeout(topBarTimerRef.current);
    }
    topBarTimerRef.current = window.setTimeout(() => {
      setShowTopBar(false);
      topBarTimerRef.current = null;
    }, 2000);
  }, []);

  // 화면 맞춤 변환 계산 (회전 각도 고려)
  const getFitTransform = useCallback(
    (vw: number, vh: number, nw: number, nh: number, rot = 0): Transform => {
      const dpr = window.devicePixelRatio || 1;
      const bw = nw / dpr;
      const bh = nh / dpr;
      const isSideways = rot === 90 || rot === 270;
      const effW = isSideways ? bh : bw;
      const effH = isSideways ? bw : bh;
      const scale = Math.min(vw / effW, vh / effH);

      const hw = (bw * scale) / 2;
      const hh = (bh * scale) / 2;
      const rad = (rot * Math.PI) / 180;
      const cos = Math.round(Math.cos(rad));
      const sin = Math.round(Math.sin(rad));

      const x = vw / 2 - (hw * cos - hh * sin);
      const y = vh / 2 - (hw * sin + hh * cos);
      return { x, y, scale };
    },
    []
  );

  // 9단계: 보기 설정(zoomMode)에 따른 초기 변환 계산
  const getInitialTransform = useCallback(
    (
      vw: number,
      vh: number,
      nw: number,
      nh: number,
      rot = 0,
      mode: ZoomMode = settingsRef.current.zoomMode
    ): Transform => {
      const dpr = window.devicePixelRatio || 1;
      const bw = nw / dpr;
      const bh = nh / dpr;
      const isSideways = rot === 90 || rot === 270;
      const effW = isSideways ? bh : bw;
      const effH = isSideways ? bw : bh;
      const fitScale = Math.min(vw / effW, vh / effH);

      let scale: number;
      if (mode === "fitIfLarge") {
        // ① 큰 이미지만 화면에 맞춤, 작은 이미지는 원본 크기(기본값)
        scale = effW <= vw && effH <= vh ? 1.0 : fitScale;
      } else if (mode === "fitAlways") {
        // ② 항상 화면에 맞춤
        scale = fitScale;
      } else if (mode === "originalAlways") {
        // ③ 항상 원본 크기
        scale = 1.0;
      } else if (mode === "fitWidth") {
        // ④ 너비에 맞춤(긴 세로 이미지·웹툰용, 위아래 스크롤)
        scale = vw / effW;
      } else {
        scale = fitScale;
      }

      scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));

      const hw = (bw * scale) / 2;
      const hh = (bh * scale) / 2;
      const rad = (rot * Math.PI) / 180;
      const cos = Math.round(Math.cos(rad));
      const sin = Math.round(Math.sin(rad));

      let x = vw / 2 - (hw * cos - hh * sin);
      let y = vh / 2 - (hw * sin + hh * cos);

      if (mode === "fitWidth" && rot === 0) {
        // 너비 맞춤일 때 세로 스크롤을 위해 맨 위에서 시작
        x = 0;
        y = 0;
      }

      return { x, y, scale };
    },
    []
  );

  // 화면 맞춤 적용
  const fitToWindow = useCallback(() => {
    const el = viewerRef.current;
    const m = metaRef.current;
    if (!el || !m) return;
    const totalW = isDoublePage && secondMetaRef.current ? m.naturalWidth + secondMetaRef.current.naturalWidth : m.naturalWidth;
    const maxH = isDoublePage && secondMetaRef.current ? Math.max(m.naturalHeight, secondMetaRef.current.naturalHeight) : m.naturalHeight;
    const t = getFitTransform(el.clientWidth, el.clientHeight, totalW, maxH, rotation);
    setTransform(t);
    setIsFit(true);
  }, [getFitTransform, isDoublePage, rotation]);

  // 실제 크기 100% 적용
  const setActualSize = useCallback(() => {
    const el = viewerRef.current;
    const m = metaRef.current;
    if (!el || !m) return;
    const dpr = window.devicePixelRatio || 1;
    const totalW = isDoublePage && secondMetaRef.current ? m.naturalWidth + secondMetaRef.current.naturalWidth : m.naturalWidth;
    const maxH = isDoublePage && secondMetaRef.current ? Math.max(m.naturalHeight, secondMetaRef.current.naturalHeight) : m.naturalHeight;
    const bw = totalW / dpr;
    const bh = maxH / dpr;
    const scale = 1.0;

    const hw = (bw * scale) / 2;
    const hh = (bh * scale) / 2;
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.round(Math.cos(rad));
    const sin = Math.round(Math.sin(rad));

    const targetX = el.clientWidth / 2 - (hw * cos - hh * sin);
    const targetY = el.clientHeight / 2 - (hw * sin + hh * cos);

    const clamped = clampPosition(targetX, targetY, scale, bw, bh, el.clientWidth, el.clientHeight, rotation);
    setTransform({ x: clamped.x, y: clamped.y, scale });
    setIsFit(false);
  }, [isDoublePage, rotation]);

  // 커서 중심 줌
  const zoomAtPoint = useCallback(
    (cx: number, cy: number, factor: number) => {
      const el = viewerRef.current;
      const m = metaRef.current;
      if (!el || !m) return;

      const { x, y, scale } = transformRef.current;
      const dpr = window.devicePixelRatio || 1;
      const totalW = isDoublePage && secondMetaRef.current ? m.naturalWidth + secondMetaRef.current.naturalWidth : m.naturalWidth;
      const maxH = isDoublePage && secondMetaRef.current ? Math.max(m.naturalHeight, secondMetaRef.current.naturalHeight) : m.naturalHeight;
      const bw = totalW / dpr;
      const bh = maxH / dpr;

      let newScale = scale * factor;
      newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));

      const targetX = cx - (cx - x) * (newScale / scale);
      const targetY = cy - (cy - y) * (newScale / scale);

      const clamped = clampPosition(targetX, targetY, newScale, bw, bh, el.clientWidth, el.clientHeight, rotation);
      setTransform({ x: clamped.x, y: clamped.y, scale: newScale });
      setIsFit(false);
    },
    [isDoublePage, rotation]
  );

  // 화면 중심 줌
  const zoomCenter = useCallback((factor: number) => {
    const el = viewerRef.current;
    if (!el) return;
    zoomAtPoint(el.clientWidth / 2, el.clientHeight / 2, factor);
  }, [zoomAtPoint]);

  // 5단계: 화면 회전 핸들러 (시계 90도 / 반시계 90도 - 중심축을 화면 중앙에 완벽 고정)
  const handleRotate = useCallback(
    (delta: 90 | 270) => {
      const el = viewerRef.current;
      const m = metaRef.current;
      if (!el || !m) return;

      const nextRotation = (rotation + delta) % 360;
      setRotation(nextRotation);
      rotationRef.current = nextRotation;

      const dpr = window.devicePixelRatio || 1;
      const totalW = isDoublePage && secondMetaRef.current ? m.naturalWidth + secondMetaRef.current.naturalWidth : m.naturalWidth;
      const maxH = isDoublePage && secondMetaRef.current ? Math.max(m.naturalHeight, secondMetaRef.current.naturalHeight) : m.naturalHeight;
      const bw = totalW / dpr;
      const bh = maxH / dpr;
      const vw = el.clientWidth;
      const vh = el.clientHeight;

      const isSideways = nextRotation === 90 || nextRotation === 270;
      const effW = isSideways ? bh : bw;
      const effH = isSideways ? bw : bh;

      if (isFit) {
        // 화면 맞춤 모드: 회전된 비율에 맞춰 화면에 딱 맞게 스케일 재조정 및 중앙 정렬
        const newScale = Math.min(vw / effW, vh / effH);
        const hw = (bw * newScale) / 2;
        const hh = (bh * newScale) / 2;
        const rad = (nextRotation * Math.PI) / 180;
        const cos = Math.round(Math.cos(rad));
        const sin = Math.round(Math.sin(rad));

        const targetX = vw / 2 - (hw * cos - hh * sin);
        const targetY = vh / 2 - (hw * sin + hh * cos);
        setTransform({ x: targetX, y: targetY, scale: newScale });
      } else {
        // 100% 또는 확대 모드: 현재 배율을 유지한 채 화면 중심을 기준으로 회전
        const curScale = transformRef.current.scale;
        const hw = (bw * curScale) / 2;
        const hh = (bh * curScale) / 2;
        const rad = (nextRotation * Math.PI) / 180;
        const cos = Math.round(Math.cos(rad));
        const sin = Math.round(Math.sin(rad));

        const targetX = vw / 2 - (hw * cos - hh * sin);
        const targetY = vh / 2 - (hw * sin + hh * cos);

        const clamped = clampPosition(targetX, targetY, curScale, bw, bh, vw, vh, nextRotation);
        setTransform({ x: clamped.x, y: clamped.y, scale: curScale });
      }
    },
    [rotation, isFit, isDoublePage]
  );

  // 더블클릭 토글
  const toggleFitOrActual = useCallback(
    (cx: number, cy: number) => {
      const el = viewerRef.current;
      const m = metaRef.current;
      if (!el || !m) return;

      const totalW = isDoublePage && secondMetaRef.current ? m.naturalWidth + secondMetaRef.current.naturalWidth : m.naturalWidth;
      const maxH = isDoublePage && secondMetaRef.current ? Math.max(m.naturalHeight, secondMetaRef.current.naturalHeight) : m.naturalHeight;
      const fitT = getFitTransform(el.clientWidth, el.clientHeight, totalW, maxH, rotation);
      const curScale = transformRef.current.scale;

      if (Math.abs(curScale - fitT.scale) < 0.05) {
        const dpr = window.devicePixelRatio || 1;
        const bw = totalW / dpr;
        const bh = maxH / dpr;
        const targetScale = 1.0;

        const targetX = cx - (cx - transformRef.current.x) * (targetScale / curScale);
        const targetY = cy - (cy - transformRef.current.y) * (targetScale / curScale);
        const clamped = clampPosition(targetX, targetY, targetScale, bw, bh, el.clientWidth, el.clientHeight, rotation);
        setTransform({ x: clamped.x, y: clamped.y, scale: targetScale });
        setIsFit(false);
      } else {
        setTransform(fitT);
        setIsFit(true);
      }
    },
    [getFitTransform, isDoublePage, rotation]
  );

  // 전체화면 토글
  const toggleFullscreen = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow();
      const isFull = await appWindow.isFullscreen();
      const nextFull = !isFull;
      await appWindow.setFullscreen(nextFull);
      setIsFullscreen(nextFull);
    } catch {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen().catch(() => {});
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen().catch(() => {});
        setIsFullscreen(false);
      }
    }
  }, []);

  const exitFullscreen = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow();
      const isFull = await appWindow.isFullscreen();
      if (isFull) {
        await appWindow.setFullscreen(false);
      }
      setIsFullscreen(false);
    } catch {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
      setIsFullscreen(false);
    }
  }, []);

  // 상세 정보 불러오기
  const loadDetails = useCallback((path: string) => {
    if (!path) return;
    invoke<ImageDetails>("get_image_details", { path })
      .then((res) => {
        setImageDetails(res);
      })
      .catch(() => {
        setImageDetails(null);
      });
  }, []);

  // ZIP 내부 이미지 온디맨드 추출 헬퍼
  const ensureArchiveEntryPath = useCallback(async (item: ImageEntry): Promise<string> => {
    if (item.path) return item.path;
    if (item.isArchiveEntry && item.archivePath && item.entryName) {
      try {
        const extracted = await invoke<string>("get_archive_entry_image", {
          archivePath: item.archivePath,
          entryName: item.entryName,
        });
        item.path = extracted;
        return extracted;
      } catch (err) {
        console.error("ZIP 이미지 추출 실패:", err);
      }
    }
    return item.path;
  }, []);

  // 10단계: 최근 열어본 파일·폴더 등록 (최대 10개)
  const addRecentItem = useCallback((itemPath: string, isFolder: boolean) => {
    if (!itemPath) return;
    setSettings((prev) => {
      const name = baseName(itemPath);
      const existing = prev.recentItems || [];
      const filtered = existing.filter((item) => item.path.toLowerCase() !== itemPath.toLowerCase());
      const updated = [{ path: itemPath, name, isFolder }, ...filtered].slice(0, 10);
      const newSettings = { ...prev, recentItems: updated };
      invoke("save_settings", { settings: newSettings }).catch(console.error);
      return newSettings;
    });
  }, []);

  // 14단계 A: TIFF 다중 페이지 및 HEIC 윈도우 코덱 연동 처리
  const resolveDisplayablePath = useCallback(
    async (filePath: string, pageIndex = 0): Promise<string> => {
      const ext = filePath.split(".").pop()?.toLowerCase() || "";
      if (ext === "tif" || ext === "tiff") {
        try {
          const res = await invoke<{ totalPages: number; pageIndex: number; displayPath: string }>(
            "get_tiff_page",
            { path: filePath, pageIndex }
          );
          setTiffPageInfo({ totalPages: res.totalPages, currentPage: res.pageIndex });
          return res.displayPath;
        } catch (e) {
          console.error("TIFF 디코딩 실패:", e);
          setTiffPageInfo(null);
          return filePath;
        }
      } else {
        setTiffPageInfo(null);
      }

      if (ext === "heic" || ext === "heif") {
        try {
          const convertedPath = await invoke<string>("get_heic_display_path", { path: filePath });
          setHeicCodecMissing(false);
          return convertedPath;
        } catch (e) {
          if (String(e).includes("HEIC_CODEC_MISSING")) {
            setHeicCodecMissing(true);
          }
          return filePath;
        }
      } else {
        setHeicCodecMissing(false);
      }

      return filePath;
    },
    []
  );

  // 14단계 A: TIFF 페이지 전환 핸들러
  const handleTiffPageChange = useCallback(
    async (newPageIndex: number) => {
      if (view.kind !== "image" || !view.path || !tiffPageInfo) return;
      try {
        const res = await invoke<{ totalPages: number; pageIndex: number; displayPath: string }>(
          "get_tiff_page",
          { path: view.path, pageIndex: newPageIndex }
        );
        setTiffPageInfo({ totalPages: res.totalPages, currentPage: res.pageIndex });
        setView((prev) =>
          prev.kind === "image"
            ? { ...prev, src: convertFileSrc(res.displayPath) }
            : prev
        );
      } catch (e) {
        showToast(`페이지 전환 실패: ${e}`);
      }
    },
    [view, tiffPageInfo, showToast]
  );

  // 파일 열기
  const openPath = useCallback(
    (
      path: string,
      newSortBy = settingsRef.current.sortBy,
      newSortOrder = settingsRef.current.sortOrder
    ) => {
      const id = ++requestId.current;
      invoke<FolderScanResult>("open_image", {
        path,
        sortBy: newSortBy,
        sortOrder: newSortOrder,
      })
        .then(async (res) => {
          if (id !== requestId.current) return;
          setItems(res.items);
          itemsRef.current = res.items;

          setCurrentIndex(res.currentIndex);
          currentIndexRef.current = res.currentIndex;

          setLoaded(false);
          setSecondLoaded(false);
          setMeta(null);
          setSecondMeta(null);

          // 편집 상태 초기화
          setActiveCrop(null);
          setIsCropping(false);
          setActiveAdjust({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });
          setLiveAdjust({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });

          if (!settingsRef.current.keepTransform) {
            setIsFit(true);
            setRotation(0);
            setFlipH(false);
            setFlipV(false);
          }

          const currentItem = res.items[res.currentIndex] ?? {
            path,
            fileName: baseName(path),
          };

          const displayPath = await resolveDisplayablePath(currentItem.path, 0);

          setView({
            kind: "image",
            src: convertFileSrc(displayPath),
            fileName: currentItem.fileName,
            path: currentItem.path,
            isArchive: currentItem.isArchiveEntry,
          });
          setWindowTitle(currentItem.fileName, res.currentIndex, res.items.length);
          pingTopBar();
          loadDetails(currentItem.path);
          addRecentItem(currentItem.path, false);
        })
        .catch((err) => {
          if (id !== requestId.current) return;
          const fileName = baseName(path);
          setView({ kind: "error", fileName, message: String(err), path });
          setWindowTitle(fileName);
        });
    },
    [pingTopBar, loadDetails, resolveDisplayablePath]
  );

  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;

  const navigateToExplorerFolderRef = useRef<
    (folderPath: string, selectItemPath?: string) => Promise<void>
  >(() => Promise.resolve());

  // 6단계 & 9단계: 설정 업데이트 헬퍼 (탐색기와 뷰어가 같은 정렬 공유, 휠/확대/보간 즉시 반영)
  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      settingsRef.current = next;
      if (partial.theme) {
        document.documentElement.dataset.theme = partial.theme;
      }
      if (partial.defaultBg) {
        setBgMode(partial.defaultBg);
      }
      if (partial.zoomMode) {
        const el = viewerRef.current;
        const m = metaRef.current;
        if (el && m) {
          const t = getInitialTransform(
            el.clientWidth,
            el.clientHeight,
            m.naturalWidth,
            m.naturalHeight,
            rotationRef.current,
            partial.zoomMode
          );
          setTransform(t);
          setIsFit(partial.zoomMode === "fitIfLarge" || partial.zoomMode === "fitAlways");
        }
      }
      invoke("save_settings", { settings: next }).catch((err) => {
        console.error("설정 저장 실패:", err);
      });
      if (
        (partial.sortBy && partial.sortBy !== prev.sortBy) ||
        (partial.sortOrder && partial.sortOrder !== prev.sortOrder)
      ) {
        // 뷰어 모드 재정렬
        const curPath = itemsRef.current[currentIndexRef.current]?.path;
        if (curPath) {
          openPathRef.current(curPath, next.sortBy, next.sortOrder);
        }
        // 탐색기 모드 재정렬
        if (currentExplorerPath) {
          void navigateToExplorerFolderRef.current(currentExplorerPath);
        }
      }
      return next;
    });
  }, [getInitialTransform, currentExplorerPath]);

  // 14단계 A: 미저장 편집 상태 확인
  const hasUnsavedEdits = Boolean(
    activeCrop !== null ||
    activeAdjust.brightness !== 0 ||
    activeAdjust.contrast !== 0 ||
    activeAdjust.saturation !== 0 ||
    activeAdjust.sharpness !== 0 ||
    rotation !== 0 ||
    flipH ||
    flipV
  );

  // 14단계 A: 회전/반전/자르기/보정 통합 사본 저장 (원본 절대 덮어쓰지 않음)
  const handleSaveEditedCopy = useCallback(async () => {
    if (view.kind !== "image" || !view.path) return;
    try {
      const savedPath = await invoke<string>("save_edited_advanced", {
        sourcePath: view.path,
        crop: activeCrop
          ? {
              x: activeCrop.x,
              y: activeCrop.y,
              width: activeCrop.width,
              height: activeCrop.height,
            }
          : null,
        adjust: activeAdjust,
        rotation,
        flipH,
        flipV,
        targetPath: null,
      });
      showToast(`편집 사본이 저장되었습니다: ${baseName(savedPath)}`);
      setActiveCrop(null);
      setIsCropping(false);
      setActiveAdjust({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });
      setLiveAdjust({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });
      setRotation(0);
      setFlipH(false);
      setFlipV(false);
    } catch (e) {
      showToast(`사본 저장 실패: ${e}`);
    }
  }, [view, activeCrop, activeAdjust, rotation, flipH, flipV, showToast]);

  // 인덱스 이동 (미저장 편집 확인 포함)
  const navigateToIndex = useCallback(
    async (nextIdx: number, force = false) => {
      const curItems = itemsRef.current;
      if (curItems.length === 0) return;

      // 14단계 A: 미저장 변경 사항이 있으면 확인 모달 띄우기
      if (!force && hasUnsavedEdits) {
        setPendingNavigate(() => () => navigateToIndex(nextIdx, true));
        return;
      }

      if (nextIdx < 0) {
        if (settingsRef.current.autoNextFolder && curItems[0]?.path && !curItems[0]?.isArchiveEntry) {
          try {
            const prevPath = await invoke<string | null>("get_prev_folder_last_image", {
              currentPath: curItems[0].path,
            });
            if (prevPath) {
              showToast("이전 폴더로 이동합니다");
              openPathRef.current(prevPath);
              return;
            }
          } catch {
            // fallback
          }
        }
        showToast("첫 번째 이미지입니다");
        return;
      }

      if (nextIdx >= curItems.length) {
        if (
          settingsRef.current.autoNextFolder &&
          curItems[curItems.length - 1]?.path &&
          !curItems[curItems.length - 1]?.isArchiveEntry
        ) {
          try {
            const nextPath = await invoke<string | null>("get_next_folder_first_image", {
              currentPath: curItems[curItems.length - 1].path,
            });
            if (nextPath) {
              showToast("다음 폴더로 이동합니다");
              openPathRef.current(nextPath);
              return;
            }
          } catch {
            // fallback
          }
        }
        showToast("마지막 이미지입니다");
        return;
      }

      const item = curItems[nextIdx];
      currentIndexRef.current = nextIdx;
      setCurrentIndex(nextIdx);
      setLoaded(false);
      setSecondLoaded(false);
      setMeta(null);
      setSecondMeta(null);

      // 편집 상태 초기화
      setActiveCrop(null);
      setIsCropping(false);
      setActiveAdjust({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });
      setLiveAdjust({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });

      // 9단계: keepTransform 옵션 확인 (false면 회전 및 반전 초기화)
      if (!settingsRef.current.keepTransform) {
        setIsFit(true);
        setRotation(0);
        setFlipH(false);
        setFlipV(false);
      }

      // ZIP 아카이브 내부 파일인 경우 온디맨드 추출 확인
      const actualPath = await ensureArchiveEntryPath(item);
      const displayPath = await resolveDisplayablePath(actualPath, 0);

      setView({
        kind: "image",
        src: convertFileSrc(displayPath),
        fileName: item.fileName,
        path: actualPath,
        isArchive: item.isArchiveEntry,
      });
      setWindowTitle(item.fileName, nextIdx, curItems.length);
      pingTopBar();
      loadDetails(actualPath);

      // 필름스트립 스크롤을 현재 인덱스로 이동
      if (filmstripScrollRef.current) {
        const targetScroll = nextIdx * THUMB_ITEM_WIDTH - (filmstripWidth - THUMB_ITEM_WIDTH) / 2;
        filmstripScrollRef.current.scrollTo({ left: Math.max(0, targetScroll), behavior: "smooth" });
      }
    },
    [showToast, pingTopBar, loadDetails, filmstripWidth, ensureArchiveEntryPath, hasUnsavedEdits, resolveDisplayablePath]
  );

  // 양면 보기 고려한 다음/이전 이동
  const step = isDoublePage ? 2 : 1;

  const goToNext = useCallback(() => {
    // 다중 페이지 TIFF인 경우 내부 페이지 다음으로 먼저 이동
    if (tiffPageInfo && tiffPageInfo.currentPage < tiffPageInfo.totalPages - 1) {
      void handleTiffPageChange(tiffPageInfo.currentPage + 1);
      return;
    }
    navigateToIndex(currentIndexRef.current + step);
  }, [navigateToIndex, step, tiffPageInfo, handleTiffPageChange]);

  const goToPrev = useCallback(() => {
    // 다중 페이지 TIFF인 경우 내부 페이지 이전으로 먼저 이동
    if (tiffPageInfo && tiffPageInfo.currentPage > 0) {
      void handleTiffPageChange(tiffPageInfo.currentPage - 1);
      return;
    }
    navigateToIndex(currentIndexRef.current - step);
  }, [navigateToIndex, step, tiffPageInfo, handleTiffPageChange]);

  const goToFirst = useCallback(() => {
    navigateToIndex(0);
  }, [navigateToIndex]);

  const goToLast = useCallback(() => {
    navigateToIndex(itemsRef.current.length - 1);
  }, [navigateToIndex]);

  // 미리 읽기: 앞뒤 2장 decode(), 범위를 벗어난 항목은 해제
  useEffect(() => {
    const list = items;
    const cache = preloadCacheRef.current;

    const wanted = new Set<string>();
    for (const idx of getPreloadIndices(currentIndex, list.length)) {
      const p = list[idx].path;
      if (p) wanted.add(convertFileSrc(p));
    }

    for (const [url, img] of cache) {
      if (!wanted.has(url)) {
        img.src = "";
        cache.delete(url);
      }
    }

    for (const url of wanted) {
      if (!cache.has(url)) {
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        img.decode().catch(() => {});
        cache.set(url, img);
      }
    }
  }, [currentIndex, items]);

  // 창 크기 변경 시
  useEffect(() => {
    const handleResize = () => {
      if (isFitRef.current && metaRef.current && viewerRef.current) {
        const el = viewerRef.current;
        const m = metaRef.current;
        const totalW = isDoublePage && secondMetaRef.current ? m.naturalWidth + secondMetaRef.current.naturalWidth : m.naturalWidth;
        const maxH = isDoublePage && secondMetaRef.current ? Math.max(m.naturalHeight, secondMetaRef.current.naturalHeight) : m.naturalHeight;
        const t = getFitTransform(el.clientWidth, el.clientHeight, totalW, maxH);
        setTransform(t);
      }
      if (filmstripScrollRef.current) {
        setFilmstripWidth(filmstripScrollRef.current.clientWidth);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [getFitTransform, isDoublePage]);

  const openDialog = useCallback(async () => {
    if (dialogOpen.current) return;
    dialogOpen.current = true;
    try {
      const selected = await open({
        title: "이미지 또는 압축 파일 열기",
        multiple: false,
        directory: false,
        filters: [
          { name: "지원하는 모든 파일", extensions: ALL_SUPPORTED_EXTENSIONS },
          { name: "이미지 파일", extensions: IMAGE_EXTENSIONS },
          { name: "압축 파일 (ZIP, CBZ)", extensions: ARCHIVE_EXTENSIONS },
          { name: "모든 파일", extensions: ["*"] },
        ],
      });
      if (typeof selected === "string") openPath(selected);
    } catch (err) {
      setView({ kind: "error", fileName: "", message: `파일 열기 창을 띄우지 못했습니다: ${String(err)}` });
    } finally {
      dialogOpen.current = false;
    }
  }, [openPath]);

  // 필름스트립 가상 스크롤 썸네일 로딩
  useEffect(() => {
    if (!showFilmstrip || items.length === 0) return;

    const visibleCount = Math.ceil(filmstripWidth / THUMB_ITEM_WIDTH);
    const startIdx = Math.max(0, Math.floor(filmstripScrollLeft / THUMB_ITEM_WIDTH) - 2);
    const endIdx = Math.min(items.length - 1, startIdx + visibleCount + 4);

    for (let i = startIdx; i <= endIdx; i++) {
      const it = items[i];
      if (it.path && !thumbnails[it.path]) {
        invoke<string>("get_thumbnail", { path: it.path })
          .then((thumbPath) => {
            setThumbnails((prev) => ({ ...prev, [it.path]: convertFileSrc(thumbPath) }));
          })
          .catch(() => {
            setThumbnails((prev) => ({ ...prev, [it.path]: convertFileSrc(it.path) }));
          });
      }
    }
  }, [showFilmstrip, items, filmstripScrollLeft, filmstripWidth, thumbnails]);

  // 10단계: 클립보드 이미지 파일로 저장 (Ctrl+S / Ctrl+Shift+S)
  const handleSaveClipboardImage = useCallback(async () => {
    if (view.kind !== "image" || !view.clipboardData) return;
    try {
      const targetPath = await save({
        defaultPath: "클립보드 이미지.png",
        filters: [
          { name: "PNG 이미지", extensions: ["png"] },
          { name: "JPEG 이미지", extensions: ["jpg"] },
          { name: "WebP 이미지", extensions: ["webp"] },
        ],
      });
      if (!targetPath) return;
      await invoke("save_clipboard_image", {
        base64Data: view.clipboardData,
        targetPath,
      });
      showToast(`파일이 저장되었습니다: ${baseName(targetPath)}`);
      addRecentItem(targetPath, false);
      setView((v) => ({
        ...v,
        path: targetPath,
        fileName: baseName(targetPath),
        src: convertFileSrc(targetPath),
        isClipboard: false,
        clipboardData: undefined,
      }));
      setWindowTitle(baseName(targetPath));
    } catch (e: any) {
      showToast(`저장 실패: ${String(e)}`);
    }
  }, [view, addRecentItem, showToast]);

  // 5단계: 현재 이미지 회전 사본 저장 (Ctrl+S)
  const saveRotatedCopy = useCallback(async () => {
    if (view.kind === "image" && view.isClipboard) {
      void handleSaveClipboardImage();
      return;
    }
    if (view.kind !== "image" || !view.path || view.isArchive) {
      showToast("압축 파일 내 이미지는 사본 저장을 지원하지 않습니다.");
      return;
    }
    if (rotation === 0 && !flipH && !flipV) {
      showToast("회전 또는 반전되지 않은 원본 상태입니다.");
      return;
    }
    try {
      const savedPath = await invoke<string>("save_rotated_image", {
        sourcePath: view.path,
        rotation,
        flipH,
        flipV,
      });
      showToast(`사본 저장 완료: ${baseName(savedPath)}`);
    } catch (err) {
      showToast(`사본 저장 실패: ${String(err)}`);
    }
  }, [view, rotation, flipH, flipV, showToast]);

  // 8단계: 탐색기 폴더 이동
  const navigateToExplorerFolder = useCallback(
    async (folderPath: string, selectItemPath?: string) => {
      if (!folderPath) return;
      try {
        const res = await invoke<ExplorerFolderResult>("scan_explorer_folder", {
          folderPath,
          sortBy: settingsRef.current.sortBy,
          sortOrder: settingsRef.current.sortOrder,
        });
        setCurrentExplorerPath(res.currentPath);
        setAddressInput(res.currentPath);
        setIsEditingAddress(false);
        setExplorerResult(res);

        // 마지막 방문 폴더 저장
        updateSettings({ lastFolder: res.currentPath });
        addRecentItem(res.currentPath, true);

        // 실시간 폴더 감시 등록 (notify)
        await invoke("watch_folder", { folderPath: res.currentPath }).catch((err) => {
          console.warn("watch_folder 실패:", err);
        });

        // 특정 아이템 선택 및 스크롤
        if (selectItemPath) {
          setSelectedPaths(new Set([selectItemPath]));
          const idx = res.items.findIndex(
            (it) => it.path.toLowerCase() === selectItemPath.toLowerCase()
          );
          if (idx !== -1) {
            setFocusedIndex(idx);
            setLastClickedIndex(idx);
            setTimeout(() => {
              const el = gridContainerRef.current;
              if (el) {
                const itemWidth = thumbnailSize + 16;
                const itemHeight = thumbnailSize + 52;
                const cols = Math.max(1, Math.floor(el.clientWidth / itemWidth));
                const row = Math.floor(idx / cols);
                el.scrollTop = row * itemHeight;
              }
            }, 60);
          }
        } else {
          setSelectedPaths(new Set());
          setFocusedIndex(-1);
          setLastClickedIndex(-1);
        }
      } catch (err) {
        showToast(`폴더를 열 수 없습니다: ${String(err)}`);
      }
    },
    [thumbnailSize, updateSettings, showToast]
  );

  navigateToExplorerFolderRef.current = navigateToExplorerFolder;

  // 상위 폴더로 이동
  const goToParentFolder = useCallback(() => {
    if (explorerResult?.parentPath) {
      navigateToExplorerFolder(explorerResult.parentPath);
    }
  }, [explorerResult, navigateToExplorerFolder]);

  // 탐색기 새로고침
  const refreshExplorer = useCallback(() => {
    if (currentExplorerPath) {
      navigateToExplorerFolder(currentExplorerPath);
    }
  }, [currentExplorerPath, navigateToExplorerFolder]);

  // 서브폴더 펼치기/접기
  const toggleFolderExpand = useCallback(
    async (path: string) => {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });

      if (!subfoldersMap[path]) {
        try {
          const subs = await invoke<SubfolderItem[]>("get_subfolders", { folderPath: path });
          setSubfoldersMap((prev) => ({ ...prev, [path]: subs }));
        } catch (err) {
          console.error("서브폴더 로드 실패:", err);
        }
      }
    },
    [subfoldersMap]
  );

  // 10단계: 파일 형식 필터에 따른 탐색기 아이템 필터링
  const filteredExplorerItems = useMemo(() => {
    if (!explorerResult?.items) return [];
    const filter = settings.explorerFilter || "all";
    if (filter === "all") return explorerResult.items;
    return explorerResult.items.filter((item) => {
      if (item.kind === "folder") return true; // 폴더는 항상 표시
      const ext = item.extension.toLowerCase();
      if (filter === "jpg") return ext === "jpg" || ext === "jpeg" || ext === "jfif";
      if (filter === "png") return ext === "png";
      if (filter === "gif") return ext === "gif";
      if (filter === "webp") return ext === "webp";
      if (filter === "other") {
        return !["jpg", "jpeg", "jfif", "png", "gif", "webp"].includes(ext);
      }
      return true;
    });
  }, [explorerResult?.items, settings.explorerFilter]);

  // 탐색기에서 선택된 항목을 뷰어로 열기
  const openSelectedInViewer = useCallback(() => {
    if (!explorerResult) return;
    const firstSelected = filteredExplorerItems.find((it) => selectedPaths.has(it.path));
    if (!firstSelected) return;

    if (firstSelected.kind === "image" || firstSelected.kind === "cad") {
      setAppMode("viewer");
      openPath(firstSelected.path);
    } else {
      navigateToExplorerFolder(firstSelected.path);
    }
  }, [explorerResult, filteredExplorerItems, selectedPaths, openPath, navigateToExplorerFolder]);

  // 뷰어에서 탐색기로 복귀
  const returnToExplorer = useCallback(() => {
    setAppMode("explorer");
    const currentViewerPath = view.kind === "image" ? view.path : null;
    if (currentViewerPath) {
      const parentDir = currentViewerPath.replace(/[\\/][^\\/]+$/, "");
      if (
        currentExplorerPath &&
        parentDir.toLowerCase() === currentExplorerPath.toLowerCase() &&
        explorerResult
      ) {
        setSelectedPaths(new Set([currentViewerPath]));
        const idx = filteredExplorerItems.findIndex(
          (it) => it.path.toLowerCase() === currentViewerPath.toLowerCase()
        );
        if (idx !== -1) {
          setFocusedIndex(idx);
          setLastClickedIndex(idx);
          setTimeout(() => {
            const el = gridContainerRef.current;
            if (el) {
              const itemWidth = thumbnailSize + 16;
              const itemHeight = thumbnailSize + 52;
              const cols = Math.max(1, Math.floor(el.clientWidth / itemWidth));
              const row = Math.floor(idx / cols);
              el.scrollTop = row * itemHeight;
            }
          }, 60);
        }
      } else {
        navigateToExplorerFolder(parentDir, currentViewerPath);
      }
    }
  }, [view, currentExplorerPath, explorerResult, filteredExplorerItems, thumbnailSize, navigateToExplorerFolder]);

  // 탐색기 그리드 항목 클릭
  const handleExplorerItemClick = useCallback(
    (e: React.MouseEvent, item: ExplorerItem, index: number) => {
      e.stopPropagation();
      setFocusedIndex(index);

      if (e.ctrlKey || e.metaKey) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(item.path)) next.delete(item.path);
          else next.add(item.path);
          return next;
        });
        setLastClickedIndex(index);
      } else if (e.shiftKey && lastClickedIndex !== -1 && explorerResult) {
        const start = Math.min(lastClickedIndex, index);
        const end = Math.max(lastClickedIndex, index);
        const rangePaths = filteredExplorerItems.slice(start, end + 1).map((i) => i.path);
        setSelectedPaths(new Set(rangePaths));
      } else {
        setSelectedPaths(new Set([item.path]));
        setLastClickedIndex(index);
      }

      if (item.kind === "image" || item.kind === "cad") {
        loadDetails(item.path);
      }
    },
    [lastClickedIndex, explorerResult, filteredExplorerItems, loadDetails]
  );

  // 탐색기 그리드 더블클릭
  const handleExplorerItemDoubleClick = useCallback(
    (item: ExplorerItem) => {
      if (item.kind === "image" || item.kind === "cad") {
        setAppMode("viewer");
        openPath(item.path);
      } else {
        navigateToExplorerFolder(item.path);
      }
    },
    [openPath, navigateToExplorerFolder]
  );

  // 탐색기 방향키 이동
  const handleGridKeyNavigation = useCallback(
    (code: string) => {
      if (filteredExplorerItems.length === 0) return;
      const el = gridContainerRef.current;
      const itemWidth = thumbnailSize + 16;
      const itemHeight = thumbnailSize + 52;
      const cols = el ? Math.max(1, Math.floor(el.clientWidth / itemWidth)) : 4;
      const total = filteredExplorerItems.length;

      let nextIdx = focusedIndex;
      if (nextIdx === -1) nextIdx = 0;
      else {
        if (code === "ArrowRight") nextIdx = Math.min(total - 1, nextIdx + 1);
        else if (code === "ArrowLeft") nextIdx = Math.max(0, nextIdx - 1);
        else if (code === "ArrowDown") nextIdx = Math.min(total - 1, nextIdx + cols);
        else if (code === "ArrowUp") nextIdx = Math.max(0, nextIdx - cols);
      }

      setFocusedIndex(nextIdx);
      setLastClickedIndex(nextIdx);
      const targetItem = filteredExplorerItems[nextIdx];
      if (targetItem) {
        setSelectedPaths(new Set([targetItem.path]));
        if (targetItem.kind === "image") {
          loadDetails(targetItem.path);
        }
        if (el) {
          const row = Math.floor(nextIdx / cols);
          const itemTop = row * itemHeight;
          const itemBottom = itemTop + itemHeight;
          if (itemTop < el.scrollTop) {
            el.scrollTop = itemTop;
          } else if (itemBottom > el.scrollTop + el.clientHeight) {
            el.scrollTop = itemBottom - el.clientHeight;
          }
        }
      }
    },
    [filteredExplorerItems, focusedIndex, thumbnailSize, loadDetails]
  );

  // 5단계 & 8단계: 휴지통으로 삭제 실행 (단일/다중 대응)
  const executeDeleteToTrash = useCallback(async () => {
    setShowDeleteModal(false);
    if (appMode === "viewer") {
      if (view.kind !== "image" || !view.path || view.isArchive) {
        showToast("압축 파일 내부 이미지는 삭제할 수 없습니다.");
        return;
      }
      const targetPath = view.path;
      try {
        await invoke("delete_to_trash", { path: targetPath });
        setUndoCount((c) => Math.min(20, c + 1));
        showToast("휴지통으로 이동했습니다.");

        // 목록에서 제거 후 다음 파일로 이동
        const remaining = items.filter((_, idx) => idx !== currentIndex);
        if (remaining.length === 0) {
          setItems([]);
          itemsRef.current = [];
          setView({ kind: "empty" });
          setWindowTitle();
          return;
        }
        setItems(remaining);
        itemsRef.current = remaining;
        const nextIdx = Math.min(currentIndex, remaining.length - 1);
        navigateToIndex(nextIdx);
      } catch (err) {
        showToast(`삭제 실패: ${String(err)}`);
      }
    } else {
      if (selectedPaths.size === 0) return;
      const pathsToDelete = Array.from(selectedPaths);
      try {
        await invoke("delete_paths_to_trash", { paths: pathsToDelete });
        setUndoCount((c) => Math.min(20, c + 1));
        showToast(`${pathsToDelete.length}개 항목을 휴지통으로 이동했습니다.`);
        setSelectedPaths(new Set());
        refreshExplorer();
      } catch (err) {
        showToast(`삭제 실패: ${String(err)}`);
      }
    }
  }, [
    appMode,
    view,
    items,
    currentIndex,
    selectedPaths,
    showToast,
    navigateToIndex,
    refreshExplorer,
  ]);

  // 5단계: 현재 이미지 클립보드 복사 (Ctrl+C)
  const copyImageToClipboard = useCallback(async () => {
    if (view.kind !== "image") return;
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = view.src;
      await img.decode();

      const canvas = document.createElement("canvas");
      const isSideways = rotation === 90 || rotation === 270;
      canvas.width = isSideways ? img.naturalHeight : img.naturalWidth;
      canvas.height = isSideways ? img.naturalWidth : img.naturalHeight;

      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("캔버스를 생성할 수 없습니다.");

      ctx.translate(canvas.width / 2, canvas.height / 2);
      if (flipH || flipV) {
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
      }
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

      canvas.toBlob((blob) => {
        if (blob) {
          navigator.clipboard
            .write([new ClipboardItem({ "image/png": blob })])
            .then(() => showToast("이미지를 클립보드에 복사했습니다."))
            .catch((e) => showToast(`클립보드 복사 실패: ${e}`));
        }
      }, "image/png");
    } catch (err) {
      showToast(`이미지 복사 실패: ${String(err)}`);
    }
  }, [view, rotation, flipH, flipV, showToast]);

  // 5단계: 파일 경로 텍스트 복사 (Ctrl+Shift+C)
  const copyPathToClipboard = useCallback(() => {
    if (view.kind !== "image" || !view.path) return;
    navigator.clipboard
      .writeText(view.path)
      .then(() => showToast("파일 경로를 복사했습니다."))
      .catch((e) => showToast(`경로 복사 실패: ${e}`));
  }, [view, showToast]);

  // 5단계: 배경색 순환 전환 (KeyB)
  const cycleBgMode = useCallback(() => {
    setBgMode((prev) => {
      if (prev === "black") return "dark";
      if (prev === "dark") return "checker";
      return "black";
    });
  }, []);

  // 7단계: 전체화면 상태 동기화
  useEffect(() => {
    const syncFullscreen = async () => {
      try {
        const full = await getCurrentWindow().isFullscreen();
        setIsFullscreen(full);
      } catch {
        setIsFullscreen(Boolean(document.fullscreenElement));
      }
    };
    window.addEventListener("resize", syncFullscreen);
    return () => window.removeEventListener("resize", syncFullscreen);
  }, []);

  // 7단계: 컨텍스트 메뉴 외부 클릭 또는 창 크기 변경 시 닫기
  useEffect(() => {
    if (!contextMenu) return;
    const onMouseDownWindow = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".context-menu")) {
        setContextMenu(null);
      }
    };
    const onResizeWindow = () => {
      setContextMenu(null);
    };
    window.addEventListener("mousedown", onMouseDownWindow);
    window.addEventListener("resize", onResizeWindow);
    return () => {
      window.removeEventListener("mousedown", onMouseDownWindow);
      window.removeEventListener("resize", onResizeWindow);
    };
  }, [contextMenu]);

  // 7단계/버그수정: 화면 하단에서 우클릭 시 메뉴가 잘리지 않도록 위/아래 방향 및 위치 자동 보정
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const el = contextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const margin = 10;

    // 아래쪽 공간이 부족하면 마우스 커서 위로 열기
    const openUpwards = contextMenu.y + rect.height > winH - margin;
    let top = openUpwards ? contextMenu.y - rect.height : contextMenu.y;
    // 상하단 뷰포트 경계 벗어나지 않도록 보정
    top = Math.max(margin, Math.min(top, winH - rect.height - margin));

    // 오른쪽 공간이 부족하면 왼쪽으로 열기
    const alignRight = contextMenu.x + rect.width > winW - margin;
    let left = alignRight ? contextMenu.x - rect.width : contextMenu.x;
    left = Math.max(margin, Math.min(left, winW - rect.width - margin));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
    el.classList.toggle("open-upwards", openUpwards);
    el.classList.toggle("align-right", alignRight);
    el.style.transformOrigin = `${alignRight ? "right" : "left"} ${openUpwards ? "bottom" : "top"}`;
  }, [contextMenu]);

  // 탐색기에서 보기 (현재 보고 있는 파일 또는 상세정보 파일)
  const handleShowInFolder = useCallback(() => {
    const targetPath = (view.kind === "image" ? view.path : "") || imageDetails?.path;
    if (targetPath) {
      invoke("show_in_folder", { path: targetPath }).catch((err) => {
        showToast(String(err));
      });
    }
  }, [view, imageDetails, showToast]);

  // 9단계: 다른 이름으로 저장 (Ctrl+Shift+S)
  const openSaveAsModal = useCallback((prefillW?: number, prefillH?: number) => {
    if (view.kind === "image" && view.isClipboard) {
      void handleSaveClipboardImage();
      return;
    }
    if (view.kind !== "image" || !view.path || view.isArchive) {
      showToast("저장할 수 있는 이미지가 아닙니다.");
      return;
    }
    const dotIdx = view.path.lastIndexOf(".");
    const baseWithoutExt = dotIdx !== -1 ? view.path.slice(0, dotIdx) : view.path;
    const ext = dotIdx !== -1 ? view.path.slice(dotIdx + 1).toLowerCase() : "jpg";
    const initFmt = ["png", "webp", "bmp"].includes(ext) ? (ext as "png" | "webp" | "bmp") : "jpg";

    setSaveAsFormat(initFmt);
    setSaveAsTargetPath(`${baseWithoutExt}_copy.${initFmt}`);
    setSaveAsQuality(90);
    setSaveAsResizeW(prefillW);
    setSaveAsResizeH(prefillH);
    setShowSaveAsModal(true);
  }, [view, showToast]);

  const handleBrowseSaveTarget = useCallback(async () => {
    try {
      const selected = await save({
        title: "다른 이름으로 저장",
        defaultPath: saveAsTargetPath,
        filters: [
          { name: `${saveAsFormat.toUpperCase()} 이미지`, extensions: [saveAsFormat] },
          { name: "모든 파일", extensions: ["*"] },
        ],
      });
      if (selected) {
        setSaveAsTargetPath(selected);
      }
    } catch (err) {
      console.error("저장 경로 선택 실패:", err);
    }
  }, [saveAsTargetPath, saveAsFormat]);

  const executeSaveAs = useCallback(async () => {
    if (view.kind !== "image" || !view.path || !saveAsTargetPath) return;
    try {
      let saved: string;
      const hasCropOrAdjust =
        activeCrop !== null ||
        activeAdjust.brightness !== 0 ||
        activeAdjust.contrast !== 0 ||
        activeAdjust.saturation !== 0 ||
        activeAdjust.sharpness !== 0;

      if (hasCropOrAdjust) {
        saved = await invoke<string>("save_edited_advanced", {
          sourcePath: view.path,
          crop: activeCrop
            ? {
                x: activeCrop.x,
                y: activeCrop.y,
                width: activeCrop.width,
                height: activeCrop.height,
              }
            : null,
          adjust: activeAdjust,
          rotation,
          flipH,
          flipV,
          targetPath: saveAsTargetPath,
        });
        setActiveCrop(null);
        setIsCropping(false);
        setActiveAdjust({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });
        setLiveAdjust({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });
      } else {
        saved = await invoke<string>("save_image_advanced", {
          sourcePath: view.path,
          targetPath: saveAsTargetPath,
          format: saveAsFormat,
          quality: saveAsQuality,
          rotation,
          flipH,
          flipV,
          resizeWidth: saveAsResizeW && saveAsResizeW > 0 ? saveAsResizeW : null,
          resizeHeight: saveAsResizeH && saveAsResizeH > 0 ? saveAsResizeH : null,
        });
      }
      showToast(`저장 완료: ${baseName(saved)}`);
      setShowSaveAsModal(false);
    } catch (err) {
      showToast(`저장 실패: ${String(err)}`);
    }
  }, [
    view,
    saveAsTargetPath,
    saveAsFormat,
    saveAsQuality,
    rotation,
    flipH,
    flipV,
    saveAsResizeW,
    saveAsResizeH,
    activeCrop,
    activeAdjust,
    showToast,
  ]);

  // 9단계: 크기 조정 (Ctrl+R)
  const openResizeModal = useCallback(() => {
    if (view.kind !== "image" || !meta) {
      showToast("크기를 조정할 이미지가 없습니다.");
      return;
    }
    setResizeCustomW(meta.naturalWidth);
    setResizeCustomH(meta.naturalHeight);
    setResizeUnit("pixel");
    setResizeKeepRatio(true);
    setShowResizeModal(true);
  }, [view.kind, meta, showToast]);

  // 9단계: 인쇄 (Ctrl+P)
  const handlePrint = useCallback(() => {
    if (view.kind !== "image") return;
    window.print();
  }, [view.kind]);

  // 9단계: 슬라이드쇼 (KeyS)
  const toggleSlideshow = useCallback(async () => {
    if (isSlideshowActive) {
      setIsSlideshowActive(false);
      setIsSlideshowPaused(false);
    } else {
      if (itemsRef.current.length === 0) return;
      setIsSlideshowActive(true);
      setIsSlideshowPaused(false);
      setSlideshowRemainingSec(settingsRef.current.slideshowInterval || 3);
      setShowSlideshowBadge(true);
      try {
        const win = getCurrentWindow();
        if (!(await win.isFullscreen())) {
          await win.setFullscreen(true);
          setIsFullscreen(true);
        }
      } catch {
        // fallback
      }
    }
  }, [isSlideshowActive]);

  const stopSlideshow = useCallback(() => {
    setIsSlideshowActive(false);
    setIsSlideshowPaused(false);
  }, []);

  // 슬라이드쇼 타이머
  useEffect(() => {
    if (!isSlideshowActive) return;
    const badgeTimer = window.setTimeout(() => {
      setShowSlideshowBadge(false);
    }, 2000);
    return () => window.clearTimeout(badgeTimer);
  }, [isSlideshowActive, currentIndex, isSlideshowPaused]);

  useEffect(() => {
    if (!isSlideshowActive || isSlideshowPaused) return;
    const timer = window.setInterval(() => {
      setSlideshowRemainingSec((prev) => {
        if (prev <= 1) {
          const curItems = itemsRef.current;
          const curIdx = currentIndexRef.current;
          const isRandom = settingsRef.current.slideshowRandom;
          const isLoop = settingsRef.current.slideshowLoop;

          if (isRandom && curItems.length > 1) {
            let nextRand = curIdx;
            while (nextRand === curIdx) {
              nextRand = Math.floor(Math.random() * curItems.length);
            }
            navigateToIndex(nextRand);
          } else {
            const nextIdx = curIdx + 1;
            if (nextIdx >= curItems.length) {
              if (isLoop) {
                navigateToIndex(0);
              } else {
                setIsSlideshowActive(false);
                showToast("슬라이드쇼가 종료되었습니다.");
                return 0;
              }
            } else {
              navigateToIndex(nextIdx);
            }
          }
          return settingsRef.current.slideshowInterval || 3;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isSlideshowActive, isSlideshowPaused, navigateToIndex, showToast]);

  // 10단계: 이름 바꾸기(F2)
  const openRenameModal = useCallback(
    (target?: { path: string; oldName: string; isDir?: boolean }) => {
      let targetItem = target;
      if (!targetItem) {
        if (appMode === "viewer") {
          if (view.kind === "image" && view.path && !view.isArchive) {
            targetItem = {
              path: view.path,
              oldName: view.fileName || baseName(view.path),
              isDir: false,
            };
          }
        } else {
          // 탐색기 모드에서 2개 이상 선택되어 있다면 일괄 이름 바꾸기 모달 즉시 실행
          if (!target && selectedPaths.size > 1) {
            setBatchModalState({ mode: "rename", paths: Array.from(selectedPaths) });
            return;
          }
          if (selectedPaths.size > 0 && explorerResult) {
            const firstSelectedPath = Array.from(selectedPaths)[0];
            const it = filteredExplorerItems.find((item) => item.path === firstSelectedPath);
            if (it) {
              targetItem = { path: it.path, oldName: it.name, isDir: it.kind === "folder" };
            }
          }
        }
      }
      if (!targetItem) {
        showToast("이름을 변경할 대상을 선택해주세요.");
        return;
      }
      setRenameTargetItem(targetItem);
      setRenameNewName(targetItem.oldName);
      setRenameError(null);
      setShowRenameModal(true);
      setTimeout(() => {
        if (renameInputRef.current) {
          renameInputRef.current.focus();
          if (!targetItem?.isDir) {
            const lastDot = targetItem.oldName.lastIndexOf(".");
            if (lastDot > 0) {
              renameInputRef.current.setSelectionRange(0, lastDot);
              return;
            }
          }
          renameInputRef.current.select();
        }
      }, 50);
    },
    [appMode, view, selectedPaths, explorerResult, filteredExplorerItems, showToast]
  );

  const executeRename = useCallback(async () => {
    if (!renameTargetItem) return;
    const trimmed = renameNewName.trim();
    const err = validateFileName(trimmed);
    if (err) {
      setRenameError(err);
      return;
    }
    if (trimmed === renameTargetItem.oldName) {
      setShowRenameModal(false);
      return;
    }
    try {
      const newPath = await invoke<string>("rename_file", {
        oldPath: renameTargetItem.path,
        newName: trimmed,
      });
      setUndoCount((c) => Math.min(20, c + 1));
      setShowRenameModal(false);
      showToast(`이름 변경 완료: ${trimmed}`);

      addRecentItem(newPath, Boolean(renameTargetItem.isDir));

      if (appMode === "viewer" && view.kind === "image" && view.path === renameTargetItem.path) {
        setView((v) => ({
          ...v,
          path: newPath,
          fileName: baseName(newPath),
          src: convertFileSrc(newPath),
        }));
        setItems((prev) =>
          prev.map((it) =>
            it.path === renameTargetItem.path
              ? { ...it, path: newPath, fileName: baseName(newPath) }
              : it
          )
        );
        setWindowTitle(baseName(newPath), currentIndex, items.length);
      }

      if (appMode === "explorer") {
        await refreshExplorer();
        setSelectedPaths(new Set([newPath]));
      }
    } catch (e: any) {
      setRenameError(String(e));
    }
  }, [
    renameTargetItem,
    renameNewName,
    addRecentItem,
    appMode,
    view,
    currentIndex,
    items.length,
    refreshExplorer,
    showToast,
  ]);

  // 10단계: 폴더로 복사(F7) / 폴더로 이동(F8)
  const openCopyMoveModal = useCallback(
    (mode: "copy" | "move") => {
      let paths: string[] = [];
      if (appMode === "viewer") {
        if (view.kind === "image" && view.path) {
          if (mode === "move" && view.isArchive) {
            showToast("압축 파일 내부 이미지는 이동할 수 없습니다.");
            return;
          }
          paths = [view.path];
        }
      } else {
        paths = Array.from(selectedPaths);
      }
      if (paths.length === 0) {
        showToast(mode === "copy" ? "복사할 항목을 선택해주세요." : "이동할 항목을 선택해주세요.");
        return;
      }
      setCopyMoveMode(mode);
      setCopyMoveSourcePaths(paths);
      setCopyMoveTargetFolder(settings.recentTargetFolders?.[0] || "");
      setCopyMoveConflict("rename");
      setShowCopyMoveModal(true);
    },
    [appMode, view, selectedPaths, settings.recentTargetFolders, showToast]
  );

  const handleBrowseCopyMoveTarget = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setCopyMoveTargetFolder(selected);
    }
  }, []);

  const executeCopyMove = useCallback(async () => {
    const target = copyMoveTargetFolder.trim();
    if (!target) {
      showToast("대상 폴더를 지정해주세요.");
      return;
    }
    try {
      const cmdName =
        copyMoveMode === "copy" ? "copy_files_to_folder" : "move_files_to_folder";
      const res = await invoke<string[]>(cmdName, {
        sourcePaths: copyMoveSourcePaths,
        targetFolder: target,
        conflictMode: copyMoveConflict,
      });

      const updatedTargets = [
        target,
        ...(settings.recentTargetFolders || []).filter((f) => f !== target),
      ].slice(0, 5);
      updateSettings({ recentTargetFolders: updatedTargets });

      if (copyMoveMode === "move") {
        setUndoCount((c) => Math.min(20, c + 1));
        showToast(`${res.length}개 항목 이동 완료`);
        if (appMode === "viewer") {
          goToNext();
        } else {
          await refreshExplorer();
        }
      } else {
        showToast(`${res.length}개 항목 복사 완료`);
      }

      setShowCopyMoveModal(false);
    } catch (e: any) {
      showToast(String(e));
    }
  }, [
    copyMoveTargetFolder,
    copyMoveMode,
    copyMoveSourcePaths,
    copyMoveConflict,
    settings.recentTargetFolders,
    updateSettings,
    showToast,
    appMode,
    goToNext,
    refreshExplorer,
  ]);

  // 10단계: 새 폴더 만들기 (Ctrl+Shift+N)
  const handleCreateNewFolder = useCallback(async () => {
    if (appMode !== "explorer" || !currentExplorerPath) return;
    try {
      const newPath = await invoke<string>("create_new_folder", {
        parentPath: currentExplorerPath,
        folderName: null,
      });
      showToast(`새 폴더 생성 완료: ${baseName(newPath)}`);
      await refreshExplorer();
      setSelectedPaths(new Set([newPath]));
      openRenameModal({ path: newPath, oldName: baseName(newPath), isDir: true });
    } catch (e: any) {
      showToast(String(e));
    }
  }, [appMode, currentExplorerPath, refreshExplorer, openRenameModal, showToast]);

  // 10단계: 실행 취소 (Ctrl+Z)
  const handleUndo = useCallback(async () => {
    try {
      const msg = await invoke<string>("undo_last_action");
      showToast(msg);
      setUndoCount((c) => Math.max(0, c - 1));
      if (appMode === "explorer") {
        await refreshExplorer();
      } else if (appMode === "viewer") {
        if (view.kind === "image" && view.path) {
          openPath(view.path);
        } else if (currentExplorerPath) {
          openPath(currentExplorerPath);
        }
      }
    } catch (e: any) {
      showToast(String(e));
    }
  }, [appMode, view, currentExplorerPath, refreshExplorer, openPath, showToast]);

  // 10단계: 외부 편집기로 열기 (Ctrl+E)
  const handleOpenExternalEditor = useCallback(
    async (customAppPath?: string) => {
      let targetPath = "";
      if (appMode === "viewer") {
        if (view.kind === "image" && view.path && !view.isArchive) {
          targetPath = view.path;
        }
      } else {
        if (selectedPaths.size > 0) {
          targetPath = Array.from(selectedPaths)[0];
        }
      }
      if (!targetPath) {
        showToast("열 대상 이미지가 없습니다.");
        return;
      }
      try {
        await invoke("open_in_external_editor", {
          path: targetPath,
          customApp: customAppPath || null,
        });
      } catch (e: any) {
        showToast(String(e));
      }
    },
    [appMode, view, selectedPaths, showToast]
  );

  // 10단계: 바탕화면 배경으로 설정 (우클릭 메뉴)
  const handleSetWallpaper = useCallback(
    async (style: "fill" | "fit" | "center") => {
      if (view.kind !== "image") return;
      try {
        await invoke("set_as_desktop_wallpaper", {
          imagePath: view.path,
          style,
          isArchive: Boolean(view.isArchive),
          archivePath: view.isArchive ? view.path : null,
          entryName: view.isArchive ? view.fileName : null,
        });
        showToast(
          `바탕화면 배경으로 설정되었습니다 (${
            style === "fill" ? "채우기" : style === "fit" ? "맞춤" : "가운데"
          })`
        );
      } catch (e: any) {
        showToast(`바탕화면 설정 실패: ${String(e)}`);
      }
    },
    [view, showToast]
  );

  // 10단계: 탐색기 모드에서 Ctrl+C (파일 복사)
  const handleExplorerCopyFiles = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    try {
      const paths = Array.from(selectedPaths);
      await invoke("copy_files_to_clipboard", { paths });
      showToast(`${paths.length}개 파일 복사 완료 (윈도우 탐색기에서 붙여넣기 가능)`);
    } catch (e: any) {
      showToast(String(e));
    }
  }, [selectedPaths, showToast]);

  // 10단계: 클립보드 붙여넣기 (Ctrl+V)
  const handleClipboardPaste = useCallback(async () => {
    if (appMode === "explorer") {
      if (!currentExplorerPath) return;
      try {
        const pasted = await invoke<string[]>("paste_files_from_clipboard", {
          targetFolder: currentExplorerPath,
        });
        if (pasted.length > 0) {
          showToast(`${pasted.length}개 파일 붙여넣기 완료`);
          await refreshExplorer();
        } else {
          showToast("클립보드에 복사된 파일이 없습니다.");
        }
      } catch (e: any) {
        showToast(String(e));
      }
    } else {
      // 뷰어 모드: 캡처된 클립보드 이미지 열기
      try {
        const clipboardItems = await navigator.clipboard.read();
        for (const item of clipboardItems) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (imageType) {
            const blob = await item.getType(imageType);
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result as string;
              setAppMode("viewer");
              setView({
                kind: "image",
                src: dataUrl,
                fileName: "클립보드 이미지",
                path: "",
                isArchive: false,
                isClipboard: true,
                clipboardData: dataUrl,
              });
              setCurrentIndex(-1);
              setWindowTitle("클립보드 이미지");
              showToast("클립보드 이미지를 열었습니다. (Ctrl+S로 저장)");
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
        showToast("클립보드에 이미지가 없습니다.");
      } catch (err) {
        showToast("클립보드 이미지를 읽을 수 없습니다: " + String(err));
      }
    }
  }, [appMode, currentExplorerPath, refreshExplorer, showToast]);

  // 10단계: 최근 열어본 항목 클릭 처리 (파일 부재 시 목록에서 제거)
  const handleOpenRecentItem = useCallback(
    async (item: RecentItem) => {
      setShowRecentDropdown(false);
      try {
        const exists = await invoke<boolean>("check_path_exists", { path: item.path });
        if (!exists) {
          showToast("파일/폴더를 찾을 수 없어 목록에서 제거합니다.");
          setSettings((prev) => {
            const updated = (prev.recentItems || []).filter((i) => i.path !== item.path);
            const newSettings = { ...prev, recentItems: updated };
            invoke("save_settings", { settings: newSettings }).catch(console.error);
            return newSettings;
          });
          return;
        }
        if (item.isFolder) {
          setAppMode("explorer");
          navigateToExplorerFolder(item.path);
        } else {
          setAppMode("viewer");
          openPath(item.path);
        }
      } catch {
        showToast("열기 실패: 파일/폴더를 확인할 수 없습니다.");
      }
    },
    [navigateToExplorerFolder, openPath, showToast]
  );

  // 최근 항목 존재 여부 일괄 검사
  useEffect(() => {
    if (showRecentDropdown || appMode === "explorer") {
      const rItems = settings.recentItems || [];
      if (rItems.length === 0) return;
      Promise.all(
        rItems.map(async (item) => {
          try {
            const exists = await invoke<boolean>("check_path_exists", { path: item.path });
            return [item.path, exists] as const;
          } catch {
            return [item.path, false] as const;
          }
        })
      ).then((pairs) => {
        setItemExistsMap(Object.fromEntries(pairs));
      });
    }
  }, [showRecentDropdown, appMode, settings.recentItems]);

  // 10단계: 즐겨찾기 폴더 토글 및 순서 변경
  const handleToggleFavoriteFolder = useCallback(
    (folderPath: string) => {
      setSettings((prev) => {
        const list = prev.favoriteFolders || [];
        const exists = list.includes(folderPath);
        const updated = exists ? list.filter((p) => p !== folderPath) : [...list, folderPath];
        const newSettings = { ...prev, favoriteFolders: updated };
        invoke("save_settings", { settings: newSettings }).catch(console.error);
        showToast(exists ? "즐겨찾기에서 제거했습니다." : "즐겨찾기에 추가했습니다.");
        return newSettings;
      });
    },
    [showToast]
  );

  const handleReorderFavoriteFolders = useCallback((fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    setSettings((prev) => {
      const list = [...(prev.favoriteFolders || [])];
      const [moved] = list.splice(fromIdx, 1);
      list.splice(toIdx, 0, moved);
      const newSettings = { ...prev, favoriteFolders: list };
      invoke("save_settings", { settings: newSettings }).catch(console.error);
      return newSettings;
    });
  }, []);

  // 10단계: 외부 편집기 등록/삭제
  const handleBrowseEditorPath = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "실행 프로그램", extensions: ["exe"] }],
    });
    if (selected && typeof selected === "string") {
      setNewEditorPath(selected);
      if (!newEditorName.trim()) {
        const base = baseName(selected).replace(/\.exe$/i, "");
        setNewEditorName(base);
      }
    }
  }, [newEditorName]);

  const handleAddExternalEditor = useCallback(() => {
    if (!newEditorName.trim() || !newEditorPath.trim()) {
      showToast("프로그램 이름과 실행 파일 경로를 모두 입력해주세요.");
      return;
    }
    const newEd: ExternalEditor = {
      id: Date.now().toString(),
      name: newEditorName.trim(),
      path: newEditorPath.trim(),
    };
    setSettings((prev) => {
      const updated = [...(prev.externalEditors || []), newEd];
      const newSettings = { ...prev, externalEditors: updated };
      invoke("save_settings", { settings: newSettings }).catch(console.error);
      return newSettings;
    });
    setNewEditorName("");
    setNewEditorPath("");
    showToast(`편집기 "${newEd.name}" 등록 완료`);
  }, [newEditorName, newEditorPath, showToast]);

  const handleRemoveExternalEditor = useCallback((id: string) => {
    setSettings((prev) => {
      const updated = (prev.externalEditors || []).filter((ed) => ed.id !== id);
      const newSettings = { ...prev, externalEditors: updated };
      invoke("save_settings", { settings: newSettings }).catch(console.error);
      return newSettings;
    });
  }, []);

  // 7단계 & 8단계 & 9단계 & 10단계 & 14단계 (구조 정리): 모든 명령을 단일 목록(Command Registry)에 정의
  const commandState = useMemo(
    () => ({
      appMode,
      hasImage: view.kind === "image",
      hasItems: items.length > 0,
      isArchive: view.kind === "image" && Boolean(view.isArchive),
      isDoublePage,
      showFilmstrip,
      showInfoPanel,
      isFullscreen,
      canSaveCopy: view.kind === "image" && !view.isArchive && hasUnsavedEdits,
      canGoUp: Boolean(explorerResult?.parentPath),
      hasSelectedItems: selectedPaths.size > 0,
      isSlideshowActive,
      isPixelated: settings.interpolation === "pixelated",
      isFlippedH: flipH,
      isFlippedV: flipV,
      canUndo: undoCount > 0,
      isCropping,
    }),
    [
      appMode,
      view,
      items.length,
      isDoublePage,
      showFilmstrip,
      showInfoPanel,
      isFullscreen,
      hasUnsavedEdits,
      explorerResult?.parentPath,
      selectedPaths.size,
      isSlideshowActive,
      settings.interpolation,
      flipH,
      flipV,
      undoCount,
      isCropping,
    ]
  );

  const handleCreateIdPhoto = useCallback(() => {
    if (appMode === "viewer") {
      if (view.kind === "image" && view.path) {
        setIdPhotoTargetPaths([view.path]);
      } else {
        showToast("편집할 이미지가 없습니다.");
      }
    } else {
      const imgPaths: string[] = [];
      if (selectedPaths.size > 0) {
        for (const p of selectedPaths) {
          const ext = p.split(".").pop()?.toLowerCase() || "";
          if (IMAGE_EXTENSIONS.includes(ext)) {
            imgPaths.push(p);
          }
        }
      }
      if (imgPaths.length > 0) {
        setIdPhotoTargetPaths(imgPaths);
      } else {
        showToast("선택된 이미지 파일이 없습니다.");
      }
    }
  }, [appMode, view, selectedPaths, showToast]);

  // 14단계 B: 일괄 작업 대상 파일 목록 추출 헬퍼
  const getBatchEligiblePaths = useCallback(() => {
    if (appMode === "viewer") {
      if (view.kind === "image" && view.path) {
        return [view.path];
      }
      return [];
    } else {
      const paths: string[] = [];
      if (selectedPaths.size > 0) {
        for (const p of selectedPaths) {
          const ext = p.split(".").pop()?.toLowerCase() || "";
          if (IMAGE_EXTENSIONS.includes(ext) || ext === "dwg" || ext === "dxf") {
            paths.push(p);
          }
        }
      }
      return paths;
    }
  }, [appMode, view, selectedPaths]);

  const handleOpenBatchConvert = useCallback(() => {
    const paths = getBatchEligiblePaths();
    if (paths.length === 0) {
      showToast("작업할 이미지 파일을 선택해 주세요.");
      return;
    }
    setBatchModalState({ mode: "convert", paths });
  }, [getBatchEligiblePaths, showToast]);

  const handleOpenBatchRename = useCallback(() => {
    const paths = getBatchEligiblePaths();
    if (paths.length === 0) {
      showToast("이름을 변경할 파일을 선택해 주세요.");
      return;
    }
    setBatchModalState({ mode: "rename", paths });
  }, [getBatchEligiblePaths, showToast]);

  const handleOpenBatchRotate = useCallback(() => {
    const paths = getBatchEligiblePaths();
    if (paths.length === 0) {
      showToast("회전할 이미지 파일을 선택해 주세요.");
      return;
    }
    setBatchModalState({ mode: "rotate", paths });
  }, [getBatchEligiblePaths, showToast]);

  // 14단계 C: 학교 행정실 사진 작업 핸들러
  const handleOpenMosaicEditor = useCallback(() => {
    if (appMode === "viewer") {
      if (view.kind === "image" && view.path) {
        setMosaicModalPath(view.path);
      }
    } else {
      const paths = getBatchEligiblePaths();
      if (paths.length > 0) {
        setMosaicModalPath(paths[0]);
      } else {
        showToast("모자이크를 적용할 사진을 선택해 주세요.");
      }
    }
  }, [appMode, view, getBatchEligiblePaths, showToast]);

  const handleOpenPhotoCollage = useCallback(() => {
    const paths = getBatchEligiblePaths();
    if (paths.length < 2 || paths.length > 9) {
      showToast("사진 합치기는 2장 이상 9장 이하의 사진을 선택해 주세요.");
      return;
    }
    setPhotoCollagePaths(paths);
  }, [getBatchEligiblePaths, showToast]);

  const handleOpenPdfBinding = useCallback(() => {
    const paths = getBatchEligiblePaths();
    if (paths.length === 0) {
      showToast("PDF로 묶을 사진을 선택해 주세요.");
      return;
    }
    setPdfBindingPaths(paths);
  }, [getBatchEligiblePaths, showToast]);

  const handleOpenPhotoStamp = useCallback(() => {
    const paths = getBatchEligiblePaths();
    if (paths.length === 0) {
      showToast("날짜·글자를 넣을 사진을 선택해 주세요.");
      return;
    }
    setPhotoStampPaths(paths);
  }, [getBatchEligiblePaths, showToast]);

  const commands = useMemo(
    () =>
      buildCommands(
        {
          openDialog,
          goToPrev,
          goToNext,
          goToFirst,
          goToLast,
          fitToWindow,
          setActualSize,
          zoomOut: () => zoomCenter(1 / 1.25),
          zoomIn: () => zoomCenter(1.25),
          rotateCcw: () => handleRotate(270),
          rotateCw: () => handleRotate(90),
          saveRotatedCopy: () => {
            if (hasUnsavedEdits) {
              return handleSaveEditedCopy();
            }
            return saveRotatedCopy();
          },
          requestDelete: () => {
            if (appMode === "viewer") {
              if (view.kind === "image" && view.path) setShowDeleteModal(true);
            } else {
              if (selectedPaths.size > 0) setShowDeleteModal(true);
            }
          },
          copyImageToClipboard,
          copyPathToClipboard,
          showInFolder: handleShowInFolder,
          toggleDoublePage: () => setIsDoublePage((d) => !d),
          cycleBgMode,
          toggleFilmstrip: () => setShowFilmstrip((p) => !p),
          toggleInfoPanel: () => {
            setShowInfoPanel((p) => {
              const next = !p;
              if (next && view.kind === "image" && view.path) {
                loadDetails(view.path);
              }
              return next;
            });
          },
          toggleFullscreen,
          openSettingsModal: () => setShowSettingsModal((p) => !p),
          openHelpModal: () => setShowHelpModal((p) => !p),
          explorerUp: goToParentFolder,
          explorerRefresh: refreshExplorer,
          openViewerFromExplorer: openSelectedInViewer,
          flipH: () => setFlipH((f) => !f),
          flipV: () => setFlipV((f) => !f),
          saveAs: () => openSaveAsModal(),
          createIdPhoto: handleCreateIdPhoto,
          resizeImage: () => openResizeModal(),
          printImage: handlePrint,
          toggleSlideshow,
          toggleInterpolation: () =>
            updateSettings({
              interpolation: settings.interpolation === "smooth" ? "pixelated" : "smooth",
            }),
          toggleSortMenu: () => setShowSortDropdown((p) => !p),
          // 10단계 새 액션 바인딩
          rename: () => openRenameModal(),
          copyToFolder: () => openCopyMoveModal("copy"),
          moveToFolder: () => openCopyMoveModal("move"),
          newFolder: handleCreateNewFolder,
          undo: handleUndo,
          openExternalEditor: () => void handleOpenExternalEditor(),
          setWallpaper: () => void handleSetWallpaper("fill"),
          pasteClipboard: handleClipboardPaste,
          copyFiles: handleExplorerCopyFiles,
          // 14단계 A 자르기 및 사진 보정 액션 바인딩
          startCrop: () => {
            if (view.kind === "image" && view.path) {
              setIsCropping(true);
            }
          },
          openAdjust: () => {
            if (view.kind === "image" && view.path) {
              setShowAdjustModal(true);
            }
          },
          // 14단계 B 일괄 작업 액션 바인딩
          openBatchConvert: handleOpenBatchConvert,
          openBatchRename: handleOpenBatchRename,
          openBatchRotate: handleOpenBatchRotate,
          // 14단계 C 학교 행정실 사진 작업 액션 바인딩
          openMosaicEditor: handleOpenMosaicEditor,
          openPhotoCollage: handleOpenPhotoCollage,
          openPdfBinding: handleOpenPdfBinding,
          openPhotoStamp: handleOpenPhotoStamp,
        },
        commandState
      ),
    [
      openDialog,
      goToPrev,
      goToNext,
      goToFirst,
      goToLast,
      fitToWindow,
      setActualSize,
      zoomCenter,
      handleRotate,
      saveRotatedCopy,
      handleSaveEditedCopy,
      hasUnsavedEdits,
      appMode,
      view,
      selectedPaths.size,
      copyImageToClipboard,
      copyPathToClipboard,
      handleShowInFolder,
      handleCreateIdPhoto,
      handleOpenBatchConvert,
      handleOpenBatchRename,
      handleOpenBatchRotate,
      handleOpenMosaicEditor,
      handleOpenPhotoCollage,
      handleOpenPdfBinding,
      handleOpenPhotoStamp,
      cycleBgMode,
      loadDetails,
      toggleFullscreen,
      goToParentFolder,
      refreshExplorer,
      openSelectedInViewer,
      commandState,
      openSaveAsModal,
      openResizeModal,
      handlePrint,
      toggleSlideshow,
      updateSettings,
      settings.interpolation,
      openRenameModal,
      openCopyMoveModal,
      handleCreateNewFolder,
      handleUndo,
      handleOpenExternalEditor,
      handleSetWallpaper,
      handleClipboardPaste,
      handleExplorerCopyFiles,
    ]
  );

  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  const commandMap = useMemo(() => {
    const map = new Map<CommandId, AppCommand>();
    for (const cmd of commands) {
      map.set(cmd.id, cmd);
    }
    return map;
  }, [commands]);

  // 11단계 배포 전 점검 4번: WebView2 브라우저 기본 동작 원천 차단
  useEffect(() => {
    // 1) Ctrl + 마우스 휠로 브라우저 전체 확대/축소 방지 (앱 레이아웃 깨짐 방지)
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });

    // 2) WebView2 기본 우클릭 메뉴(검사, 새로 고침, 뒤로 가기) 전역 차단
    const onGlobalContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      // 텍스트 입력창(input, textarea)을 제외한 모든 곳에서 브라우저 기본 메뉴 방지
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onGlobalContextMenu);

    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("contextmenu", onGlobalContextMenu);
    };
  }, []);

  // 키보드 단축키 (KeyboardEvent.code 기준 - 모두 명령 목록 commandsRef를 사용)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 11단계 배포 전 점검 4번: 브라우저/WebView2 기본 단축키 원천 가로채기 차단
      // 1) 새로고침 방지: F5, Ctrl+F5, Ctrl+R (앱이 첫 화면으로 초기화되는 현상 방지)
      if (e.code === "F5" || (e.ctrlKey && e.code === "KeyR")) {
        e.preventDefault();
      }
      // 2) 개발자 도구 방지: F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C
      if (
        e.code === "F12" ||
        (e.ctrlKey && e.shiftKey && (e.code === "KeyI" || e.code === "KeyJ" || e.code === "KeyC"))
      ) {
        e.preventDefault();
        return;
      }
      // 3) 소스보기 / 브라우저 찾기 방지: Ctrl+U, Ctrl+F
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.code === "KeyU" || e.code === "KeyF")) {
        e.preventDefault();
        return;
      }
      // 4) 브라우저 히스토리 뒤로가기 방지: Alt+Left / Alt+Right
      if (e.altKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
        e.preventDefault();
        return;
      }
      // 5) 브라우저 기본 인쇄창 방지: Ctrl+P
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyP") {
        e.preventDefault();
      }

      // 14단계 B: 일괄 작업 모달이 열려있을 때 전역 키 핸들러 비활성화 (Escape 시 닫기)
      if (batchModalState !== null) {
        if (e.code === "Escape") {
          e.preventDefault();
          setBatchModalState(null);
        }
        return;
      }

      // 증명사진 편집기가 열려있을 때는 전역 키 핸들러 비활성화
      if (idPhotoTargetPaths !== null) {
        return;
      }

      // 14단계 C: 학교 행정실 사진 작업 모달이 열려있을 때 전역 키 핸들러 비활성화
      if (
        mosaicModalPath !== null ||
        photoCollagePaths !== null ||
        pdfBindingPaths !== null ||
        photoStampPaths !== null
      ) {
        return;
      }

      // 1. 모달이 열려있을 때의 우선 키 처리
      if (showDeleteModal) {
        if (e.code === "Enter" || e.code === "NumpadEnter") {
          e.preventDefault();
          void executeDeleteToTrash();
          return;
        }
        if (e.code === "Escape") {
          e.preventDefault();
          setShowDeleteModal(false);
          return;
        }
        return;
      }

      if (showRenameModal) {
        if (e.code === "Enter" || e.code === "NumpadEnter") {
          e.preventDefault();
          void executeRename();
          return;
        }
        if (e.code === "Escape") {
          e.preventDefault();
          setShowRenameModal(false);
          return;
        }
        return;
      }

      if (showCopyMoveModal) {
        if (e.code === "Enter" || e.code === "NumpadEnter") {
          e.preventDefault();
          void executeCopyMove();
          return;
        }
        if (e.code === "Escape") {
          e.preventDefault();
          setShowCopyMoveModal(false);
          return;
        }
        return;
      }

      if (showRecentDropdown) {
        if (e.code === "Escape") {
          e.preventDefault();
          setShowRecentDropdown(false);
          return;
        }
      }

      if (showSettingsModal) {
        if (e.code === "Escape") {
          e.preventDefault();
          setShowSettingsModal(false);
          return;
        }
        return;
      }

      if (showSaveAsModal) {
        if (e.code === "Escape") {
          e.preventDefault();
          setShowSaveAsModal(false);
          return;
        }
        return;
      }

      if (showResizeModal) {
        if (e.code === "Escape") {
          e.preventDefault();
          setShowResizeModal(false);
          return;
        }
        return;
      }

      if (showHelpModal) {
        if (e.code === "Escape") {
          e.preventDefault();
          setShowHelpModal(false);
          return;
        }
        return;
      }

      if (showSortDropdown) {
        if (e.code === "Escape") {
          e.preventDefault();
          setShowSortDropdown(false);
          return;
        }
      }

      // 우클릭 컨텍스트 메뉴가 열려있을 때 Escape로 닫기
      if (contextMenu !== null) {
        if (e.code === "Escape") {
          e.preventDefault();
          setContextMenu(null);
          return;
        }
      }

      // 9단계: 슬라이드쇼 중 특수 조작 (Space 일시정지, 좌우 수동 이동, Escape 종료)
      if (isSlideshowActive) {
        if (e.code === "Escape") {
          e.preventDefault();
          stopSlideshow();
          return;
        }
        if (e.code === "Space") {
          e.preventDefault();
          setIsSlideshowPaused((p) => !p);
          setShowSlideshowBadge(true);
          return;
        }
        if (e.code === "ArrowRight") {
          e.preventDefault();
          goToNext();
          setSlideshowRemainingSec(settingsRef.current.slideshowInterval || 3);
          setShowSlideshowBadge(true);
          return;
        }
        if (e.code === "ArrowLeft") {
          e.preventDefault();
          goToPrev();
          setSlideshowRemainingSec(settingsRef.current.slideshowInterval || 3);
          setShowSlideshowBadge(true);
          return;
        }
      }

      // Escape: 우측 정보 패널 닫기 -> 전체화면 해제 -> 뷰어면 탐색기 복귀
      if (e.code === "Escape") {
        e.preventDefault();
        if (showInfoPanel) {
          setShowInfoPanel(false);
          return;
        }
        if (isFullscreen) {
          void exitFullscreen();
          return;
        }
        if (appMode === "viewer") {
          returnToExplorer();
          return;
        }
        return;
      }

      // 주소 입력창 편집 중일 때는 전역 단축키 스킵
      if (isEditingAddress) return;

      // 탐색기 모드 전용 조작: Ctrl+A 전체 선택, 방향키 포커스 이동
      if (appMode === "explorer") {
        if (e.code === "KeyA" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (explorerResult && explorerResult.items.length > 0) {
            setSelectedPaths(new Set(explorerResult.items.map((i) => i.path)));
          }
          return;
        }
        if (
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.code) &&
          !e.altKey &&
          !e.ctrlKey
        ) {
          e.preventDefault();
          handleGridKeyNavigation(e.code);
          return;
        }
      }

      // 0번 요구사항: "단축키, 툴바 버튼, 우클릭 메뉴, 도움말 단축키 표는 모두 이 명령 목록을 사용한다. 같은 기능을 따로 구현하지 마."
      const matched = commandsRef.current.find((cmd) => {
        if (cmd.scope && cmd.scope !== "all" && cmd.scope !== appMode) {
          return false;
        }
        return cmd.triggers.some(
          (t) =>
            t.code === e.code &&
            Boolean(t.ctrl) === Boolean(e.ctrlKey) &&
            Boolean(t.shift) === Boolean(e.shiftKey) &&
            Boolean(t.alt) === Boolean(e.altKey)
        );
      });

      if (matched) {
        e.preventDefault();
        if (matched.isEnabled) {
          void matched.action();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    showDeleteModal,
    showSettingsModal,
    showSaveAsModal,
    showResizeModal,
    showHelpModal,
    showSortDropdown,
    isSlideshowActive,
    contextMenu,
    showInfoPanel,
    isFullscreen,
    appMode,
    isEditingAddress,
    explorerResult,
    executeDeleteToTrash,
    exitFullscreen,
    returnToExplorer,
    handleGridKeyNavigation,
    stopSlideshow,
    goToNext,
    goToPrev,
  ]);

  // 마우스 뒤/앞 버튼
  useEffect(() => {
    const onMouseDownWindow = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
      }
    };
    const onMouseUpWindow = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        goToPrev();
      } else if (e.button === 4) {
        e.preventDefault();
        goToNext();
      }
    };
    window.addEventListener("mousedown", onMouseDownWindow);
    window.addEventListener("mouseup", onMouseUpWindow);
    return () => {
      window.removeEventListener("mousedown", onMouseDownWindow);
      window.removeEventListener("mouseup", onMouseUpWindow);
    };
  }, [goToPrev, goToNext]);

  // 9단계: 마우스 휠 동작 (Ctrl+휠은 항상 확대/축소, 너비 맞춤일 때는 스크롤, 그 외 설정에 따라 이전/다음 또는 확대/축소)
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (view.kind !== "image" || !metaRef.current) return;
      e.preventDefault();

      const el = viewerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      // 1. Ctrl + 휠: 항상 커서 중심 확대/축소
      if (e.ctrlKey) {
        const factor = Math.exp(-e.deltaY * 0.015);
        zoomAtPoint(cx, cy, factor);
        return;
      }

      // 2. "너비에 맞춤" 모드일 때는 위아래 스크롤(패닝)로 동작
      if (settingsRef.current.zoomMode === "fitWidth") {
        const dpr = window.devicePixelRatio || 1;
        const m = metaRef.current;
        const totalW = isDoublePage && secondMetaRef.current ? m.naturalWidth + secondMetaRef.current.naturalWidth : m.naturalWidth;
        const maxH = isDoublePage && secondMetaRef.current ? Math.max(m.naturalHeight, secondMetaRef.current.naturalHeight) : m.naturalHeight;
        const bw = totalW / dpr;
        const bh = maxH / dpr;
        const cur = transformRef.current;
        const nextY = cur.y - e.deltaY;
        const clamped = clampPosition(cur.x, nextY, cur.scale, bw, bh, el.clientWidth, el.clientHeight, rotationRef.current);
        setTransform((prev) => ({ ...prev, y: clamped.y }));
        return;
      }

      // 3. 설정에 따른 동작
      if (settingsRef.current.wheelAction === "navigate") {
        // 꿀뷰 방식: 이전 / 다음 사진 넘김
        if (e.deltaY > 0) {
          goToNext();
        } else if (e.deltaY < 0) {
          goToPrev();
        }
      } else {
        // 확대 / 축소
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        zoomAtPoint(cx, cy, factor);
      }
    },
    [view.kind, zoomAtPoint, goToNext, goToPrev, isDoublePage]
  );

  // 마우스 패닝
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (view.kind !== "image" || !metaRef.current) return;

    e.preventDefault();
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startX: transformRef.current.x,
      startY: transformRef.current.y,
    };
    setIsPanning(true);
  }, [view.kind]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current || !metaRef.current || !viewerRef.current) return;

      const dx = e.clientX - dragStartRef.current.clientX;
      const dy = e.clientY - dragStartRef.current.clientY;
      const nextX = dragStartRef.current.startX + dx;
      const nextY = dragStartRef.current.startY + dy;

      if (rAFRef.current !== null) cancelAnimationFrame(rAFRef.current);

      rAFRef.current = requestAnimationFrame(() => {
        const el = viewerRef.current;
        const m = metaRef.current;
        if (!el || !m) return;
        const dpr = window.devicePixelRatio || 1;
        const totalW = isDoublePage && secondMetaRef.current ? m.naturalWidth + secondMetaRef.current.naturalWidth : m.naturalWidth;
        const maxH = isDoublePage && secondMetaRef.current ? Math.max(m.naturalHeight, secondMetaRef.current.naturalHeight) : m.naturalHeight;
        const bw = totalW / dpr;
        const bh = maxH / dpr;

        const clamped = clampPosition(nextX, nextY, transformRef.current.scale, bw, bh, el.clientWidth, el.clientHeight, rotationRef.current);
        setTransform((prev) => ({ ...prev, x: clamped.x, y: clamped.y }));
        setIsFit(false);
      });
    };

    const onMouseUp = () => {
      if (dragStartRef.current) {
        dragStartRef.current = null;
        setIsPanning(false);
        if (rAFRef.current !== null) {
          cancelAnimationFrame(rAFRef.current);
          rAFRef.current = null;
        }
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDoublePage]);

  // 더블클릭
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    if (view.kind === "empty") {
      void openDialog();
      return;
    }
    if (view.kind === "image") {
      const el = viewerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      toggleFitOrActual(cx, cy);
    }
  }, [view.kind, openDialog, toggleFitOrActual]);

  // 드래그 앤 드롭
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDraggingFile(true);
        } else if (p.type === "leave") {
          setDraggingFile(false);
        } else if (p.type === "drop") {
          setDraggingFile(false);
          if (p.paths.length > 0) {
            setAppMode("viewer");
            openPath(p.paths[0]);
          }
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPath]);

  // 6단계 & 8단계: 초기 기동 로직 (파일 있으면 뷰어, 없으면 마지막 폴더 탐색기 모드)
  useEffect(() => {
    // 1. 저장된 설정 불러오기 및 초기 모드 결정
    invoke<AppSettings>("load_settings")
      .then(async (s) => {
        if (s) {
          setSettings(s);
          document.documentElement.dataset.theme = s.theme;
          setBgMode(s.defaultBg);
          if (s.folderTreeWidth) setFolderTreeWidth(s.folderTreeWidth);
          if (s.thumbnailSize) setThumbnailSize(s.thumbnailSize);
        }

        // 시스템 드라이브 및 바로가기 미리 로드
        const locs = await invoke<SystemLocation[]>("get_system_locations").catch(() => []);
        setSystemLocations(locs);

        // 앱 환경 정보(포터블 모드 여부, 데이터 디렉터리, 쓰기 권한) 로드
        const env = await invoke<any>("get_app_env_info").catch(() => null);
        if (env) setAppEnvInfo(env);

        // 실행 인자로 전달된 첫 파일 확인
        const initPath = await invoke<string | null>("get_initial_file").catch(() => null);
        if (initPath) {
          setAppMode("viewer");
          openPath(initPath);
        } else {
          // 파일 없이 실행 시 탐색기 모드로 시작 (마지막으로 본 폴더 또는 기본 사진 폴더)
          setAppMode("explorer");
          const targetFolder = s?.lastFolder || locs[0]?.path || "C:\\";
          navigateToExplorerFolder(targetFolder);
        }
      })
      .catch((err) => console.error("초기 로드 실패:", err));

    // 2. 단일 인스턴스: 이미 실행 중일 때 새 파일 열기 이벤트 수신
    let unlistenOpenFile: (() => void) | undefined;
    listen<string>("open-file", (event) => {
      if (event.payload) {
        setAppMode("viewer");
        openPath(event.payload);
      }
    }).then((fn) => {
      unlistenOpenFile = fn;
    });

    // 3. 8단계: 실시간 폴더 변경 감시 (notify 크레이트 이벤트)
    let unlistenFolderChanged: (() => void) | undefined;
    listen<string>("folder-changed", () => {
      if (folderRefreshTimerRef.current !== null) {
        window.clearTimeout(folderRefreshTimerRef.current);
      }
      folderRefreshTimerRef.current = window.setTimeout(() => {
        refreshExplorer();
        folderRefreshTimerRef.current = null;
      }, 350);
    }).then((fn) => {
      unlistenFolderChanged = fn;
    });

    return () => {
      unlistenOpenFile?.();
      unlistenFolderChanged?.();
    };
  }, [openPath, navigateToExplorerFolder, refreshExplorer]);

  // 폴더 트리 너비 리사이저 드래그
  useEffect(() => {
    if (!isResizingTree) return;
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(160, Math.min(480, e.clientX));
      setFolderTreeWidth(newWidth);
    };
    const handleMouseUp = () => {
      setIsResizingTree(false);
      updateSettings({ folderTreeWidth });
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizingTree, folderTreeWidth, updateSettings]);

  // 탐색기 가상 그리드 컨테이너 크기 추적
  useEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setGridDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [appMode]);

  const handleMouseMoveViewer = useCallback(
    (e: React.MouseEvent) => {
      pingTopBar();
      if (e.clientY <= 50) {
        setIsMouseAtTop(true);
      } else if (e.clientY > 90) {
        setIsMouseAtTop(false);
      }
    },
    [pingTopBar]
  );

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    setMeta({ naturalWidth: nw, naturalHeight: nh });
    setLoaded(true);

    const el = viewerRef.current;
    if (el) {
      if (!settingsRef.current.keepTransform) {
        const t = getInitialTransform(el.clientWidth, el.clientHeight, nw, nh, rotationRef.current);
        setTransform(t);
        setIsFit(
          settingsRef.current.zoomMode === "fitIfLarge" ||
            settingsRef.current.zoomMode === "fitAlways"
        );
      }
    }
  };

  const handleSecondImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setSecondMeta({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
    setSecondLoaded(true);
  };

  const handleCopyPrompt = () => {
    if (imageDetails?.aiPrompt) {
      navigator.clipboard.writeText(imageDetails.aiPrompt).then(() => {
        setCopiedPrompt(true);
        setTimeout(() => setCopiedPrompt(false), 1500);
      });
    }
  };

  const dpr = window.devicePixelRatio || 1;
  const baseWidth = meta ? meta.naturalWidth / dpr : 0;
  const baseHeight = meta ? meta.naturalHeight / dpr : 0;
  const secondBaseWidth = secondMeta ? secondMeta.naturalWidth / dpr : 0;
  const secondBaseHeight = secondMeta ? secondMeta.naturalHeight / dpr : 0;
  const scalePercent = Math.round(transform.scale * 100);

  // 양면 보기용 두 번째 이미지 URL
  const nextItem = isDoublePage && currentIndex + 1 < items.length ? items[currentIndex + 1] : null;
  const secondSrc = nextItem?.path ? convertFileSrc(nextItem.path) : null;

  // 회전 각도에 따른 라디안 및 삼각함수
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));

  // 단면 보기: 회전 후 중심축 기준 좌우/상하 반전 변환식 (화면 위치 고정)
  const rotCenterX = (baseWidth / 2) * cos - (baseHeight / 2) * sin;
  const rotCenterY = (baseWidth / 2) * sin + (baseHeight / 2) * cos;
  const flipTransform =
    flipH || flipV
      ? ` translate(${rotCenterX}px, ${rotCenterY}px) scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1}) translate(${-rotCenterX}px, ${-rotCenterY}px)`
      : "";

  // 양면 보기: 회전 후 중심축 기준 좌우/상하 반전 변환식 (화면 위치 고정)
  const doubleTotalW = baseWidth + (secondSrc ? secondBaseWidth + 4 : 0);
  const doubleMaxH = Math.max(baseHeight, secondSrc ? secondBaseHeight : 0);
  const doubleRotCenterX = (doubleTotalW / 2) * cos - (doubleMaxH / 2) * sin;
  const doubleRotCenterY = (doubleTotalW / 2) * sin + (doubleMaxH / 2) * cos;
  const doubleFlipTransform =
    flipH || flipV
      ? ` translate(${doubleRotCenterX}px, ${doubleRotCenterY}px) scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1}) translate(${-doubleRotCenterX}px, ${-doubleRotCenterY}px)`
      : "";

  // 가상 스크롤 렌더링 범위 계산 (필름스트립)
  const visibleCount = Math.ceil(filmstripWidth / THUMB_ITEM_WIDTH);
  const startThumbIdx = Math.max(0, Math.floor(filmstripScrollLeft / THUMB_ITEM_WIDTH) - 2);
  const endThumbIdx = Math.min(items.length - 1, startThumbIdx + visibleCount + 4);
  const leftPadding = startThumbIdx * THUMB_ITEM_WIDTH;
  const rightPadding = Math.max(0, (items.length - 1 - endThumbIdx) * THUMB_ITEM_WIDTH);

  // 8단계 탐색기 모드 가상 스크롤 계산 (Row 단위 가상화)
  const explorerItemWidth = thumbnailSize + 16;
  const explorerItemHeight = thumbnailSize + 52;
  const explorerCols = Math.max(1, Math.floor(gridDimensions.width / explorerItemWidth));
  const totalExplorerItems = filteredExplorerItems.length;
  const totalExplorerRows = Math.ceil(totalExplorerItems / explorerCols);
  const startExplorerRow = Math.max(0, Math.floor(gridScrollTop / explorerItemHeight) - 2);
  const endExplorerRow = Math.min(
    totalExplorerRows - 1,
    Math.ceil((gridScrollTop + gridDimensions.height) / explorerItemHeight) + 2
  );
  const startExplorerIdx = startExplorerRow * explorerCols;
  const endExplorerIdx = Math.min(totalExplorerItems - 1, (endExplorerRow + 1) * explorerCols - 1);
  const visibleExplorerItems =
    startExplorerIdx <= endExplorerIdx
      ? filteredExplorerItems.slice(startExplorerIdx, endExplorerIdx + 1)
      : [];
  const topExplorerSpacerHeight = startExplorerRow * explorerItemHeight;
  const bottomExplorerSpacerHeight = Math.max(
    0,
    (totalExplorerRows - 1 - endExplorerRow) * explorerItemHeight
  );

  // 화면에 보이는 탐색기 이미지들의 썸네일 생성 및 로딩
  useEffect(() => {
    if (appMode !== "explorer" || visibleExplorerItems.length === 0) return;
    for (const it of visibleExplorerItems) {
      if (
        (it.kind === "image" || it.kind === "cad") &&
        !explorerThumbnails[it.path] &&
        !loadingThumbsRef.current.has(it.path)
      ) {
        loadingThumbsRef.current.add(it.path);
        const invokeCmd = it.kind === "cad" ? "get_dwg_thumbnail" : "get_thumbnail";
        invoke<string>(invokeCmd, { path: it.path })
          .then((thumbPath) => {
            setExplorerThumbnails((prev) => ({ ...prev, [it.path]: convertFileSrc(thumbPath) }));
          })
          .catch(() => {
            if (it.kind !== "cad") {
              setExplorerThumbnails((prev) => ({ ...prev, [it.path]: convertFileSrc(it.path) }));
            }
          })
          .finally(() => {
            loadingThumbsRef.current.delete(it.path);
          });
      }
    }
  }, [appMode, visibleExplorerItems, explorerThumbnails]);

  // 10단계: 툴바 열기 버튼 옆 최근 항목 드롭다운
  const renderRecentDropdown = () => (
    <div
      className="recent-items-dropdown glass-panel"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="recent-dropdown-header">
        <Clock size={13} style={{ marginRight: "4px" }} />
        <span>최근 열어본 항목 (최대 10개)</span>
      </div>
      {(!settings.recentItems || settings.recentItems.length === 0) ? (
        <div className="recent-dropdown-empty">최근 항목이 없습니다.</div>
      ) : (
        <div className="recent-dropdown-list">
          {settings.recentItems.map((item) => {
            const isMissing = itemExistsMap[item.path] === false;
            return (
              <button
                key={item.path}
                type="button"
                className={`recent-dropdown-item${isMissing ? " is-missing" : ""}`}
                onClick={() => void handleOpenRecentItem(item)}
                title={isMissing ? `${item.path} (삭제됨 - 클릭 시 목록에서 제거)` : item.path}
              >
                {item.isFolder ? (
                  <Folder size={14} className="recent-icon" />
                ) : (
                  <ImageIcon size={14} className="recent-icon" />
                )}
                <span className="recent-name">{item.name}</span>
                <span className="recent-path">{item.path}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  // 재사용 가능한 우측 정보 패널 렌더링
  const renderInfoPanel = () => {
    if (!showInfoPanel) return null;
    return (
      <aside className="info-panel" aria-label="파일 상세 정보">
        <header className="info-header">
          <h2 className="info-title">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M12 11v5M12 8h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            파일 정보
          </h2>
          <button className="info-close-btn" onClick={() => setShowInfoPanel(false)} title="닫기 (Esc, I)">
            ✕
          </button>
        </header>

        <div className="info-content">
          {imageDetails ? (
            <>
              {imageDetails.path && (
                <div className="info-preview-box">
                  <img
                    className="info-preview-img"
                    src={convertFileSrc(imageDetails.path)}
                    alt={imageDetails.fileName}
                    loading="lazy"
                  />
                </div>
              )}
              <section className="info-section">
                <h3 className="info-section-title">기본 정보</h3>
                <div className="info-grid">
                  <div className="info-row">
                    <span className="info-label">파일명</span>
                    <span className="info-val" style={{ fontWeight: 600 }}>
                      {imageDetails.fileName}
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">해상도</span>
                    <span className="info-val">
                      {imageDetails.width > 0 ? `${imageDetails.width} × ${imageDetails.height}` : "-"}
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">파일 크기</span>
                    <span className="info-val">{formatFileSize(imageDetails.fileSize)}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">수정 일시</span>
                    <span className="info-val">{formatTimestamp(imageDetails.modified)}</span>
                  </div>
                </div>

                <div className="info-path-box">
                  <span className="info-path-text">{imageDetails.path}</span>
                  <button
                    className="glass-button"
                    style={{ padding: "4px 8px", fontSize: "12px", alignSelf: "flex-start" }}
                    onClick={handleShowInFolder}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                      <path
                        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                      />
                    </svg>
                    탐색기에서 보기
                  </button>
                </div>
              </section>

              {(imageDetails.cameraModel ||
                imageDetails.cameraMake ||
                imageDetails.fNumber ||
                imageDetails.exposureTime ||
                imageDetails.iso) && (
                <section className="info-section">
                  <h3 className="info-section-title">촬영 정보 (EXIF)</h3>
                  <div className="info-grid">
                    {(imageDetails.cameraMake || imageDetails.cameraModel) && (
                      <div className="info-row">
                        <span className="info-label">카메라</span>
                        <span className="info-val">
                          {[imageDetails.cameraMake, imageDetails.cameraModel].filter(Boolean).join(" ")}
                        </span>
                      </div>
                    )}
                    {imageDetails.lensModel && (
                      <div className="info-row">
                        <span className="info-label">렌즈</span>
                        <span className="info-val">{imageDetails.lensModel}</span>
                      </div>
                    )}
                    {imageDetails.dateTimeOriginal && (
                      <div className="info-row">
                        <span className="info-label">촬영 일시</span>
                        <span className="info-val">{imageDetails.dateTimeOriginal}</span>
                      </div>
                    )}
                    {imageDetails.fNumber && (
                      <div className="info-row">
                        <span className="info-label">조리개</span>
                        <span className="info-val">{imageDetails.fNumber}</span>
                      </div>
                    )}
                    {imageDetails.exposureTime && (
                      <div className="info-row">
                        <span className="info-label">셔터 속도</span>
                        <span className="info-val">{imageDetails.exposureTime}</span>
                      </div>
                    )}
                    {imageDetails.iso && (
                      <div className="info-row">
                        <span className="info-label">감도</span>
                        <span className="info-val">{imageDetails.iso}</span>
                      </div>
                    )}
                    {imageDetails.focalLength && (
                      <div className="info-row">
                        <span className="info-label">초점 거리</span>
                        <span className="info-val">{imageDetails.focalLength}</span>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {imageDetails.aiPrompt && (
                <section className="info-section">
                  <details className="ai-details" open>
                    <summary>AI 생성 프롬프트 / 파라미터</summary>
                    <div className="ai-body">
                      <pre className="ai-prompt-text">{imageDetails.aiPrompt}</pre>
                      <button className="glass-button ai-copy-btn" onClick={handleCopyPrompt}>
                        {copiedPrompt ? "복사되었습니다!" : "프롬프트 복사"}
                      </button>
                    </div>
                  </details>
                </section>
              )}
            </>
          ) : (
            <p style={{ color: "var(--fg-dim)", fontSize: "13px" }}>정보를 불러오는 중입니다...</p>
          )}
        </div>
      </aside>
    );
  };

  return (
    <div className="app-container">
      {appMode === "explorer" ? (
        <div
          className="explorer-view"
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          {/* 탐색기 상단 헤더: 상위 버튼 + 새로고침 + 주소표시줄 + 탐색기 툴바 */}
          <header className="explorer-header">
            <div className="explorer-nav-buttons">
              <button
                className="glass-button explorer-nav-btn"
                onClick={goToParentFolder}
                disabled={!explorerResult?.parentPath}
                title="상위 폴더 (Backspace / Alt+←)"
              >
                <ArrowUp size={16} />
              </button>
              <button
                className="glass-button explorer-nav-btn"
                onClick={refreshExplorer}
                title="새로 고침 (F5)"
              >
                <RefreshCw size={15} />
              </button>
            </div>

            <div className="explorer-address-bar" onClick={() => setIsEditingAddress(true)}>
              {isEditingAddress ? (
                <input
                  ref={(input) => input?.focus()}
                  type="text"
                  className="explorer-address-input"
                  value={addressInput}
                  onChange={(e) => setAddressInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.code === "Enter") {
                      setIsEditingAddress(false);
                      navigateToExplorerFolder(addressInput);
                    } else if (e.code === "Escape") {
                      setIsEditingAddress(false);
                      setAddressInput(currentExplorerPath);
                    }
                  }}
                  onBlur={() => {
                    setIsEditingAddress(false);
                    setAddressInput(currentExplorerPath);
                  }}
                />
              ) : (
                <span className="explorer-address-text">{currentExplorerPath || "폴더를 선택하세요"}</span>
              )}
            </div>

            {settings.showToolbar && (
              <div className="explorer-toolbar" style={{ position: "relative" }}>
                {TOOLBAR_GROUPS_EXPLORER.map((group, groupIdx) => (
                  <div key={groupIdx} className="toolbar-group">
                    {group.map((cmdId) => {
                      const cmd = commandMap.get(cmdId);
                      if (!cmd) return null;
                      if (cmd.id === "open") {
                        return (
                          <div key={cmd.id} style={{ position: "relative", display: "inline-flex" }}>
                            <button
                              id={`explorer-toolbar-btn-${cmd.id}`}
                              className={`glass-button toolbar-icon-btn${cmd.isActive ? " is-active" : ""}`}
                              onClick={() => void cmd.action()}
                              disabled={!cmd.isEnabled}
                              title={`${cmd.label}${cmd.shortcutDisplay ? ` (${cmd.shortcutDisplay})` : ""}`}
                              aria-label={cmd.label}
                            >
                              {cmd.icon}
                              <span className="toolbar-btn-label">{cmd.label}</span>
                            </button>
                            <button
                              className="glass-button toolbar-arrow-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowRecentDropdown((p) => !p);
                              }}
                              title="최근 항목 (10개)"
                              aria-label="최근 항목"
                            >
                              <ChevronDown size={12} />
                            </button>
                            {showRecentDropdown && renderRecentDropdown()}
                          </div>
                        );
                      }
                      return (
                        <button
                          key={cmd.id}
                          id={`explorer-toolbar-btn-${cmd.id}`}
                          className={`glass-button toolbar-icon-btn${cmd.isActive ? " is-active" : ""}`}
                          onClick={() => void cmd.action()}
                          disabled={!cmd.isEnabled}
                          title={`${cmd.label}${cmd.shortcutDisplay ? ` (${cmd.shortcutDisplay})` : ""}`}
                          aria-label={cmd.label}
                        >
                          {cmd.icon}
                          <span className="toolbar-btn-label">{cmd.label}</span>
                        </button>
                      );
                    })}
                    {groupIdx < TOOLBAR_GROUPS_EXPLORER.length - 1 && <div className="toolbar-divider" />}
                  </div>
                ))}

                {/* 10단계: 파일 형식 필터 드롭다운 */}
                <div className="explorer-filter-select-wrapper">
                  <Filter size={13} className="filter-icon" />
                  <select
                    className="glass-select explorer-filter-select"
                    value={settings.explorerFilter || "all"}
                    onChange={(e) => updateSettings({ explorerFilter: e.target.value as ExplorerFilter })}
                    title="파일 형식 필터"
                  >
                    <option value="all">전체 형식</option>
                    <option value="jpg">JPG (*.jpg, *.jpeg)</option>
                    <option value="png">PNG (*.png)</option>
                    <option value="gif">GIF (*.gif)</option>
                    <option value="webp">WebP (*.webp)</option>
                    <option value="other">기타 형식</option>
                  </select>
                </div>

                {/* 9단계: 탐색기 모드 정렬 드롭다운 메뉴 */}
                {showSortDropdown && (
                  <div
                    className="sort-dropdown-menu"
                    style={{ top: "38px", right: "10px" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="sort-menu-header">정렬 기준</div>
                    <button
                      className={`sort-menu-item${settings.sortBy === "name" ? " is-active" : ""}`}
                      onClick={() => {
                        updateSettings({ sortBy: "name" });
                        setShowSortDropdown(false);
                      }}
                    >
                      <span>이름 (자연 정렬)</span>
                      {settings.sortBy === "name" && <Check size={14} />}
                    </button>
                    <button
                      className={`sort-menu-item${settings.sortBy === "dateModified" ? " is-active" : ""}`}
                      onClick={() => {
                        updateSettings({ sortBy: "dateModified" });
                        setShowSortDropdown(false);
                      }}
                    >
                      <span>수정 날짜</span>
                      {settings.sortBy === "dateModified" && <Check size={14} />}
                    </button>
                    <button
                      className={`sort-menu-item${settings.sortBy === "dateTaken" ? " is-active" : ""}`}
                      onClick={() => {
                        updateSettings({ sortBy: "dateTaken" });
                        setShowSortDropdown(false);
                      }}
                    >
                      <span>촬영 날짜 (EXIF)</span>
                      {settings.sortBy === "dateTaken" && <Check size={14} />}
                    </button>
                    <button
                      className={`sort-menu-item${settings.sortBy === "fileSize" ? " is-active" : ""}`}
                      onClick={() => {
                        updateSettings({ sortBy: "fileSize" });
                        setShowSortDropdown(false);
                      }}
                    >
                      <span>크기</span>
                      {settings.sortBy === "fileSize" && <Check size={14} />}
                    </button>
                    <button
                      className={`sort-menu-item${settings.sortBy === "fileType" ? " is-active" : ""}`}
                      onClick={() => {
                        updateSettings({ sortBy: "fileType" });
                        setShowSortDropdown(false);
                      }}
                    >
                      <span>형식 (확장자)</span>
                      {settings.sortBy === "fileType" && <Check size={14} />}
                    </button>
                    <div className="sort-menu-divider" />
                    <button
                      className={`sort-menu-item${settings.sortOrder === "asc" ? " is-active" : ""}`}
                      onClick={() => {
                        updateSettings({ sortOrder: "asc" });
                        setShowSortDropdown(false);
                      }}
                    >
                      <span>오름차순 (▲)</span>
                      {settings.sortOrder === "asc" && <Check size={14} />}
                    </button>
                    <button
                      className={`sort-menu-item${settings.sortOrder === "desc" ? " is-active" : ""}`}
                      onClick={() => {
                        updateSettings({ sortOrder: "desc" });
                        setShowSortDropdown(false);
                      }}
                    >
                      <span>내림차순 (▼)</span>
                      {settings.sortOrder === "desc" && <Check size={14} />}
                    </button>
                  </div>
                )}
              </div>
            )}
          </header>

          {/* 탐색기 메인 본문: 왼쪽 트리 + 리사이저 + 중앙 그리드 + 오른쪽 정보패널 */}
          <div className="explorer-main">
            {/* 좌측 폴더 트리 패널 */}
            <aside className="explorer-tree-panel" style={{ width: `${folderTreeWidth}px` }}>
              <div className="explorer-tree-scroll">
                {/* 10단계: 즐겨찾기 폴더 (드래그로 순서 변경) */}
                <div className="tree-section-title">
                  <Star size={13} style={{ display: "inline", verticalAlign: "middle", marginRight: "4px", color: "var(--accent)" }} />
                  즐겨찾기
                </div>
                {(!settings.favoriteFolders || settings.favoriteFolders.length === 0) ? (
                  <div className="fav-empty-hint">폴더 우클릭 → 즐겨찾기 추가</div>
                ) : (
                  settings.favoriteFolders.map((favPath, idx) => (
                    <div
                      key={favPath}
                      draggable
                      onDragStart={() => setDraggedFavIdx(idx)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (draggedFavIdx !== null) {
                          handleReorderFavoriteFolders(draggedFavIdx, idx);
                          setDraggedFavIdx(null);
                        }
                      }}
                      className={`tree-item favorite-item${currentExplorerPath.toLowerCase() === favPath.toLowerCase() ? " is-active" : ""}`}
                      onClick={() => navigateToExplorerFolder(favPath)}
                      title={`${favPath} (드래그하여 순서 변경, 우클릭 시 제거)`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleToggleFavoriteFolder(favPath);
                      }}
                    >
                      <Folder className="tree-icon" size={16} />
                      <span className="tree-label">{baseName(favPath)}</span>
                      <button
                        type="button"
                        className="fav-remove-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleFavoriteFolder(favPath);
                        }}
                        title="즐겨찾기에서 제거"
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}

                <div className="tree-section-title" style={{ marginTop: "12px" }}>빠른 바로가기</div>
                {systemLocations
                  .filter((loc) => loc.kind === "quickAccess")
                  .map((loc) => (
                    <div
                      key={loc.path}
                      className={`tree-item${currentExplorerPath.toLowerCase() === loc.path.toLowerCase() ? " is-active" : ""}`}
                      onClick={() => navigateToExplorerFolder(loc.path)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleToggleFavoriteFolder(loc.path);
                      }}
                      title={`${loc.name} (우클릭: 즐겨찾기 토글)`}
                    >
                      <Folder className="tree-icon" size={16} />
                      <span className="tree-label">{loc.name}</span>
                    </div>
                  ))}

                {/* 10단계: 최근 열어본 파일·폴더 (최대 10개) */}
                <div className="tree-section-title" style={{ marginTop: "12px" }}>
                  <Clock size={13} style={{ display: "inline", verticalAlign: "middle", marginRight: "4px" }} />
                  최근 항목
                </div>
                {(!settings.recentItems || settings.recentItems.length === 0) ? (
                  <div className="fav-empty-hint">최근 항목 없음</div>
                ) : (
                  settings.recentItems.map((item) => {
                    const isMissing = itemExistsMap[item.path] === false;
                    return (
                      <div
                        key={item.path}
                        className={`tree-item${isMissing ? " is-missing" : ""}`}
                        onClick={() => void handleOpenRecentItem(item)}
                        title={isMissing ? `${item.path} (삭제됨 - 클릭 시 목록에서 제거)` : item.path}
                      >
                        {item.isFolder ? (
                          <Folder className="tree-icon" size={16} />
                        ) : (
                          <ImageIcon className="tree-icon" size={16} />
                        )}
                        <span
                          className="tree-label"
                          style={isMissing ? { opacity: 0.5, textDecoration: "line-through" } : undefined}
                        >
                          {item.name}
                        </span>
                      </div>
                    );
                  })
                )}

                <div className="tree-section-title" style={{ marginTop: "12px" }}>
                  내 PC
                </div>
                {systemLocations
                  .filter((loc) => loc.kind === "drive")
                  .map((loc) => (
                    <div key={loc.path} className="tree-node">
                      <div
                        className={`tree-item${currentExplorerPath.toLowerCase() === loc.path.toLowerCase() ? " is-active" : ""}`}
                        onClick={() => navigateToExplorerFolder(loc.path)}
                      >
                        <button
                          className="tree-expand-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleFolderExpand(loc.path);
                          }}
                        >
                          {expandedFolders.has(loc.path) ? (
                            <ChevronDown size={14} />
                          ) : (
                            <ChevronRightIcon size={14} />
                          )}
                        </button>
                        <HardDrive className="tree-icon" size={16} />
                        <span className="tree-label">{loc.name}</span>
                      </div>
                      {expandedFolders.has(loc.path) && subfoldersMap[loc.path] && (
                        <div className="tree-children">
                          {subfoldersMap[loc.path].map((sub) => (
                            <div key={sub.path} className="tree-node">
                              <div
                                className={`tree-item sub-item${currentExplorerPath.toLowerCase() === sub.path.toLowerCase() ? " is-active" : ""}`}
                                onClick={() => navigateToExplorerFolder(sub.path)}
                              >
                                {sub.hasChildren ? (
                                  <button
                                    className="tree-expand-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void toggleFolderExpand(sub.path);
                                    }}
                                  >
                                    {expandedFolders.has(sub.path) ? (
                                      <ChevronDown size={14} />
                                    ) : (
                                      <ChevronRightIcon size={14} />
                                    )}
                                  </button>
                                ) : (
                                  <span className="tree-expand-placeholder" />
                                )}
                                {expandedFolders.has(sub.path) ? (
                                  <FolderOpenIcon className="tree-icon" size={15} />
                                ) : (
                                  <Folder className="tree-icon" size={15} />
                                )}
                                <span className="tree-label">{sub.name}</span>
                              </div>
                              {expandedFolders.has(sub.path) && subfoldersMap[sub.path] && (
                                <div className="tree-children">
                                  {subfoldersMap[sub.path].map((sub2) => (
                                    <div
                                      key={sub2.path}
                                      className={`tree-item sub-item-2${currentExplorerPath.toLowerCase() === sub2.path.toLowerCase() ? " is-active" : ""}`}
                                      onClick={() => navigateToExplorerFolder(sub2.path)}
                                    >
                                      <span className="tree-expand-placeholder" />
                                      <Folder className="tree-icon" size={14} />
                                      <span className="tree-label">{sub2.name}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </aside>

            {/* 트리 너비 리사이저 바 */}
            <div
              className="explorer-resizer"
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingTree(true);
              }}
            />

            {/* 중앙 썸네일 그리드 영역 (가상 스크롤) */}
            <section className="explorer-grid-section">
              <div
                ref={gridContainerRef}
                className="explorer-grid-container"
                onScroll={(e) => setGridScrollTop(e.currentTarget.scrollTop)}
                onClick={() => setSelectedPaths(new Set())}
              >
                {explorerResult && filteredExplorerItems.length > 0 ? (
                  <div
                    className="explorer-virtual-track"
                    style={{
                      paddingTop: `${topExplorerSpacerHeight}px`,
                      paddingBottom: `${bottomExplorerSpacerHeight}px`,
                    }}
                  >
                    <div
                      className="explorer-grid"
                      style={{
                        gridTemplateColumns: `repeat(${explorerCols}, minmax(0, 1fr))`,
                      }}
                    >
                      {visibleExplorerItems.map((item, relIdx) => {
                        const absIdx = startExplorerIdx + relIdx;
                        const isSelected = selectedPaths.has(item.path);
                        const thumbUrl = explorerThumbnails[item.path];

                        return (
                          <div
                            key={item.path}
                            className={`grid-item${isSelected ? " is-selected" : ""}${focusedIndex === absIdx ? " is-focused" : ""}`}
                            style={{
                              width: `${explorerItemWidth}px`,
                              height: `${explorerItemHeight}px`,
                            }}
                            draggable
                            onDragStart={(e) => {
                              e.stopPropagation();
                              const paths = selectedPaths.has(item.path)
                                ? Array.from(selectedPaths)
                                : [item.path];
                              void startDrag({ item: paths, icon: "" });
                            }}
                            onClick={(e) => handleExplorerItemClick(e, item, absIdx)}
                            onDoubleClick={() => handleExplorerItemDoubleClick(item)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              if (!selectedPaths.has(item.path)) {
                                setSelectedPaths(new Set([item.path]));
                              }
                              setContextMenu({ x: e.clientX, y: e.clientY });
                            }}
                            title={`${item.name}${item.size ? ` (${formatFileSize(item.size)})` : ""}`}
                          >
                            <div
                              className="grid-thumb-box"
                              style={{ width: `${thumbnailSize}px`, height: `${thumbnailSize}px` }}
                            >
                              {item.kind === "folder" ? (
                                <Folder className="grid-folder-icon" size={thumbnailSize * 0.55} />
                              ) : item.kind === "archive" ? (
                                <FileArchive
                                  className="grid-archive-icon"
                                  size={thumbnailSize * 0.55}
                                />
                              ) : thumbUrl ? (
                                <img
                                  className="grid-thumb-img"
                                  src={thumbUrl}
                                  alt={item.name}
                                  loading="lazy"
                                  onError={(e) => {
                                    if (item.kind !== "cad" && e.currentTarget.src !== convertFileSrc(item.path)) {
                                      e.currentTarget.src = convertFileSrc(item.path);
                                    }
                                  }}
                                />
                              ) : item.kind === "cad" ? (
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2px", color: "var(--accent)" }}>
                                  <Sliders size={thumbnailSize * 0.4} />
                                  <span style={{ fontSize: "10px", fontWeight: "bold" }}>CAD</span>
                                </div>
                              ) : (
                                <ImageIcon
                                  className="grid-img-placeholder"
                                  size={thumbnailSize * 0.4}
                                />
                              )}
                            </div>
                            <span className="grid-item-name">{item.name}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="explorer-empty-placeholder">
                    <p>폴더에 이미지 또는 하위 폴더가 없습니다</p>
                  </div>
                )}
              </div>

              {/* 하단 탐색기 상태 표시줄 & 썸네일 크기 슬라이더 */}
              {settings.showStatusBar && (
                <footer className="explorer-status-bar">
                  <div className="explorer-status-info">
                    <span>항목 {explorerResult?.items.length ?? 0}개</span>
                    {selectedPaths.size > 0 && (
                      <>
                        <span className="status-sep" />
                        <span>선택됨 {selectedPaths.size}개</span>
                        <div className="status-batch-actions">
                          {selectedPaths.size === 1 && (
                            <button
                              type="button"
                              className="status-batch-btn"
                              onClick={handleOpenMosaicEditor}
                              title="모자이크·흐림 개인정보 가리기 (Ctrl+M)"
                            >
                              모자이크
                            </button>
                          )}
                          {selectedPaths.size >= 2 && selectedPaths.size <= 9 && (
                            <button
                              type="button"
                              className="status-batch-btn highlight"
                              onClick={handleOpenPhotoCollage}
                              title="선택한 사진들을 한 장으로 합치기 (Ctrl+Alt+C)"
                            >
                              사진 합치기
                            </button>
                          )}
                          <button
                            type="button"
                            className="status-batch-btn"
                            onClick={handleOpenPdfBinding}
                            title="선택 사진들을 하나의 A4 PDF 파일로 묶기 (Ctrl+Alt+P)"
                          >
                            PDF 묶기
                          </button>
                          <button
                            type="button"
                            className="status-batch-btn"
                            onClick={handleOpenPhotoStamp}
                            title="촬영 날짜·설명 글자 모서리 넣기 (Ctrl+Alt+T)"
                          >
                            날짜·글자
                          </button>
                          <button
                            type="button"
                            className="status-batch-btn"
                            onClick={handleOpenBatchConvert}
                            title="선택 항목 일괄 크기 조정·변환 (Ctrl+Shift+B)"
                          >
                            일괄 변환
                          </button>
                          <button
                            type="button"
                            className="status-batch-btn"
                            onClick={handleOpenBatchRename}
                            title="선택 항목 일괄 이름 바꾸기 (Ctrl+F2)"
                          >
                            일괄 이름
                          </button>
                          <button
                            type="button"
                            className="status-batch-btn"
                            onClick={handleOpenBatchRotate}
                            title="선택 항목 일괄 회전 (Ctrl+Shift+R)"
                          >
                            일괄 회전
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="thumbnail-size-slider-box">
                    <Sliders size={14} />
                    <input
                      type="range"
                      min={80}
                      max={256}
                      step={8}
                      value={thumbnailSize}
                      onChange={(e) => {
                        const sz = Number(e.target.value);
                        setThumbnailSize(sz);
                        updateSettings({ thumbnailSize: sz });
                      }}
                      title={`썸네일 크기: ${thumbnailSize}px`}
                    />
                    <span style={{ fontSize: "11px", minWidth: "36px" }}>{thumbnailSize}px</span>
                  </div>
                </footer>
              )}
            </section>

            {/* 우측 정보 패널 */}
            {renderInfoPanel()}
          </div>
        </div>
      ) : (
        /* 기존 뷰어 모드 화면 */
        <main
          ref={viewerRef}
          className={`viewer bg-${bgMode}${view.kind === "image" ? " has-image" : ""}${isPanning ? " is-dragging" : ""}`}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={handleMouseMoveViewer}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <h1 className="sr-only">{APP_NAME} 이미지 뷰어</h1>

          {/* 7단계: 상단 툴바 (아이콘 버튼 & 툴팁 & 전체화면 자동 슬라이드다운) */}
          {settings.showToolbar && (
            <nav
              className={`top-toolbar-container${
                isFullscreen ? (isMouseAtTop ? " is-visible-hover" : " is-hidden-fullscreen") : ""
              }`}
              aria-label="메인 툴바"
              onMouseEnter={() => setIsMouseAtTop(true)}
            >
              <div className="top-toolbar">
                {TOOLBAR_GROUPS_VIEWER.map((group, groupIdx) => (
                  <div key={groupIdx} className="toolbar-group">
                    {group.map((cmdId) => {
                      const cmd = commandMap.get(cmdId);
                      if (!cmd) return null;
                      if (cmd.id === "open") {
                        return (
                          <div key={cmd.id} style={{ position: "relative", display: "inline-flex" }}>
                            <button
                              id={`toolbar-btn-${cmd.id}`}
                              className={`glass-button toolbar-icon-btn${cmd.isActive ? " is-active" : ""}`}
                              onClick={() => void cmd.action()}
                              disabled={!cmd.isEnabled}
                              title={`${cmd.label}${cmd.shortcutDisplay ? ` (${cmd.shortcutDisplay})` : ""}`}
                              aria-label={cmd.label}
                            >
                              {cmd.icon}
                              <span className="toolbar-btn-label">{cmd.label}</span>
                            </button>
                            <button
                              className="glass-button toolbar-arrow-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowRecentDropdown((p) => !p);
                              }}
                              title="최근 항목 (10개)"
                              aria-label="최근 항목"
                            >
                              <ChevronDown size={12} />
                            </button>
                            {showRecentDropdown && renderRecentDropdown()}
                          </div>
                        );
                      }
                      return (
                        <button
                          key={cmd.id}
                          id={`toolbar-btn-${cmd.id}`}
                          className={`glass-button toolbar-icon-btn${cmd.isActive ? " is-active" : ""}`}
                          onClick={() => void cmd.action()}
                          disabled={!cmd.isEnabled}
                          title={`${cmd.label}${cmd.shortcutDisplay ? ` (${cmd.shortcutDisplay})` : ""}`}
                          aria-label={cmd.label}
                        >
                          {cmd.icon}
                          <span className="toolbar-btn-label">{cmd.label}</span>
                        </button>
                      );
                    })}
                    {groupIdx < TOOLBAR_GROUPS_VIEWER.length - 1 && <div className="toolbar-divider" />}
                  </div>
                ))}
              </div>

              {/* 9단계: 정렬 드롭다운 메뉴 (툴바 연동) */}
              {showSortDropdown && (
                <div
                  className="sort-dropdown-menu"
                  style={{ top: "44px", right: "120px" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="sort-menu-header">정렬 기준</div>
                  <button
                    className={`sort-menu-item${settings.sortBy === "name" ? " is-active" : ""}`}
                    onClick={() => {
                      updateSettings({ sortBy: "name" });
                      setShowSortDropdown(false);
                    }}
                  >
                    <span>이름 (자연 정렬)</span>
                    {settings.sortBy === "name" && <Check size={14} />}
                  </button>
                  <button
                    className={`sort-menu-item${settings.sortBy === "dateModified" ? " is-active" : ""}`}
                    onClick={() => {
                      updateSettings({ sortBy: "dateModified" });
                      setShowSortDropdown(false);
                    }}
                  >
                    <span>수정 날짜</span>
                    {settings.sortBy === "dateModified" && <Check size={14} />}
                  </button>
                  <button
                    className={`sort-menu-item${settings.sortBy === "dateTaken" ? " is-active" : ""}`}
                    onClick={() => {
                      updateSettings({ sortBy: "dateTaken" });
                      setShowSortDropdown(false);
                    }}
                  >
                    <span>촬영 날짜 (EXIF)</span>
                    {settings.sortBy === "dateTaken" && <Check size={14} />}
                  </button>
                  <button
                    className={`sort-menu-item${settings.sortBy === "fileSize" ? " is-active" : ""}`}
                    onClick={() => {
                      updateSettings({ sortBy: "fileSize" });
                      setShowSortDropdown(false);
                    }}
                  >
                    <span>크기</span>
                    {settings.sortBy === "fileSize" && <Check size={14} />}
                  </button>
                  <button
                    className={`sort-menu-item${settings.sortBy === "fileType" ? " is-active" : ""}`}
                    onClick={() => {
                      updateSettings({ sortBy: "fileType" });
                      setShowSortDropdown(false);
                    }}
                  >
                    <span>형식 (확장자)</span>
                    {settings.sortBy === "fileType" && <Check size={14} />}
                  </button>
                  <div className="sort-menu-divider" />
                  <button
                    className={`sort-menu-item${settings.sortOrder === "asc" ? " is-active" : ""}`}
                    onClick={() => {
                      updateSettings({ sortOrder: "asc" });
                      setShowSortDropdown(false);
                    }}
                  >
                    <span>오름차순 (▲)</span>
                    {settings.sortOrder === "asc" && <Check size={14} />}
                  </button>
                  <button
                    className={`sort-menu-item${settings.sortOrder === "desc" ? " is-active" : ""}`}
                    onClick={() => {
                      updateSettings({ sortOrder: "desc" });
                      setShowSortDropdown(false);
                    }}
                  >
                    <span>내림차순 (▼)</span>
                    {settings.sortOrder === "desc" && <Check size={14} />}
                  </button>
                </div>
              )}
            </nav>
          )}

          {/* 9단계: 슬라이드쇼 남은 시간 뱃지 */}
          {isSlideshowActive && (showSlideshowBadge || isSlideshowPaused) && (
            <div className="slideshow-badge" aria-live="polite">
              슬라이드쇼 {isSlideshowPaused ? "일시정지" : `${slideshowRemainingSec}초`}
            </div>
          )}

          {/* 상단 정보 바 */}
          {view.kind === "image" && items.length > 0 && (
            <aside className={`top-info-bar${showTopBar ? " is-visible" : ""}`} aria-label="파일 탐색 정보">
              <span className="top-info-counter">
                {isDoublePage && nextItem
                  ? `${currentIndex + 1}-${currentIndex + 2} / ${items.length}`
                  : `${currentIndex + 1} / ${items.length}`}
              </span>
              <span className="top-info-divider" aria-hidden="true" />
              <span className="top-info-filename">
                {view.fileName}
                {tiffPageInfo && ` [페이지 ${tiffPageInfo.currentPage + 1} / ${tiffPageInfo.totalPages}]`}
                {activeCrop && ` [자르기: ${Math.round(activeCrop.width)}×${Math.round(activeCrop.height)}]`}
                {activeAdjust && (activeAdjust.brightness !== 0 || activeAdjust.contrast !== 0 || activeAdjust.saturation !== 0 || activeAdjust.sharpness !== 0) && " [보정]"}
                {rotation !== 0 && ` (${rotation}°)`}
                {flipH && " [좌우반전]"}
                {flipV && " [상하반전]"}
              </span>
            </aside>
          )}

          {/* 13단계: CAD 도면 파일 (.dwg, .dxf) 전용 뷰어 렌더링 */}
          {view.kind === "image" && isCadPath(view.path) && (
            <CadViewer
              filePath={view.path!}
              showToast={showToast}
              isWhiteBackground={settings.theme === "light"}
              onToggleBg={cycleBgMode}
            />
          )}

          {/* 이미지 렌더링 (단면) */}
          {view.kind === "image" && !isCadPath(view.path) && !isDoublePage && (
            <img
              key={view.src}
              className={`viewer-image${loaded ? " is-loaded" : ""}${
                settings.interpolation === "pixelated" ? " is-pixelated" : ""
              }`}
              src={view.src}
              draggable={Boolean(isFit && view.path && !view.isArchive)}
              onDragStart={(e) => {
                e.preventDefault();
                if (view.path) void startDrag({ item: [view.path], icon: "" });
              }}
              decoding="async"
              onLoad={handleImageLoad}
              onError={() =>
                setView({
                  kind: "error",
                  fileName: view.fileName,
                  message: "이미지를 표시할 수 없습니다. 파일이 손상되었거나 지원하지 않는 형식입니다.",
                  path: view.path,
                })
              }
              style={
                meta
                  ? {
                      width: `${baseWidth}px`,
                      height: `${baseHeight}px`,
                      transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})${flipTransform} rotate(${rotation}deg)`,
                      filter: liveAdjust
                        ? `brightness(${100 + liveAdjust.brightness}%) contrast(${100 + liveAdjust.contrast}%) saturate(${100 + liveAdjust.saturation}%)`
                        : undefined,
                      ...(activeCrop && !isCropping && meta
                        ? {
                            clipPath: `polygon(
                              ${(activeCrop.x / meta.naturalWidth) * 100}% ${(activeCrop.y / meta.naturalHeight) * 100}%,
                              ${((activeCrop.x + activeCrop.width) / meta.naturalWidth) * 100}% ${(activeCrop.y / meta.naturalHeight) * 100}%,
                              ${((activeCrop.x + activeCrop.width) / meta.naturalWidth) * 100}% ${((activeCrop.y + activeCrop.height) / meta.naturalHeight) * 100}%,
                              ${(activeCrop.x / meta.naturalWidth) * 100}% ${((activeCrop.y + activeCrop.height) / meta.naturalHeight) * 100}%
                            )`,
                          }
                        : {}),
                    }
                  : undefined
              }
            />
          )}

          {/* 5단계: 양면 보기 렌더링 */}
          {view.kind === "image" && !isCadPath(view.path) && isDoublePage && (
            <div
              className="double-view-container"
              style={{
                transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})${doubleFlipTransform} rotate(${rotation}deg)`,
                flexDirection: readingDirection === "rtl" ? "row-reverse" : "row",
              }}
            >
              <div className="double-view-page" style={{ width: `${baseWidth}px`, height: `${baseHeight}px` }}>
                <img
                  key={view.src}
                  className={`double-view-img${loaded ? " is-loaded" : ""}${
                    settings.interpolation === "pixelated" ? " is-pixelated" : ""
                  }`}
                  src={view.src}
                  alt={view.fileName}
                  draggable={false}
                  decoding="async"
                  onLoad={handleImageLoad}
                  style={{ width: `${baseWidth}px`, height: `${baseHeight}px` }}
                />
              </div>

              {secondSrc && (
                <div className="double-view-page" style={{ width: `${secondBaseWidth}px`, height: `${secondBaseHeight}px` }}>
                  <img
                    key={secondSrc}
                    className={`double-view-img${secondLoaded ? " is-loaded" : ""}${
                      settings.interpolation === "pixelated" ? " is-pixelated" : ""
                    }`}
                    src={secondSrc}
                    alt={nextItem?.fileName ?? ""}
                    draggable={false}
                    decoding="async"
                    onLoad={handleSecondImageLoad}
                    style={{ width: `${secondBaseWidth}px`, height: `${secondBaseHeight}px` }}
                  />
                </div>
              )}
            </div>
          )}

          {/* 안내 화면 */}
          {view.kind === "empty" && (
            <section className="placeholder">
              <div className="placeholder-icon" aria-hidden="true">
                <svg viewBox="0 0 48 48" width="48" height="48">
                  <rect x="6" y="9" width="36" height="30" rx="4" fill="none" stroke="currentColor" strokeWidth="2.5" />
                  <circle cx="17" cy="19" r="3.5" fill="currentColor" />
                  <path d="M8 35l11-11 8 8 5-5 9 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
                </svg>
              </div>
              <p className="placeholder-title">이미지 또는 ZIP/CBZ 파일을 끌어다 놓으세요</p>
              <p className="placeholder-sub">
                또는 <kbd>Ctrl</kbd> + <kbd>O</kbd> 를 눌러 파일을 여세요
              </p>
            </section>
          )}

          {/* 에러 화면 */}
          {view.kind === "error" && (
            <section className="placeholder is-error" role="alert">
              <div className="placeholder-icon" aria-hidden="true">
                <svg viewBox="0 0 48 48" width="48" height="48">
                  <circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" strokeWidth="2.5" />
                  <path d="M24 14v13" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  <circle cx="24" cy="33.5" r="2" fill="currentColor" />
                </svg>
              </div>
              <p className="placeholder-title">열 수 없는 파일</p>
              {view.fileName && <p className="error-file">{view.fileName}</p>}
              <p className="placeholder-sub">{view.message}</p>
              <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                <button id="open-another-button" className="glass-button" onClick={openDialog}>
                  다른 파일 열기
                </button>
                {items.length > 1 && (
                  <button className="glass-button" onClick={goToNext}>
                    다음 파일로 이동 (<kbd>→</kbd>)
                  </button>
                )}
              </div>
            </section>
          )}

          {/* 우측 하단 해상도 및 배율 뱃지 (상태바가 꺼져 있을 때만 표시) */}
          {view.kind === "image" && meta && loaded && !settings.showStatusBar && (
            <aside className="image-info-badge" aria-label="이미지 정보">
              <span className="image-info-res">
                {meta.naturalWidth} × {meta.naturalHeight}
              </span>
              <span className="image-info-divider" aria-hidden="true" />
              <span className="image-info-scale">{scalePercent}%</span>
            </aside>
          )}

          {/* 토스트 알림 */}
          {toastMessage && (
            <div className="toast-bubble" role="status">
              <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM9 9a1 1 0 0 0 0 2v3a1 1 0 0 0 1 1h1a1 1 0 1 0 0-2v-3a1 1 0 0 0-1-1H9z"
                  clipRule="evenodd"
                />
              </svg>
              {toastMessage}
            </div>
          )}

          {/* 하단 필름스트립 */}
          {showFilmstrip && items.length > 0 && (
            <section className={`filmstrip-container${settings.showStatusBar ? " has-status-bar" : ""}`} aria-label="썸네일 필름스트립">
              <div
                ref={filmstripScrollRef}
                className="filmstrip-scroll"
                onScroll={(e) => setFilmstripScrollLeft(e.currentTarget.scrollLeft)}
              >
                <div className="filmstrip-track" style={{ paddingLeft: `${leftPadding}px`, paddingRight: `${rightPadding}px` }}>
                  {items.slice(startThumbIdx, endThumbIdx + 1).map((item, relIdx) => {
                    const absIdx = startThumbIdx + relIdx;
                    const isActive = absIdx === currentIndex;
                    const thumbSrc = thumbnails[item.path];

                    return (
                      <div
                        key={item.path || item.entryName || absIdx}
                        className={`filmstrip-item${isActive ? " is-active" : ""}`}
                        draggable={Boolean(item.path && !item.isArchiveEntry)}
                        onDragStart={(e) => {
                          e.preventDefault();
                          if (item.path) void startDrag({ item: [item.path], icon: "" });
                        }}
                        onClick={() => navigateToIndex(absIdx)}
                        title={item.fileName}
                      >
                        {thumbSrc ? (
                          <img className="filmstrip-thumb" src={thumbSrc} alt={item.fileName} loading="lazy" />
                        ) : (
                          <div className="filmstrip-placeholder">{absIdx + 1}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {/* 7단계 & 14단계: 하단 상태바 */}
          {settings.showStatusBar && view.kind === "image" && (
            <footer className="viewer-status-bar" aria-label="상태 표시줄">
              <div className="status-item">
                <span className="status-label">순서</span>
                <span className="status-val">
                  {isDoublePage && nextItem
                    ? `${currentIndex + 1}-${currentIndex + 2} / ${items.length}`
                    : `${currentIndex + 1} / ${items.length}`}
                </span>
              </div>
              <div className="status-sep" />
              <div className="status-item status-filename" title={view.fileName}>
                <span className="status-val">{view.fileName}</span>
              </div>
              {tiffPageInfo && (
                <>
                  <div className="status-sep" />
                  <div className="status-item" style={{ color: "var(--accent)" }}>
                    <span className="status-label">TIFF</span>
                    <span className="status-val">{`페이지 ${tiffPageInfo.currentPage + 1} / ${tiffPageInfo.totalPages}`}</span>
                  </div>
                </>
              )}
              {meta && (
                <>
                  <div className="status-sep" />
                  <div className="status-item">
                    <span className="status-label">해상도</span>
                    <span className="status-val">{`${meta.naturalWidth} × ${meta.naturalHeight}`}</span>
                  </div>
                </>
              )}
              {items[currentIndex]?.fileSize ? (
                <>
                  <div className="status-sep" />
                  <div className="status-item">
                    <span className="status-label">용량</span>
                    <span className="status-val">{formatFileSize(items[currentIndex].fileSize)}</span>
                  </div>
                </>
              ) : null}
              <div className="status-sep" />
              <div className="status-item">
                <span className="status-label">배율</span>
                <span className="status-val">{`${scalePercent}%`}</span>
              </div>
            </footer>
          )}

          {/* 뷰어 모드 우측 정보 패널 */}
          {renderInfoPanel()}

          {/* 14단계 A: 자르기 오버레이 */}
          {isCropping && meta && (
            <CropOverlay
              imageWidth={meta.naturalWidth}
              imageHeight={meta.naturalHeight}
              displayedRect={(() => {
                const imgEl = viewerRef.current?.querySelector(".viewer-image");
                if (imgEl) {
                  const r = imgEl.getBoundingClientRect();
                  return { left: r.left, top: r.top, width: r.width, height: r.height };
                }
                return { left: 0, top: 0, width: meta.naturalWidth, height: meta.naturalHeight };
              })()}
              onApplyCrop={(crop) => {
                setActiveCrop(crop);
                setIsCropping(false);
                showToast(`자르기 적용됨 (${Math.round(crop.width)} × ${Math.round(crop.height)}px)`);
              }}
              onCancel={() => setIsCropping(false)}
            />
          )}

          {/* 14단계 A: 간단 사진 보정 모달 패널 */}
          {showAdjustModal && (
            <AdjustModal
              initialValues={activeAdjust}
              onChange={(vals) => setLiveAdjust(vals)}
              onApply={(vals) => {
                setActiveAdjust(vals);
                setLiveAdjust(vals);
                setShowAdjustModal(false);
                showToast("보정이 적용되었습니다. (Ctrl+S로 사본 저장)");
              }}
              onCancel={() => {
                setLiveAdjust(activeAdjust);
                setShowAdjustModal(false);
              }}
            />
          )}
        </main>
      )}

      {/* 5단계 & 8단계: 파일 휴지통 삭제 확인 모달 */}
      {showDeleteModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-box text-center" style={{ maxWidth: "440px" }}>
            <h3 className="modal-title" style={{ color: "var(--danger)" }}>파일 삭제</h3>
            <p className="modal-desc">
              {appMode === "viewer" ? (
                <>
                  다음 파일을 휴지통으로 이동하시겠습니까?
                  <br />
                  <strong style={{ display: "inline-block", marginTop: "8px", wordBreak: "break-all", overflowWrap: "anywhere", color: "var(--fg)" }}>
                    {view.kind === "image" && view.fileName}
                  </strong>
                </>
              ) : (
                <>
                  선택한 <strong style={{ color: "var(--accent)" }}>{selectedPaths.size}개 항목</strong>을 휴지통으로 이동하시겠습니까?
                </>
              )}
            </p>
            <div className="modal-buttons" style={{ justifyContent: "center" }}>
              <button className="glass-button" onClick={() => setShowDeleteModal(false)}>
                취소 (Esc)
              </button>
              <button className="glass-button btn-danger" onClick={executeDeleteToTrash}>
                휴지통으로 이동 (Enter)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6단계 & 9단계: 환경 설정 모달 (Ctrl+,) */}
      {showSettingsModal && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowSettingsModal(false);
          }}
        >
          <div className="modal-box settings-modal-box">
            <div className="modal-header">
              <h3 className="modal-title">환경 설정</h3>
              <button
                className="modal-close-btn"
                onClick={() => setShowSettingsModal(false)}
                title="닫기 (Esc)"
              >
                ✕
              </button>
            </div>

            {/* 9단계: 탭 바 (일반 / 보기) */}
            <div className="settings-tab-bar">
              <button
                className={`settings-tab-btn${settingsTab === "general" ? " is-active" : ""}`}
                onClick={() => setSettingsTab("general")}
              >
                일반 설정
              </button>
              <button
                className={`settings-tab-btn${settingsTab === "view" ? " is-active" : ""}`}
                onClick={() => setSettingsTab("view")}
              >
                보기 설정
              </button>
            </div>

            <div className="settings-body">
              {settingsTab === "general" ? (
                <>
                  <div className="setting-group">
                    <label className="setting-label">화면 테마</label>
                    <div className="setting-options">
                      <button
                        className={`setting-chip${settings.theme === "dark" ? " is-active" : ""}`}
                        onClick={() => updateSettings({ theme: "dark" })}
                      >
                        다크 테마 (Dark)
                      </button>
                      <button
                        className={`setting-chip${settings.theme === "light" ? " is-active" : ""}`}
                        onClick={() => updateSettings({ theme: "light" })}
                      >
                        라이트 테마 (Light)
                      </button>
                    </div>
                  </div>

                  <div className="setting-group">
                    <label className="setting-label">기본 배경색</label>
                    <div className="setting-options">
                      <button
                        className={`setting-chip${settings.defaultBg === "black" ? " is-active" : ""}`}
                        onClick={() => updateSettings({ defaultBg: "black" })}
                      >
                        검정색 (#000)
                      </button>
                      <button
                        className={`setting-chip${settings.defaultBg === "dark" ? " is-active" : ""}`}
                        onClick={() => updateSettings({ defaultBg: "dark" })}
                      >
                        짙은 회색 (#181a20)
                      </button>
                      <button
                        className={`setting-chip${settings.defaultBg === "checker" ? " is-active" : ""}`}
                        onClick={() => updateSettings({ defaultBg: "checker" })}
                      >
                        체크무늬 (투명 확인)
                      </button>
                    </div>
                  </div>

                  <div className="setting-group">
                    <label className="setting-label">이미지 목록 정렬 (탐색기/뷰어 공유)</label>
                    <div className="setting-options-row">
                      <div className="setting-options" style={{ flexWrap: "wrap", gap: "6px" }}>
                        <button
                          className={`setting-chip${settings.sortBy === "name" ? " is-active" : ""}`}
                          onClick={() => updateSettings({ sortBy: "name" })}
                        >
                          파일명순 (자연 정렬)
                        </button>
                        <button
                          className={`setting-chip${settings.sortBy === "dateModified" ? " is-active" : ""}`}
                          onClick={() => updateSettings({ sortBy: "dateModified" })}
                        >
                          수정 날짜순
                        </button>
                        <button
                          className={`setting-chip${settings.sortBy === "dateTaken" ? " is-active" : ""}`}
                          onClick={() => updateSettings({ sortBy: "dateTaken" })}
                        >
                          촬영 날짜순 (EXIF)
                        </button>
                        <button
                          className={`setting-chip${settings.sortBy === "fileSize" ? " is-active" : ""}`}
                          onClick={() => updateSettings({ sortBy: "fileSize" })}
                        >
                          파일 크기순
                        </button>
                        <button
                          className={`setting-chip${settings.sortBy === "fileType" ? " is-active" : ""}`}
                          onClick={() => updateSettings({ sortBy: "fileType" })}
                        >
                          파일 형식순
                        </button>
                      </div>
                      <div className="setting-options" style={{ marginTop: "8px" }}>
                        <button
                          className={`setting-chip${settings.sortOrder === "asc" ? " is-active" : ""}`}
                          onClick={() => updateSettings({ sortOrder: "asc" })}
                        >
                          오름차순 (▲)
                        </button>
                        <button
                          className={`setting-chip${settings.sortOrder === "desc" ? " is-active" : ""}`}
                          onClick={() => updateSettings({ sortOrder: "desc" })}
                        >
                          내림차순 (▼)
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="setting-group">
                    <label className="setting-label">폴더 연속 넘김</label>
                    <div className="setting-checkbox-row">
                      <label className="checkbox-container">
                        <input
                          type="checkbox"
                          checked={settings.autoNextFolder}
                          onChange={(e) => updateSettings({ autoNextFolder: e.target.checked })}
                        />
                        <span className="checkbox-text">마지막 장에서 다음 폴더로 넘어가기</span>
                      </label>
                    </div>
                    <p className="setting-hint">
                      폴더의 마지막 장에서 다음을 누르면 같은 상위 폴더의 다음 폴더로 자동 이동합니다.
                    </p>
                  </div>

                  <div className="setting-group">
                    <label className="setting-label">화면 인터페이스 표시</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <label className="checkbox-container">
                        <input
                          type="checkbox"
                          checked={settings.showToolbar}
                          onChange={(e) => updateSettings({ showToolbar: e.target.checked })}
                        />
                        <span className="checkbox-text">상단 툴바 표시</span>
                      </label>
                      <label className="checkbox-container">
                        <input
                          type="checkbox"
                          checked={settings.showStatusBar}
                          onChange={(e) => updateSettings({ showStatusBar: e.target.checked })}
                        />
                        <span className="checkbox-text">하단 상태 표시줄 표시</span>
                      </label>
                    </div>
                  </div>

                  {/* 13단계: CAD 도면 파일 (.dwg, .dxf) 연결 */}
                  <div className="setting-group">
                    <label className="setting-label">CAD 도면 파일 (.dwg, .dxf) 연결</label>
                    <div className="setting-checkbox-row">
                      <label className="checkbox-container">
                        <input
                          type="checkbox"
                          checked={Boolean(settings.cadFileAssociation)}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            void updateSettings({ cadFileAssociation: checked });
                            invoke("set_cad_file_association", { enabled: checked })
                              .then(() => {
                                showToast(checked ? "CAD 파일 연결이 설정되었습니다." : "CAD 파일 연결이 해제되었습니다.");
                              })
                              .catch((err) => {
                                showToast(`CAD 연결 설정 실패: ${String(err)}`);
                              });
                          }}
                        />
                        <span className="checkbox-text">DWG, DXF 도면 파일을 k-boda로 열기 (기본값: 해제)</span>
                      </label>
                    </div>
                    <p className="setting-hint">
                      설정 시 Windows 탐색기에서 .dwg 및 .dxf 파일을 더블클릭하면 k-boda CAD 뷰어로 즉시 열립니다.
                    </p>
                  </div>

                  {/* 10단계: 외부 편집기 프로그램 관리 */}
                  <div className="setting-group">
                    <label className="setting-label">외부 편집기 프로그램 등록</label>
                    <p className="setting-hint" style={{ marginBottom: "8px" }}>
                      등록한 편집기는 우클릭 메뉴의 '다음 프로그램으로 편집' 하위 메뉴에 표시됩니다. (기본: 그림판)
                    </p>
                    <div className="external-editors-list">
                      {(!settings.externalEditors || settings.externalEditors.length === 0) ? (
                        <div className="editor-empty-hint">등록된 추가 편집기가 없습니다.</div>
                      ) : (
                        settings.externalEditors.map((ed) => (
                          <div key={ed.id} className="external-editor-row">
                            <div className="editor-info">
                              <span className="editor-name">{ed.name}</span>
                              <span className="editor-path">{ed.path}</span>
                            </div>
                            <button
                              type="button"
                              className="editor-del-btn"
                              onClick={() => handleRemoveExternalEditor(ed.id)}
                              title="편집기 삭제"
                            >
                              ✕
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="external-editor-add-form" style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <input
                          type="text"
                          className="modal-input"
                          placeholder="프로그램 이름 (예: Photoshop)"
                          value={newEditorName}
                          onChange={(e) => setNewEditorName(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="glass-button btn-primary"
                          onClick={handleAddExternalEditor}
                          style={{ padding: "6px 14px", whiteSpace: "nowrap" }}
                        >
                          추가
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <input
                          type="text"
                          className="modal-input"
                          placeholder="실행 파일 경로 (.exe)"
                          value={newEditorPath}
                          onChange={(e) => setNewEditorPath(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="glass-button"
                          onClick={handleBrowseEditorPath}
                          style={{ padding: "6px 12px", whiteSpace: "nowrap" }}
                        >
                          찾기...
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                /* 9단계: 보기 설정 탭 */
                <>
                  <div className="setting-group">
                    <label className="setting-label">1. 이미지 확대 방식</label>
                    <div className="setting-options" style={{ flexDirection: "column", gap: "6px" }}>
                      <button
                        className={`setting-chip${settings.zoomMode === "fitIfLarge" ? " is-active" : ""}`}
                        style={{ textAlign: "left", justifyContent: "flex-start" }}
                        onClick={() => updateSettings({ zoomMode: "fitIfLarge" })}
                      >
                        ① 큰 이미지만 화면에 맞춤, 작은 이미지는 원본 크기 (기본값)
                      </button>
                      <button
                        className={`setting-chip${settings.zoomMode === "fitAlways" ? " is-active" : ""}`}
                        style={{ textAlign: "left", justifyContent: "flex-start" }}
                        onClick={() => updateSettings({ zoomMode: "fitAlways" })}
                      >
                        ② 항상 화면에 맞춤 (작은 이미지도 화면에 맞춰 확대)
                      </button>
                      <button
                        className={`setting-chip${settings.zoomMode === "originalAlways" ? " is-active" : ""}`}
                        style={{ textAlign: "left", justifyContent: "flex-start" }}
                        onClick={() => updateSettings({ zoomMode: "originalAlways" })}
                      >
                        ③ 항상 원본 크기 (100%)
                      </button>
                      <button
                        className={`setting-chip${settings.zoomMode === "fitWidth" ? " is-active" : ""}`}
                        style={{ textAlign: "left", justifyContent: "flex-start" }}
                        onClick={() => updateSettings({ zoomMode: "fitWidth" })}
                      >
                        ④ 너비에 맞춤 (긴 세로 이미지·웹툰용, 위아래 스크롤)
                      </button>
                    </div>
                  </div>

                  <div className="setting-group">
                    <label className="setting-label">2. 마우스 휠 동작</label>
                    <div className="setting-options">
                      <button
                        className={`setting-chip${settings.wheelAction === "navigate" ? " is-active" : ""}`}
                        onClick={() => updateSettings({ wheelAction: "navigate" })}
                      >
                        이전/다음 이미지 이동 (기본값, 꿀뷰 방식)
                      </button>
                      <button
                        className={`setting-chip${settings.wheelAction === "zoom" ? " is-active" : ""}`}
                        onClick={() => updateSettings({ wheelAction: "zoom" })}
                      >
                        화면 확대/축소
                      </button>
                    </div>
                    <p className="setting-hint">
                      어느 쪽을 선택하든 <kbd>Ctrl+휠</kbd>은 항상 확대/축소로 작동하며, '너비에 맞춤' 모드에서는 휠이 스크롤로 작동합니다.
                    </p>
                  </div>

                  <div className="setting-group">
                    <label className="setting-label">3. 이미지 전환 시 상태 유지</label>
                    <div className="setting-checkbox-row">
                      <label className="checkbox-container">
                        <input
                          type="checkbox"
                          checked={settings.keepTransform}
                          onChange={(e) => updateSettings({ keepTransform: e.target.checked })}
                        />
                        <span className="checkbox-text">다음 이미지로 넘길 때 배율·위치·회전 유지</span>
                      </label>
                    </div>
                    <p className="setting-hint">
                      기본값은 유지 안 함(새 사진 로드 시 배율 및 위치 초기화)입니다.
                    </p>
                  </div>

                  <div className="setting-group">
                    <label className="setting-label">4. 확대 보간 방식</label>
                    <div className="setting-options">
                      <button
                        className={`setting-chip${settings.interpolation === "smooth" ? " is-active" : ""}`}
                        onClick={() => updateSettings({ interpolation: "smooth" })}
                      >
                        부드럽게 (사진용, 기본값)
                      </button>
                      <button
                        className={`setting-chip${settings.interpolation === "pixelated" ? " is-active" : ""}`}
                        onClick={() => updateSettings({ interpolation: "pixelated" })}
                      >
                        픽셀 그대로 (도트 그림·아이콘용)
                      </button>
                    </div>
                    <p className="setting-hint">
                      툴바의 그리드 아이콘 버튼으로도 즉시 전환할 수 있습니다.
                    </p>
                  </div>

                  <div className="setting-group">
                    <label className="setting-label">5. 슬라이드쇼 설정</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "12px", color: "var(--fg-muted)" }}>전환 간격:</span>
                        <input
                          type="number"
                          min={1}
                          max={60}
                          value={settings.slideshowInterval}
                          onChange={(e) => {
                            const val = Math.max(1, Number(e.target.value) || 3);
                            updateSettings({ slideshowInterval: val });
                          }}
                          style={{
                            width: "60px",
                            padding: "4px 8px",
                            background: "rgba(255, 255, 255, 0.08)",
                            border: "1px solid var(--border-color)",
                            borderRadius: "4px",
                            color: "var(--fg-main)",
                          }}
                        />
                        <span style={{ fontSize: "12px" }}>초</span>
                      </div>
                      <label className="checkbox-container">
                        <input
                          type="checkbox"
                          checked={settings.slideshowRandom}
                          onChange={(e) => updateSettings({ slideshowRandom: e.target.checked })}
                        />
                        <span className="checkbox-text">무작위 순서로 재생</span>
                      </label>
                      <label className="checkbox-container">
                        <input
                          type="checkbox"
                          checked={settings.slideshowLoop}
                          onChange={(e) => updateSettings({ slideshowLoop: e.target.checked })}
                        />
                        <span className="checkbox-text">끝에 도달하면 처음부터 반복</span>
                      </label>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="modal-buttons">
              <button className="glass-button btn-primary" onClick={() => setShowSettingsModal(false)}>
                확인 (Esc)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 9단계: 다른 이름으로 저장 모달 (Ctrl+Shift+S) */}
      {showSaveAsModal && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowSaveAsModal(false);
          }}
        >
          <div className="modal-box" style={{ maxWidth: "520px", width: "94vw" }}>
            <div className="modal-header">
              <h3 className="modal-title">다른 이름으로 저장</h3>
              <button className="modal-close-btn" onClick={() => setShowSaveAsModal(false)} title="닫기 (Esc)">
                ✕
              </button>
            </div>

            <div className="modal-form-content">
              <div className="form-group">
                <label className="form-label">저장 파일 경로</label>
                <div style={{ display: "flex", gap: "6px" }}>
                  <input
                    type="text"
                    className="modal-input"
                    value={saveAsTargetPath}
                    onChange={(e) => setSaveAsTargetPath(e.target.value)}
                    placeholder="저장할 파일 경로"
                    style={{ flex: 1 }}
                  />
                  <button className="glass-button" onClick={handleBrowseSaveTarget} style={{ padding: "6px 12px" }}>
                    찾아보기...
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">저장 형식 (포맷)</label>
                <div className="setting-options">
                  {(["jpg", "png", "webp", "bmp"] as const).map((fmt) => (
                    <button
                      key={fmt}
                      className={`setting-chip${saveAsFormat === fmt ? " is-active" : ""}`}
                      onClick={() => {
                        setSaveAsFormat(fmt);
                        if (saveAsTargetPath) {
                          const dotIdx = saveAsTargetPath.lastIndexOf(".");
                          if (dotIdx !== -1) {
                            setSaveAsTargetPath(`${saveAsTargetPath.slice(0, dotIdx)}.${fmt}`);
                          }
                        }
                      }}
                    >
                      {fmt.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {(saveAsFormat === "jpg" || saveAsFormat === "webp") && (
                <div className="form-group">
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <label className="form-label" style={{ margin: 0 }}>
                      압축 품질
                    </label>
                    <span style={{ fontSize: "12px", color: "var(--accent-color)" }}>{saveAsQuality}%</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={saveAsQuality}
                    onChange={(e) => setSaveAsQuality(Number(e.target.value))}
                    style={{ width: "100%" }}
                  />
                </div>
              )}

              <div className="form-group">
                <label className="form-label">메타데이터 옵션</label>
                <p className="setting-hint">저장한 사본에는 EXIF·AI 프롬프트 등 메타데이터가 포함되지 않습니다.</p>
              </div>

              {(rotation !== 0 || flipH || flipV || (saveAsResizeW && saveAsResizeW > 0)) && (
                <div
                  style={{
                    padding: "8px 12px",
                    background: "rgba(59, 130, 246, 0.12)",
                    border: "1px solid rgba(59, 130, 246, 0.3)",
                    borderRadius: "6px",
                    fontSize: "12px",
                    lineHeight: "1.4",
                    color: "var(--fg-main)",
                  }}
                >
                  <strong>적용된 변환 사항:</strong>
                  <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                    {rotation !== 0 && <li>회전: {rotation}°</li>}
                    {flipH && <li>좌우 반전</li>}
                    {flipV && <li>상하 반전</li>}
                    {saveAsResizeW && saveAsResizeH && (
                      <li>크기 조정: {saveAsResizeW} × {saveAsResizeH} (Lanczos3 필터)</li>
                    )}
                  </ul>
                  <span style={{ color: "var(--fg-dim)", fontSize: "11px" }}>
                    * 원본 파일은 그대로 유지되며 사본으로 저장됩니다.
                  </span>
                </div>
              )}
            </div>

            <div className="modal-buttons" style={{ marginTop: "16px" }}>
              <button className="glass-button" onClick={() => setShowSaveAsModal(false)}>
                취소 (Esc)
              </button>
              <button className="glass-button btn-primary" onClick={executeSaveAs}>
                저장하기 (Enter)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 9단계: 크기 조정 모달 (Ctrl+R) */}
      {showResizeModal && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowResizeModal(false);
          }}
        >
          <div className="modal-box" style={{ maxWidth: "460px", width: "94vw" }}>
            <div className="modal-header">
              <h3 className="modal-title">이미지 크기 조정</h3>
              <button className="modal-close-btn" onClick={() => setShowResizeModal(false)} title="닫기 (Esc)">
                ✕
              </button>
            </div>

            <div className="modal-form-content">
              {meta && (
                <p style={{ fontSize: "12px", color: "var(--fg-muted)", marginBottom: "12px" }}>
                  현재 크기: <strong>{meta.naturalWidth} × {meta.naturalHeight}</strong> px
                </p>
              )}

              <div className="form-group">
                <label className="form-label">단위 선택</label>
                <div className="setting-options">
                  <button
                    className={`setting-chip${resizeUnit === "pixel" ? " is-active" : ""}`}
                    onClick={() => setResizeUnit("pixel")}
                  >
                    픽셀 (px)
                  </button>
                  <button
                    className={`setting-chip${resizeUnit === "percent" ? " is-active" : ""}`}
                    onClick={() => setResizeUnit("percent")}
                  >
                    비율 (%)
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                  <label className="form-label">너비 ({resizeUnit === "pixel" ? "px" : "%"})</label>
                  <input
                    type="number"
                    className="modal-input"
                    value={resizeUnit === "pixel" ? resizeCustomW : meta ? Math.round((resizeCustomW / meta.naturalWidth) * 100) : 100}
                    onChange={(e) => {
                      const val = Number(e.target.value) || 0;
                      if (resizeUnit === "pixel") {
                        setResizeCustomW(val);
                        if (resizeKeepRatio && meta && meta.naturalWidth > 0) {
                          setResizeCustomH(Math.round(val * (meta.naturalHeight / meta.naturalWidth)));
                        }
                      } else {
                        if (meta) {
                          const px = Math.round(meta.naturalWidth * (val / 100));
                          setResizeCustomW(px);
                          if (resizeKeepRatio) {
                            setResizeCustomH(Math.round(meta.naturalHeight * (val / 100)));
                          }
                        }
                      }
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="form-label">높이 ({resizeUnit === "pixel" ? "px" : "%"})</label>
                  <input
                    type="number"
                    className="modal-input"
                    value={resizeUnit === "pixel" ? resizeCustomH : meta ? Math.round((resizeCustomH / meta.naturalHeight) * 100) : 100}
                    onChange={(e) => {
                      const val = Number(e.target.value) || 0;
                      if (resizeUnit === "pixel") {
                        setResizeCustomH(val);
                        if (resizeKeepRatio && meta && meta.naturalHeight > 0) {
                          setResizeCustomW(Math.round(val * (meta.naturalWidth / meta.naturalHeight)));
                        }
                      } else {
                        if (meta) {
                          const px = Math.round(meta.naturalHeight * (val / 100));
                          setResizeCustomH(px);
                          if (resizeKeepRatio) {
                            setResizeCustomW(Math.round(meta.naturalWidth * (val / 100)));
                          }
                        }
                      }
                    }}
                  />
                </div>
              </div>

              <div style={{ marginTop: "10px" }}>
                <label className="checkbox-container">
                  <input
                    type="checkbox"
                    checked={resizeKeepRatio}
                    onChange={(e) => setResizeKeepRatio(e.target.checked)}
                  />
                  <span className="checkbox-text">가로세로 비율 유지</span>
                </label>
              </div>

              <div className="form-group" style={{ marginTop: "14px" }}>
                <label className="form-label">자주 쓰는 크기</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  <button
                    className="setting-chip"
                    onClick={() => {
                      if (!meta) return;
                      const w = 1920;
                      const h = resizeKeepRatio ? Math.round(w * (meta.naturalHeight / meta.naturalWidth)) : meta.naturalHeight;
                      setResizeCustomW(w);
                      setResizeCustomH(h);
                      setResizeUnit("pixel");
                    }}
                  >
                    1920 (FHD)
                  </button>
                  <button
                    className="setting-chip"
                    onClick={() => {
                      if (!meta) return;
                      const w = 1280;
                      const h = resizeKeepRatio ? Math.round(w * (meta.naturalHeight / meta.naturalWidth)) : meta.naturalHeight;
                      setResizeCustomW(w);
                      setResizeCustomH(h);
                      setResizeUnit("pixel");
                    }}
                  >
                    1280 (HD)
                  </button>
                  <button
                    className="setting-chip"
                    onClick={() => {
                      if (!meta) return;
                      const w = 800;
                      const h = resizeKeepRatio ? Math.round(w * (meta.naturalHeight / meta.naturalWidth)) : meta.naturalHeight;
                      setResizeCustomW(w);
                      setResizeCustomH(h);
                      setResizeUnit("pixel");
                    }}
                  >
                    800
                  </button>
                  <button
                    className="setting-chip"
                    onClick={() => {
                      if (!meta) return;
                      setResizeCustomW(Math.round(meta.naturalWidth * 0.5));
                      setResizeCustomH(Math.round(meta.naturalHeight * 0.5));
                      setResizeUnit("pixel");
                    }}
                  >
                    50%
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-buttons" style={{ marginTop: "16px" }}>
              <button className="glass-button" onClick={() => setShowResizeModal(false)}>
                취소 (Esc)
              </button>
              <button
                className="glass-button btn-primary"
                onClick={() => {
                  setShowResizeModal(false);
                  openSaveAsModal(resizeCustomW, resizeCustomH);
                }}
              >
                다음: 저장하기 (Enter)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6단계 & 7단계 & 11단계: 도움말 및 PrismView 정보 모달 */}
      {showHelpModal && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowHelpModal(false);
          }}
        >
          <div className="modal-box help-modal-box" style={{ maxWidth: "620px" }}>
            <div className="modal-header">
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <h3 className="modal-title">PrismView 도움말 & 정보</h3>
                <span style={{ fontSize: "12px", padding: "2px 8px", borderRadius: "12px", background: "var(--accent)", color: "#fff", fontWeight: 600 }}>
                  v{appEnvInfo?.version || "1.0.0"}
                </span>
              </div>
              <button
                className="modal-close-btn"
                onClick={() => setShowHelpModal(false)}
                title="닫기 (Esc)"
              >
                ✕
              </button>
            </div>

            {/* 상단 탭 버튼 */}
            <div className="settings-tabs" style={{ padding: "0 20px 8px" }}>
              <button
                className={`tab-button ${helpModalTab === "shortcuts" ? "active" : ""}`}
                onClick={() => setHelpModalTab("shortcuts")}
              >
                단축키 안내
              </button>
              <button
                className={`tab-button ${helpModalTab === "about" ? "active" : ""}`}
                onClick={() => setHelpModalTab("about")}
              >
                PrismView 정보
              </button>
              <button
                className={`tab-button ${helpModalTab === "license" ? "active" : ""}`}
                onClick={() => setHelpModalTab("license")}
              >
                오픈소스 라이선스
              </button>
            </div>

            <div className="help-content-scroll" style={{ maxHeight: "460px" }}>
              {helpModalTab === "shortcuts" && (
                <>
                  {(
                    [
                      "탐색 및 이동",
                      "화면 확대 및 뷰포트",
                      "보기 모드 및 편집",
                      "파일 및 부가 기능",
                    ] as const
                  ).map((category) => {
                    const categoryCmds = commands.filter(
                      (c) => c.category === category && c.shortcutDisplay
                    );
                    if (categoryCmds.length === 0) return null;
                    return (
                      <div key={category} className="help-section">
                        <h4 className="help-section-title">{category}</h4>
                        <table className="help-table">
                          <tbody>
                            {categoryCmds.map((cmd) => (
                              <tr key={cmd.id}>
                                <td>
                                  {cmd.shortcutDisplay.split("/").map((part, pIdx) => (
                                    <span key={pIdx}>
                                      {pIdx > 0 && " / "}
                                      <kbd>{part.trim()}</kbd>
                                    </span>
                                  ))}
                                </td>
                                <td>
                                  {cmd.label}
                                  {cmd.scope && cmd.scope !== "all" && (
                                    <span
                                      style={{
                                        fontSize: "10.5px",
                                        color: "var(--fg-dim)",
                                        marginLeft: "6px",
                                      }}
                                    >
                                      ({cmd.scope === "viewer" ? "뷰어 전용" : "탐색기 전용"})
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </>
              )}

              {helpModalTab === "about" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "4px" }}>
                  <div style={{ background: "rgba(255, 255, 255, 0.04)", padding: "14px", borderRadius: "8px", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
                    <div style={{ fontSize: "16px", fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", gap: "8px" }}>
                      PrismView <span style={{ fontSize: "12px", color: "var(--accent)" }}>v1.0.0 정식 릴리즈</span>
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--fg-dim)", marginTop: "4px" }}>
                      윈도우 10/11 전용 빠르고 가벼운 초경량 이미지 뷰어
                    </div>
                  </div>

                  <div style={{ background: "rgba(255, 255, 255, 0.03)", padding: "12px", borderRadius: "8px", fontSize: "12px", lineHeight: "1.7" }}>
                    <div><strong>• 실행 환경:</strong> {appEnvInfo?.isPortable ? "🚀 무설치 포터블(Portable) 모드" : "💻 일반 설치(Installer) 모드"}</div>
                    <div><strong>• 데이터 저장 위치:</strong> <span style={{ wordBreak: "break-all", color: "#38bdf8" }}>{appEnvInfo?.dataDir || "%APPDATA%\\PrismView"}</span></div>
                    {appEnvInfo?.isReadOnly ? (
                      <div style={{ color: "#ef4444", marginTop: "4px" }}>
                        ⚠️ 현재 실행 폴더에 쓰기 권한이 없어 시스템 임시 폴더에 캐시 중입니다.
                      </div>
                    ) : (
                      <div style={{ color: "#4ade80", marginTop: "2px" }}>
                        ✔ 설정 및 캐시 쓰기 정상
                      </div>
                    )}
                  </div>

                  <div style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.25)", padding: "12px", borderRadius: "8px", fontSize: "12px", lineHeight: "1.6" }}>
                    <strong style={{ color: "#38bdf8" }}>🔒 100% 로컬 프라이버시 보장</strong>
                    <div style={{ color: "var(--fg-dim)", marginTop: "4px" }}>
                      사진, 공무원증/증명사진, CAD 도면 등 어떤 데이터도 외부 인터넷이나 클라우드로 전송되지 않습니다.
                      얼굴 인식(MediaPipe BlazeFace), 포맷 변환, 인쇄 등 모든 기능이 PC 내부에서 오프라인으로 작동합니다.
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "6px" }}>
                    <button
                      className="glass-button btn-secondary"
                      onClick={() => setHelpModalTab("license")}
                    >
                      📜 전체 오픈소스 라이선스 목록 보기
                    </button>
                  </div>
                </div>
              )}

              {helpModalTab === "license" && (
                <div style={{ fontSize: "11.5px", lineHeight: "1.6", color: "var(--fg-dim)" }}>
                  <div style={{ background: "rgba(255, 255, 255, 0.03)", padding: "12px", borderRadius: "8px", marginBottom: "12px" }}>
                    <h4 style={{ color: "#fff", fontSize: "13px", marginBottom: "6px" }}>오픈소스 소프트웨어 고지</h4>
                    PrismView는 전 세계 오픈소스 커뮤니티의 훌륭한 프로젝트들을 기반으로 제작되었습니다.
                  </div>

                  <div className="help-section" style={{ background: "rgba(255, 255, 255, 0.02)", padding: "10px", borderRadius: "6px", marginBottom: "10px" }}>
                    <h4 style={{ color: "#fff", fontSize: "12px", marginBottom: "4px" }}>1. GNU LibreDWG (CAD 도면 변환기)</h4>
                    <p>• 라이선스: GNU General Public License v3.0 이상 (GPLv3+)</p>
                    <p>• 격리 구조: 앱에 링크되지 않고 별도 프로세스(sidecar CLI: dwg2dxf.exe)로만 격리 호출</p>
                    <p>• 소스 코드: <span style={{ color: "var(--accent)" }}>https://www.gnu.org/software/libredwg/</span></p>
                  </div>

                  <div className="help-section" style={{ background: "rgba(255, 255, 255, 0.02)", padding: "10px", borderRadius: "6px", marginBottom: "10px" }}>
                    <h4 style={{ color: "#fff", fontSize: "12px", marginBottom: "4px" }}>2. MediaPipe Tasks Vision (BlazeFace 로컬 AI)</h4>
                    <p>• 라이선스: Apache License 2.0 (Google LLC)</p>
                    <p>• 100% 로컬 WASM 및 TFLite 모델 내장 (외부 통신 0건)</p>
                  </div>

                  <div className="help-section" style={{ background: "rgba(255, 255, 255, 0.02)", padding: "10px", borderRadius: "6px", marginBottom: "10px" }}>
                    <h4 style={{ color: "#fff", fontSize: "12px", marginBottom: "4px" }}>3. 주요 프레임워크 및 라이브러리</h4>
                    <p>• <strong>React 19 / ReactDOM:</strong> MIT License</p>
                    <p>• <strong>Tauri 2 Framework:</strong> MIT / Apache 2.0 License</p>
                    <p>• <strong>dxf-parser:</strong> MIT License</p>
                    <p>• <strong>Lucide Icons:</strong> ISC License</p>
                    <p>• <strong>Rust Crates (image, tiff, zip, trash, pdf-writer, kamadak-exif):</strong> MIT / Apache 2.0 / BSD</p>
                  </div>

                  <div style={{ textAlign: "center", marginTop: "10px", opacity: 0.8 }}>
                    앱 설치 폴더의 <code>LICENSES.txt</code> 및 <code>GPLv3.txt</code> 파일에서 전문을 확인하실 수 있습니다.
                  </div>
                </div>
              )}
            </div>

            <div className="modal-buttons" style={{ display: "flex", justifyContent: "space-between" }}>
              {helpModalTab !== "shortcuts" ? (
                <button className="glass-button btn-secondary" onClick={() => setHelpModalTab("shortcuts")}>
                  ← 단축키 안내로
                </button>
              ) : <div />}
              <button className="glass-button btn-primary" onClick={() => setShowHelpModal(false)}>
                닫기 (Esc)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 10단계: 이름 바꾸기 모달 (F2) */}
      {showRenameModal && renameTargetItem && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowRenameModal(false);
          }}
        >
          <div className="modal-box" style={{ maxWidth: "420px" }}>
            <div className="modal-header">
              <h3 className="modal-title">
                {renameTargetItem.isDir ? "폴더 이름 바꾸기" : "파일 이름 바꾸기"}
              </h3>
              <button
                className="modal-close-btn"
                onClick={() => setShowRenameModal(false)}
                title="닫기 (Esc)"
              >
                ✕
              </button>
            </div>

            <div className="modal-form-content">
              <div className="form-group">
                <label className="form-label">현재 이름</label>
                <div className="modal-current-name-display">{renameTargetItem.oldName}</div>
              </div>

              <div className="form-group">
                <label className="form-label">새 이름</label>
                <input
                  ref={renameInputRef}
                  type="text"
                  className={`modal-input${renameError ? " is-error" : ""}`}
                  value={renameNewName}
                  onChange={(e) => {
                    setRenameNewName(e.target.value);
                    setRenameError(validateFileName(e.target.value));
                  }}
                  placeholder="새 이름을 입력하세요"
                />
                {renameError && <div className="modal-error-text">{renameError}</div>}
              </div>
            </div>

            <div className="modal-buttons">
              <button
                type="button"
                className="glass-button"
                onClick={() => setShowRenameModal(false)}
              >
                취소 (Esc)
              </button>
              <button
                type="button"
                className="glass-button btn-primary"
                onClick={() => void executeRename()}
                disabled={Boolean(renameError) || !renameNewName.trim()}
              >
                변경 (Enter)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 10단계: 폴더로 복사(F7) / 폴더로 이동(F8) 모달 */}
      {showCopyMoveModal && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowCopyMoveModal(false);
          }}
        >
          <div className="modal-box" style={{ maxWidth: "480px" }}>
            <div className="modal-header">
              <h3 className="modal-title">
                {copyMoveMode === "copy" ? "폴더로 복사" : "폴더로 이동"} ({copyMoveSourcePaths.length}개 항목)
              </h3>
              <button
                className="modal-close-btn"
                onClick={() => setShowCopyMoveModal(false)}
                title="닫기 (Esc)"
              >
                ✕
              </button>
            </div>

            <div className="modal-form-content">
              <div className="form-group">
                <label className="form-label">대상 폴더</label>
                <div style={{ display: "flex", gap: "6px" }}>
                  <input
                    type="text"
                    className="modal-input"
                    value={copyMoveTargetFolder}
                    onChange={(e) => setCopyMoveTargetFolder(e.target.value)}
                    placeholder="대상 폴더 경로"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="glass-button"
                    onClick={handleBrowseCopyMoveTarget}
                    style={{ padding: "6px 12px", whiteSpace: "nowrap" }}
                  >
                    찾아보기...
                  </button>
                </div>
              </div>

              {/* 최근 사용한 대상 폴더 5개 빠른 선택 칩 */}
              {settings.recentTargetFolders && settings.recentTargetFolders.length > 0 && (
                <div className="form-group">
                  <label className="form-label">최근 사용한 대상 폴더</label>
                  <div className="setting-options" style={{ flexWrap: "wrap", gap: "6px" }}>
                    {settings.recentTargetFolders.slice(0, 5).map((folder) => (
                      <button
                        key={folder}
                        type="button"
                        className={`setting-chip${copyMoveTargetFolder === folder ? " is-active" : ""}`}
                        onClick={() => setCopyMoveTargetFolder(folder)}
                        title={folder}
                      >
                        {baseName(folder)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">이름이 같은 파일이 있을 때</label>
                <div className="setting-options">
                  <button
                    type="button"
                    className={`setting-chip${copyMoveConflict === "rename" ? " is-active" : ""}`}
                    onClick={() => setCopyMoveConflict("rename")}
                  >
                    번호 붙여 저장
                  </button>
                  <button
                    type="button"
                    className={`setting-chip${copyMoveConflict === "overwrite" ? " is-active" : ""}`}
                    onClick={() => setCopyMoveConflict("overwrite")}
                  >
                    덮어쓰기
                  </button>
                  <button
                    type="button"
                    className={`setting-chip${copyMoveConflict === "skip" ? " is-active" : ""}`}
                    onClick={() => setCopyMoveConflict("skip")}
                  >
                    건너뛰기
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-buttons">
              <button
                type="button"
                className="glass-button"
                onClick={() => setShowCopyMoveModal(false)}
              >
                취소 (Esc)
              </button>
              <button
                type="button"
                className="glass-button btn-primary"
                onClick={() => void executeCopyMove()}
                disabled={!copyMoveTargetFolder.trim()}
              >
                {copyMoveMode === "copy" ? "복사 시작" : "이동 시작"} (Enter)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7단계: 우클릭 컨텍스트 메뉴 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            visibility: "hidden",
          }}
          role="menu"
        >
          {CONTEXT_MENU_GROUPS.map((group, groupIdx) => (
            <div key={groupIdx} className="context-menu-group">
              {group.map((cmdId) => {
                const cmd = commandMap.get(cmdId);
                if (!cmd) return null;

                // 10단계: 바탕화면 배경으로 설정 하위 메뉴
                if (cmd.id === "setWallpaper") {
                  return (
                    <div key={cmd.id} className="context-menu-submenu-wrapper">
                      <div className={`context-menu-item context-menu-has-submenu${!cmd.isEnabled ? " is-disabled" : ""}`}>
                        <span className="context-menu-icon">{cmd.icon}</span>
                        <span className="context-menu-label">{cmd.label}</span>
                        <ChevronRightIcon size={13} style={{ marginLeft: "auto", opacity: 0.6 }} />
                      </div>
                      {cmd.isEnabled && (
                        <div className="context-submenu glass-panel">
                          <button
                            type="button"
                            className="context-menu-item"
                            onClick={() => {
                              setContextMenu(null);
                              void handleSetWallpaper("fill");
                            }}
                          >
                            <span className="context-menu-label">채우기 (기본)</span>
                          </button>
                          <button
                            type="button"
                            className="context-menu-item"
                            onClick={() => {
                              setContextMenu(null);
                              void handleSetWallpaper("fit");
                            }}
                          >
                            <span className="context-menu-label">맞춤</span>
                          </button>
                          <button
                            type="button"
                            className="context-menu-item"
                            onClick={() => {
                              setContextMenu(null);
                              void handleSetWallpaper("center");
                            }}
                          >
                            <span className="context-menu-label">가운데</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }

                // 10단계: 외부 편집기 하위 메뉴
                if (cmd.id === "openExternalEditor") {
                  return (
                    <div key={cmd.id} className="context-menu-submenu-wrapper">
                      <div className={`context-menu-item context-menu-has-submenu${!cmd.isEnabled ? " is-disabled" : ""}`}>
                        <span className="context-menu-icon">{cmd.icon}</span>
                        <span className="context-menu-label">다음 프로그램으로 편집</span>
                        <ChevronRightIcon size={13} style={{ marginLeft: "auto", opacity: 0.6 }} />
                      </div>
                      {cmd.isEnabled && (
                        <div className="context-submenu glass-panel">
                          <button
                            type="button"
                            className="context-menu-item"
                            onClick={() => {
                              setContextMenu(null);
                              void handleOpenExternalEditor();
                            }}
                          >
                            <span className="context-menu-label">그림판 (기본)</span>
                            <span className="context-menu-shortcut">Ctrl+E</span>
                          </button>
                          {(settings.externalEditors || []).map((ed) => (
                            <button
                              key={ed.id}
                              type="button"
                              className="context-menu-item"
                              onClick={() => {
                                setContextMenu(null);
                                void handleOpenExternalEditor(ed.path);
                              }}
                            >
                              <span className="context-menu-label">{ed.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <button
                    key={cmd.id}
                    className="context-menu-item"
                    disabled={!cmd.isEnabled}
                    onClick={() => {
                      setContextMenu(null);
                      void cmd.action();
                    }}
                    role="menuitem"
                  >
                    <span className="context-menu-icon">{cmd.icon}</span>
                    <span className="context-menu-label">{cmd.label}</span>
                    {cmd.shortcutDisplay && (
                      <span className="context-menu-shortcut">{cmd.shortcutDisplay}</span>
                    )}
                  </button>
                );
              })}
              {groupIdx < CONTEXT_MENU_GROUPS.length - 1 && <div className="context-menu-divider" />}
            </div>
          ))}
        </div>
      )}

      {/* 드래그 앤 드롭 오버레이 */}
      {draggingFile && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-box">여기에 놓으면 열립니다 (이미지 또는 ZIP/CBZ)</div>
        </div>
      )}

      {/* 증명사진 만들기 에디터 */}
      {idPhotoTargetPaths && idPhotoTargetPaths.length > 0 && (
        <IdPhotoEditor
          initialPaths={idPhotoTargetPaths}
          onClose={() => setIdPhotoTargetPaths(null)}
          showToast={showToast}
          initialSaveDir={settings.lastFolder}
          onUpdateSaveDir={(dir) => {
            void updateSettings({ lastFolder: dir });
          }}
        />
      )}

      {/* 14단계 B: 일괄 작업 (크기 조정·변환, 이름 바꾸기, 회전) 모달 */}
      {batchModalState && batchModalState.paths.length > 0 && (
        <BatchProcessingModal
          initialMode={batchModalState.mode}
          targetPaths={batchModalState.paths}
          onClose={() => setBatchModalState(null)}
          showToast={showToast}
          onRefreshExplorer={refreshExplorer}
          onUndoAdded={() => setUndoCount((c) => Math.min(20, c + 1))}
        />
      )}

      {/* 14단계 C: 모자이크·흐림 개인정보 가리기 모달 */}
      {mosaicModalPath && (
        <MosaicEditorModal
          imagePath={mosaicModalPath}
          onClose={() => setMosaicModalPath(null)}
          showToast={showToast}
          onSaved={() => refreshExplorer()}
        />
      )}

      {/* 14단계 C: 사진 합치기 (활동·증빙사진) 모달 */}
      {photoCollagePaths && photoCollagePaths.length > 0 && (
        <PhotoCollageModal
          targetPaths={photoCollagePaths}
          onClose={() => setPhotoCollagePaths(null)}
          showToast={showToast}
          onRefreshExplorer={refreshExplorer}
        />
      )}

      {/* 14단계 C: PDF 한 파일로 묶기 모달 */}
      {pdfBindingPaths && pdfBindingPaths.length > 0 && (
        <PdfBindingModal
          targetPaths={pdfBindingPaths}
          onClose={() => setPdfBindingPaths(null)}
          showToast={showToast}
          onRefreshExplorer={refreshExplorer}
        />
      )}

      {/* 14단계 C: 날짜·글자 넣기 (공사 사진 대지 등) 모달 */}
      {photoStampPaths && photoStampPaths.length > 0 && (
        <PhotoStampModal
          targetPaths={photoStampPaths}
          onClose={() => setPhotoStampPaths(null)}
          showToast={showToast}
          onRefreshExplorer={refreshExplorer}
        />
      )}

      {/* 14단계 A: HEIC 코덱 미설치 안내 모달 */}
      {heicCodecMissing && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-box" style={{ maxWidth: "440px" }}>
            <h3 className="modal-title" style={{ color: "var(--accent)" }}>HEIF 이미지 확장 설치 필요</h3>
            <p className="modal-desc" style={{ lineHeight: "1.6", marginTop: "8px" }}>
              아이폰 사진(.heic, .heif)을 열려면 Windows에 HEIF 이미지 확장이 설치되어 있어야 합니다.
              <br /><br />
              Microsoft Store에서 공식 HEIF 이미지 확장을 설치하세요.
            </p>
            <div className="modal-buttons" style={{ marginTop: "16px" }}>
              <button className="glass-button" onClick={() => setHeicCodecMissing(false)}>
                닫기
              </button>
              <button
                className="glass-button btn-primary"
                onClick={() => {
                  window.open("ms-windows-store://pdp/?ProductId=9pmmsr1c69ky", "_blank");
                }}
              >
                Microsoft Store에서 설치
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 14단계 A: 저장하지 않은 변경 확인 모달 */}
      {pendingNavigate && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-box" style={{ maxWidth: "420px" }}>
            <h3 className="modal-title">저장하지 않은 변경 사항</h3>
            <p className="modal-desc" style={{ lineHeight: "1.6", marginTop: "8px" }}>
              자르기, 보정 또는 회전/반전 등의 편집 내용이 저장되지 않았습니다.
              <br />
              다른 이미지로 이동하시겠습니까?
            </p>
            <div className="modal-buttons" style={{ flexDirection: "column", gap: "8px", marginTop: "16px" }}>
              <button
                className="glass-button btn-primary"
                style={{ width: "100%" }}
                onClick={async () => {
                  await handleSaveEditedCopy();
                  const act = pendingNavigate;
                  setPendingNavigate(null);
                  act();
                }}
              >
                사본으로 저장하고 이동 (Ctrl+S)
              </button>
              <button
                className="glass-button"
                style={{ width: "100%" }}
                onClick={() => {
                  const act = pendingNavigate;
                  setPendingNavigate(null);
                  act();
                }}
              >
                저장하지 않고 이동
              </button>
              <button
                className="glass-button"
                style={{ width: "100%", opacity: 0.8 }}
                onClick={() => setPendingNavigate(null)}
              >
                취소 (편집 계속)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
