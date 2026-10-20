import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
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
} from "lucide-react";
import "./App.css";

const APP_NAME = "PrismView";
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "jfif", "png", "gif", "webp", "avif", "bmp", "svg"];
const ARCHIVE_EXTENSIONS = ["zip", "cbz"];
const ALL_SUPPORTED_EXTENSIONS = [...IMAGE_EXTENSIONS, ...ARCHIVE_EXTENSIONS];

// 줌 배율 범위 (2% ~ 6400%)
const MIN_SCALE = 0.02;
const MAX_SCALE = 64.0;
// 화면 밖으로 완전히 사라지지 않도록 남겨둘 최소 가시 영역(px)
const MIN_VISIBLE_PX = 60;
// 필름스트립 썸네일 아이템 너비 (68px + gap 8px)
const THUMB_ITEM_WIDTH = 76;

export type SortBy = "name" | "dateModified" | "fileSize";
export type SortOrder = "asc" | "desc";
export type BgMode = "black" | "dark" | "checker";
export type ReadingDirection = "ltr" | "rtl";

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
  kind: "folder" | "archive" | "image";
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
  | { kind: "image"; src: string; fileName: string; path: string; isArchive?: boolean }
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

  // 6단계 & 7단계: 설정 및 도움말 모달 상태
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
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
  });

  // 7단계: 전체화면 여부, 상단 마우스 감지(전체화면 툴바 노출), 우클릭 컨텍스트 메뉴
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMouseAtTop, setIsMouseAtTop] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

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
        .then((res) => {
          if (id !== requestId.current) return;
          setItems(res.items);
          itemsRef.current = res.items;

          setCurrentIndex(res.currentIndex);
          currentIndexRef.current = res.currentIndex;

          setLoaded(false);
          setSecondLoaded(false);
          setMeta(null);
          setSecondMeta(null);
          setIsFit(true);
          setRotation(0);

          const currentItem = res.items[res.currentIndex] ?? {
            path,
            fileName: baseName(path),
          };

          setView({
            kind: "image",
            src: convertFileSrc(currentItem.path),
            fileName: currentItem.fileName,
            path: currentItem.path,
            isArchive: currentItem.isArchiveEntry,
          });
          setWindowTitle(currentItem.fileName, res.currentIndex, res.items.length);
          pingTopBar();
          loadDetails(currentItem.path);
        })
        .catch((err) => {
          if (id !== requestId.current) return;
          const fileName = baseName(path);
          setView({ kind: "error", fileName, message: String(err), path });
          setWindowTitle(fileName);
        });
    },
    [pingTopBar, loadDetails]
  );

  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;

  // 6단계: 설정 업데이트 헬퍼
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
      invoke("save_settings", { settings: next }).catch((err) => {
        console.error("설정 저장 실패:", err);
      });
      if (
        (partial.sortBy && partial.sortBy !== prev.sortBy) ||
        (partial.sortOrder && partial.sortOrder !== prev.sortOrder)
      ) {
        const curPath = itemsRef.current[currentIndexRef.current]?.path;
        if (curPath) {
          openPathRef.current(curPath, next.sortBy, next.sortOrder);
        }
      }
      return next;
    });
  }, []);

  // 인덱스 이동
  const navigateToIndex = useCallback(
    async (nextIdx: number) => {
      const curItems = itemsRef.current;
      if (curItems.length === 0) return;

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
      setIsFit(true);
      setRotation(0); // 새 사진 열면 회전 초기화

      // ZIP 아카이브 내부 파일인 경우 온디맨드 추출 확인
      const actualPath = await ensureArchiveEntryPath(item);

      setView({
        kind: "image",
        src: convertFileSrc(actualPath),
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
    [showToast, pingTopBar, loadDetails, filmstripWidth, ensureArchiveEntryPath]
  );

  // 양면 보기 고려한 다음/이전 이동
  const step = isDoublePage ? 2 : 1;

  const goToNext = useCallback(() => {
    navigateToIndex(currentIndexRef.current + step);
  }, [navigateToIndex, step]);

  const goToPrev = useCallback(() => {
    navigateToIndex(currentIndexRef.current - step);
  }, [navigateToIndex, step]);

  const goToFirst = useCallback(() => {
    navigateToIndex(0);
  }, [navigateToIndex]);

  const goToLast = useCallback(() => {
    navigateToIndex(itemsRef.current.length - 1);
  }, [navigateToIndex]);

  // 미리 읽기: 앞 1장, 뒤 2장 decode()
  useEffect(() => {
    const list = items;
    if (list.length === 0) return;

    const targets: number[] = [];
    if (currentIndex - 1 >= 0) targets.push(currentIndex - 1);
    if (currentIndex + 1 < list.length) targets.push(currentIndex + 1);
    if (currentIndex + 2 < list.length) targets.push(currentIndex + 2);

    for (const idx of targets) {
      const it = list[idx];
      if (it.path) {
        const url = convertFileSrc(it.path);
        if (!preloadCacheRef.current.has(url)) {
          const img = new Image();
          img.decoding = "async";
          img.src = url;
          img.decode().catch(() => {});
          preloadCacheRef.current.set(url, img);
        }
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

  // 5단계: 현재 이미지 회전 사본 저장 (Ctrl+S)
  const saveRotatedCopy = useCallback(async () => {
    if (view.kind !== "image" || !view.path || view.isArchive) {
      showToast("압축 파일 내 이미지는 사본 저장을 지원하지 않습니다.");
      return;
    }
    if (rotation === 0) {
      showToast("회전되지 않은 원본 상태입니다.");
      return;
    }
    try {
      const savedPath = await invoke<string>("save_rotated_image", {
        sourcePath: view.path,
        rotation,
      });
      showToast(`사본 저장 완료: ${baseName(savedPath)}`);
    } catch (err) {
      showToast(`사본 저장 실패: ${String(err)}`);
    }
  }, [view, rotation, showToast]);

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

  // 탐색기에서 선택된 항목을 뷰어로 열기
  const openSelectedInViewer = useCallback(() => {
    if (!explorerResult) return;
    const firstSelected = explorerResult.items.find((it) => selectedPaths.has(it.path));
    if (!firstSelected) return;

    if (firstSelected.kind === "image") {
      setAppMode("viewer");
      openPath(firstSelected.path);
    } else {
      navigateToExplorerFolder(firstSelected.path);
    }
  }, [explorerResult, selectedPaths, openPath, navigateToExplorerFolder]);

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
        const idx = explorerResult.items.findIndex(
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
  }, [view, currentExplorerPath, explorerResult, thumbnailSize, navigateToExplorerFolder]);

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
        const rangePaths = explorerResult.items.slice(start, end + 1).map((i) => i.path);
        setSelectedPaths(new Set(rangePaths));
      } else {
        setSelectedPaths(new Set([item.path]));
        setLastClickedIndex(index);
      }

      if (item.kind === "image") {
        loadDetails(item.path);
      }
    },
    [lastClickedIndex, explorerResult, loadDetails]
  );

  // 탐색기 그리드 더블클릭
  const handleExplorerItemDoubleClick = useCallback(
    (item: ExplorerItem) => {
      if (item.kind === "image") {
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
      if (!explorerResult || explorerResult.items.length === 0) return;
      const el = gridContainerRef.current;
      const itemWidth = thumbnailSize + 16;
      const itemHeight = thumbnailSize + 52;
      const cols = el ? Math.max(1, Math.floor(el.clientWidth / itemWidth)) : 4;
      const total = explorerResult.items.length;

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
      const targetItem = explorerResult.items[nextIdx];
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
    [explorerResult, focusedIndex, thumbnailSize, loadDetails]
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
  }, [view, rotation, showToast]);

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

  // 7단계: 컨텍스트 메뉴 외부 클릭 시 닫기
  useEffect(() => {
    if (!contextMenu) return;
    const onMouseDownWindow = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".context-menu")) {
        setContextMenu(null);
      }
    };
    window.addEventListener("mousedown", onMouseDownWindow);
    return () => window.removeEventListener("mousedown", onMouseDownWindow);
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

  // 7단계 & 8단계 (구조 정리): 모든 명령을 단일 목록(Command Registry)에 정의
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
      canSaveCopy: view.kind === "image" && !view.isArchive && rotation !== 0,
      canGoUp: Boolean(explorerResult?.parentPath),
      hasSelectedItems: selectedPaths.size > 0,
    }),
    [
      appMode,
      view,
      items.length,
      isDoublePage,
      showFilmstrip,
      showInfoPanel,
      isFullscreen,
      rotation,
      explorerResult?.parentPath,
      selectedPaths.size,
    ]
  );

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
          saveRotatedCopy,
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
      appMode,
      view,
      selectedPaths.size,
      copyImageToClipboard,
      copyPathToClipboard,
      handleShowInFolder,
      cycleBgMode,
      loadDetails,
      toggleFullscreen,
      goToParentFolder,
      refreshExplorer,
      openSelectedInViewer,
      commandState,
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

  // 키보드 단축키 (KeyboardEvent.code 기준 - 모두 명령 목록 commandsRef를 사용)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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

      if (showSettingsModal) {
        if (e.code === "Escape") {
          e.preventDefault();
          setShowSettingsModal(false);
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

      // 우클릭 컨텍스트 메뉴가 열려있을 때 Escape로 닫기
      if (contextMenu !== null) {
        if (e.code === "Escape") {
          e.preventDefault();
          setContextMenu(null);
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
    showHelpModal,
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

  // 마우스 휠 줌
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (view.kind !== "image" || !metaRef.current) return;
    e.preventDefault();

    const el = viewerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    let factor: number;
    if (e.ctrlKey) {
      factor = Math.exp(-e.deltaY * 0.015);
    } else {
      factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    }

    zoomAtPoint(cx, cy, factor);
  }, [view.kind, zoomAtPoint]);

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
      const t = getFitTransform(el.clientWidth, el.clientHeight, nw, nh);
      setTransform(t);
      setIsFit(true);
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
  const totalExplorerItems = explorerResult?.items.length ?? 0;
  const totalExplorerRows = Math.ceil(totalExplorerItems / explorerCols);
  const startExplorerRow = Math.max(0, Math.floor(gridScrollTop / explorerItemHeight) - 2);
  const endExplorerRow = Math.min(
    totalExplorerRows - 1,
    Math.ceil((gridScrollTop + gridDimensions.height) / explorerItemHeight) + 2
  );
  const startExplorerIdx = startExplorerRow * explorerCols;
  const endExplorerIdx = Math.min(totalExplorerItems - 1, (endExplorerRow + 1) * explorerCols - 1);
  const visibleExplorerItems =
    startExplorerIdx <= endExplorerIdx && explorerResult
      ? explorerResult.items.slice(startExplorerIdx, endExplorerIdx + 1)
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
        it.kind === "image" &&
        !explorerThumbnails[it.path] &&
        !loadingThumbsRef.current.has(it.path)
      ) {
        loadingThumbsRef.current.add(it.path);
        invoke<string>("get_thumbnail", { path: it.path })
          .then((thumbPath) => {
            setExplorerThumbnails((prev) => ({ ...prev, [it.path]: convertFileSrc(thumbPath) }));
          })
          .catch(() => {
            setExplorerThumbnails((prev) => ({ ...prev, [it.path]: convertFileSrc(it.path) }));
          })
          .finally(() => {
            loadingThumbsRef.current.delete(it.path);
          });
      }
    }
  }, [appMode, visibleExplorerItems, explorerThumbnails]);

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
              <div className="explorer-toolbar">
                {TOOLBAR_GROUPS_EXPLORER.map((group, groupIdx) => (
                  <div key={groupIdx} className="toolbar-group">
                    {group.map((cmdId) => {
                      const cmd = commandMap.get(cmdId);
                      if (!cmd) return null;
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
                        </button>
                      );
                    })}
                    {groupIdx < TOOLBAR_GROUPS_EXPLORER.length - 1 && <div className="toolbar-divider" />}
                  </div>
                ))}
              </div>
            )}
          </header>

          {/* 탐색기 메인 본문: 왼쪽 트리 + 리사이저 + 중앙 그리드 + 오른쪽 정보패널 */}
          <div className="explorer-main">
            {/* 좌측 폴더 트리 패널 */}
            <aside className="explorer-tree-panel" style={{ width: `${folderTreeWidth}px` }}>
              <div className="explorer-tree-scroll">
                <div className="tree-section-title">빠른 바로가기</div>
                {systemLocations
                  .filter((loc) => loc.kind === "quickAccess")
                  .map((loc) => (
                    <div
                      key={loc.path}
                      className={`tree-item${currentExplorerPath.toLowerCase() === loc.path.toLowerCase() ? " is-active" : ""}`}
                      onClick={() => navigateToExplorerFolder(loc.path)}
                    >
                      <Folder className="tree-icon" size={16} />
                      <span className="tree-label">{loc.name}</span>
                    </div>
                  ))}

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
                {explorerResult && explorerResult.items.length > 0 ? (
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
                            onClick={(e) => handleExplorerItemClick(e, item, absIdx)}
                            onDoubleClick={() => handleExplorerItemDoubleClick(item)}
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
                                    if (e.currentTarget.src !== convertFileSrc(item.path)) {
                                      e.currentTarget.src = convertFileSrc(item.path);
                                    }
                                  }}
                                />
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
                        </button>
                      );
                    })}
                    {groupIdx < TOOLBAR_GROUPS_VIEWER.length - 1 && <div className="toolbar-divider" />}
                  </div>
                ))}
              </div>
            </nav>
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
                {rotation !== 0 && ` (${rotation}°)`}
              </span>
            </aside>
          )}

          {/* 이미지 렌더링 (단면 또는 양면) */}
          {view.kind === "image" && !isDoublePage && (
            <img
              key={view.src}
              className={`viewer-image${loaded ? " is-loaded" : ""}`}
              src={view.src}
              alt={view.fileName}
              draggable={false}
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
                      transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale}) rotate(${rotation}deg)`,
                    }
                  : undefined
              }
            />
          )}

          {/* 5단계: 양면 보기 렌더링 */}
          {view.kind === "image" && isDoublePage && (
            <div
              className="double-view-container"
              style={{
                transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale}) rotate(${rotation}deg)`,
                flexDirection: readingDirection === "rtl" ? "row-reverse" : "row",
              }}
            >
              <div className="double-view-page" style={{ width: `${baseWidth}px`, height: `${baseHeight}px` }}>
                <img
                  key={view.src}
                  className={`double-view-img${loaded ? " is-loaded" : ""}`}
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
                    className={`double-view-img${secondLoaded ? " is-loaded" : ""}`}
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

          {/* 7단계: 하단 상태바 */}
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
        </main>
      )}

      {/* 5단계 & 8단계: 파일 휴지통 삭제 확인 모달 */}
      {showDeleteModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-box">
            <h3 className="modal-title">파일 삭제</h3>
            <p className="modal-desc">
              {appMode === "viewer" ? (
                <>
                  다음 파일을 휴지통으로 이동하시겠습니까?
                  <br />
                  <strong style={{ display: "inline-block", marginTop: "6px" }}>
                    {view.kind === "image" && view.fileName}
                  </strong>
                </>
              ) : (
                <>
                  선택한 <strong>{selectedPaths.size}개 항목</strong>을 휴지통으로 이동하시겠습니까?
                </>
              )}
            </p>
            <div className="modal-buttons">
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

      {/* 6단계: 환경 설정 모달 (Ctrl+,) */}
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

            <div className="settings-body">
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
                <label className="setting-label">이미지 목록 정렬</label>
                <div className="setting-options-row">
                  <div className="setting-options">
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
                      className={`setting-chip${settings.sortBy === "fileSize" ? " is-active" : ""}`}
                      onClick={() => updateSettings({ sortBy: "fileSize" })}
                    >
                      파일 크기순
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
            </div>

            <div className="modal-buttons">
              <button className="glass-button btn-primary" onClick={() => setShowSettingsModal(false)}>
                확인 (Esc)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6단계 & 7단계: 도움말 (단축키 안내) 모달 */}
      {showHelpModal && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowHelpModal(false);
          }}
        >
          <div className="modal-box help-modal-box">
            <div className="modal-header">
              <h3 className="modal-title">단축키 안내</h3>
              <button
                className="modal-close-btn"
                onClick={() => setShowHelpModal(false)}
                title="닫기 (Esc)"
              >
                ✕
              </button>
            </div>

            <div className="help-content-scroll">
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
            </div>

            <div className="modal-buttons">
              <button className="glass-button btn-primary" onClick={() => setShowHelpModal(false)}>
                닫기 (Esc)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7단계: 우클릭 컨텍스트 메뉴 */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{
            left: `${Math.min(contextMenu.x, window.innerWidth - 220)}px`,
            top: `${Math.min(contextMenu.y, window.innerHeight - 360)}px`,
          }}
          role="menu"
        >
          {CONTEXT_MENU_GROUPS.map((group, groupIdx) => (
            <div key={groupIdx} className="context-menu-group">
              {group.map((cmdId) => {
                const cmd = commandMap.get(cmdId);
                if (!cmd) return null;
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
    </div>
  );
}

export default App;
