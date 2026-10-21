import type React from "react";
import {
  FolderOpen,
  ChevronLeft,
  ChevronRight,
  SkipBack,
  SkipForward,
  Maximize2,
  Scan,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  RotateCw,
  Save,
  Trash2,
  Copy,
  FileText,
  ExternalLink,
  BookOpen,
  SunMedium,
  GalleryHorizontal,
  Info,
  Tv,
  Settings,
  HelpCircle,
  ArrowUp,
  RefreshCw,
  Eye,
  FlipHorizontal,
  FlipVertical,
  SaveAll,
  Scaling,
  Printer,
  Play,
  Grid,
  ArrowUpDown,
  PenLine,
  FolderInput,
  FolderOutput,
  FolderPlus,
  Undo2,
  Palette,
  Monitor,
  ClipboardPaste,
  UserCheck,
  Layers,
  Stamp,
  LayoutGrid,
  Crop,
  SlidersHorizontal,
} from "lucide-react";

export type CommandId =
  | "open"
  | "prev"
  | "next"
  | "first"
  | "last"
  | "fit"
  | "actualSize"
  | "zoomOut"
  | "zoomIn"
  | "rotateCcw"
  | "rotateCw"
  | "flipH"
  | "flipV"
  | "saveCopy"
  | "saveAs"
  | "idPhoto"
  | "resizeImage"
  | "printImage"
  | "delete"
  | "copyImage"
  | "copyPath"
  | "showInFolder"
  | "toggleDoublePage"
  | "cycleBg"
  | "toggleFilmstrip"
  | "toggleInfo"
  | "toggleFullscreen"
  | "openSettings"
  | "openHelp"
  | "explorerUp"
  | "explorerRefresh"
  | "openViewer"
  | "toggleSlideshow"
  | "toggleInterpolation"
  | "sortMenu"
  // 10단계 새 명령
  | "rename"
  | "copyToFolder"
  | "moveToFolder"
  | "newFolder"
  | "undo"
  | "openExternalEditor"
  | "setWallpaper"
  | "pasteClipboard"
  | "copyFiles"
  // 14단계 A 자르기 및 보정 명령
  | "crop"
  | "adjust"
  // 14단계 B 일괄 작업 명령
  | "batchConvert"
  | "batchRename"
  | "batchRotate"
  // 14단계 C 학교 행정실 사진 작업 명령
  | "mosaic"
  | "photoCollage"
  | "pdfBinding"
  | "photoStamp";

export type ShortcutTrigger = {
  code: string; // KeyboardEvent.code 기준 (e.g. "KeyO", "ArrowRight")
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type CommandCategory =
  | "탐색 및 이동"
  | "화면 확대 및 뷰포트"
  | "보기 모드 및 편집"
  | "파일 및 부가 기능";

export type CommandScope = "all" | "viewer" | "explorer";

export type AppCommand = {
  id: CommandId;
  label: string;
  icon: React.ReactNode;
  shortcutDisplay: string;
  triggers: ShortcutTrigger[];
  action: () => void | Promise<void>;
  isEnabled: boolean;
  isActive?: boolean;
  category: CommandCategory;
  scope?: CommandScope;
};

export type CommandActions = {
  openDialog: () => void | Promise<void>;
  goToPrev: () => void;
  goToNext: () => void;
  goToFirst: () => void;
  goToLast: () => void;
  fitToWindow: () => void;
  setActualSize: () => void;
  zoomOut: () => void;
  zoomIn: () => void;
  rotateCcw: () => void;
  rotateCw: () => void;
  saveRotatedCopy: () => void | Promise<void>;
  requestDelete: () => void;
  copyImageToClipboard: () => void | Promise<void>;
  copyPathToClipboard: () => void;
  showInFolder: () => void;
  toggleDoublePage: () => void;
  cycleBgMode: () => void;
  toggleFilmstrip: () => void;
  toggleInfoPanel: () => void;
  toggleFullscreen: () => void | Promise<void>;
  openSettingsModal: () => void;
  openHelpModal: () => void;
  // 8단계 탐색기 모드 전용 액션
  explorerUp?: () => void;
  explorerRefresh?: () => void;
  openViewerFromExplorer?: () => void;
  // 9단계 새 기능 액션
  flipH?: () => void;
  flipV?: () => void;
  saveAs?: () => void;
  createIdPhoto?: () => void;
  resizeImage?: () => void;
  printImage?: () => void;
  toggleSlideshow?: () => void;
  toggleInterpolation?: () => void;
  toggleSortMenu?: () => void;
  // 10단계 새 기능 액션
  rename?: () => void;
  copyToFolder?: () => void;
  moveToFolder?: () => void;
  newFolder?: () => void;
  undo?: () => void;
  openExternalEditor?: () => void;
  setWallpaper?: () => void;
  pasteClipboard?: () => void;
  copyFiles?: () => void;
  // 14단계 A 자르기 및 보정 액션
  startCrop?: () => void;
  openAdjust?: () => void;
  // 14단계 B 일괄 작업 액션
  openBatchConvert?: () => void;
  openBatchRename?: () => void;
  openBatchRotate?: () => void;
  // 14단계 C 학교 행정실 사진 작업 액션
  openMosaicEditor?: () => void;
  openPhotoCollage?: () => void;
  openPdfBinding?: () => void;
  openPhotoStamp?: () => void;
};

export type CommandState = {
  appMode: "viewer" | "explorer";
  hasImage: boolean;
  hasItems: boolean;
  isArchive: boolean;
  isDoublePage: boolean;
  showFilmstrip: boolean;
  showInfoPanel: boolean;
  isFullscreen: boolean;
  canSaveCopy: boolean;
  canGoUp?: boolean;
  hasSelectedItems?: boolean;
  // 9단계 새 상태
  isSlideshowActive?: boolean;
  isPixelated?: boolean;
  isFlippedH?: boolean;
  isFlippedV?: boolean;
  // 10단계 새 상태
  canUndo?: boolean;
  // 14단계 A 상태
  isCropping?: boolean;
};

/**
 * 모든 단축키, 상단 툴바, 우클릭 메뉴, 도움말 표에서 단일 진실 공급원(Single Source of Truth)으로 사용되는 명령 목록을 생성합니다.
 */
export function buildCommands(actions: CommandActions, state: CommandState): AppCommand[] {
  const iconSize = 21;

  return [
    {
      id: "open",
      label: "열기",
      icon: <FolderOpen size={iconSize} />,
      shortcutDisplay: "Ctrl+O",
      triggers: [{ code: "KeyO", ctrl: true }],
      action: actions.openDialog,
      isEnabled: true,
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "prev",
      label: "이전",
      icon: <ChevronLeft size={iconSize} />,
      shortcutDisplay: "←",
      triggers: [
        { code: "ArrowLeft" },
        { code: "PageUp" },
        { code: "Backspace" },
      ],
      action: actions.goToPrev,
      isEnabled: state.appMode === "viewer" && state.hasItems,
      category: "탐색 및 이동",
      scope: "viewer",
    },
    {
      id: "next",
      label: "다음",
      icon: <ChevronRight size={iconSize} />,
      shortcutDisplay: "→",
      triggers: [
        { code: "ArrowRight" },
        { code: "PageDown" },
        { code: "Space" },
      ],
      action: actions.goToNext,
      isEnabled: state.appMode === "viewer" && state.hasItems,
      category: "탐색 및 이동",
      scope: "viewer",
    },
    {
      id: "first",
      label: "첫 이미지",
      icon: <SkipBack size={iconSize} />,
      shortcutDisplay: "Home",
      triggers: [{ code: "Home" }],
      action: actions.goToFirst,
      isEnabled: state.appMode === "viewer" && state.hasItems,
      category: "탐색 및 이동",
      scope: "viewer",
    },
    {
      id: "last",
      label: "마지막 이미지",
      icon: <SkipForward size={iconSize} />,
      shortcutDisplay: "End",
      triggers: [{ code: "End" }],
      action: actions.goToLast,
      isEnabled: state.appMode === "viewer" && state.hasItems,
      category: "탐색 및 이동",
      scope: "viewer",
    },
    {
      id: "fit",
      label: "화면 맞춤",
      icon: <Maximize2 size={iconSize} />,
      shortcutDisplay: "0",
      triggers: [{ code: "Digit0" }, { code: "Numpad0" }],
      action: actions.fitToWindow,
      isEnabled: state.appMode === "viewer" && state.hasImage,
      category: "화면 확대 및 뷰포트",
      scope: "viewer",
    },
    {
      id: "actualSize",
      label: "100% 원본",
      icon: <Scan size={iconSize} />,
      shortcutDisplay: "1",
      triggers: [{ code: "Digit1" }, { code: "Numpad1" }],
      action: actions.setActualSize,
      isEnabled: state.appMode === "viewer" && state.hasImage,
      category: "화면 확대 및 뷰포트",
      scope: "viewer",
    },
    {
      id: "zoomOut",
      label: "축소",
      icon: <ZoomOut size={iconSize} />,
      shortcutDisplay: "-",
      triggers: [{ code: "Minus" }, { code: "NumpadSubtract" }],
      action: actions.zoomOut,
      isEnabled: state.appMode === "viewer" && state.hasImage,
      category: "화면 확대 및 뷰포트",
      scope: "viewer",
    },
    {
      id: "zoomIn",
      label: "확대",
      icon: <ZoomIn size={iconSize} />,
      shortcutDisplay: "+",
      triggers: [{ code: "Equal" }, { code: "NumpadAdd" }],
      action: actions.zoomIn,
      isEnabled: state.appMode === "viewer" && state.hasImage,
      category: "화면 확대 및 뷰포트",
      scope: "viewer",
    },
    {
      id: "rotateCcw",
      label: "왼쪽 회전",
      icon: <RotateCcw size={iconSize} />,
      shortcutDisplay: "Shift+R",
      triggers: [{ code: "KeyR", shift: true }],
      action: actions.rotateCcw,
      isEnabled: state.appMode === "viewer" && state.hasImage,
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "rotateCw",
      label: "오른쪽 회전",
      icon: <RotateCw size={iconSize} />,
      shortcutDisplay: "R",
      triggers: [{ code: "KeyR" }],
      action: actions.rotateCw,
      isEnabled: state.appMode === "viewer" && state.hasImage,
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "saveCopy",
      label: "사본 저장",
      icon: <Save size={iconSize} />,
      shortcutDisplay: "Ctrl+S",
      triggers: [{ code: "KeyS", ctrl: true }],
      action: actions.saveRotatedCopy,
      isEnabled: state.appMode === "viewer" && state.canSaveCopy,
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "delete",
      label: "삭제",
      icon: <Trash2 size={iconSize} />,
      shortcutDisplay: "Del",
      triggers: [{ code: "Delete" }, { code: "Delete", shift: true }],
      action: actions.requestDelete,
      isEnabled:
        state.appMode === "viewer"
          ? state.hasImage && !state.isArchive
          : Boolean(state.hasSelectedItems),
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "copyImage",
      label: "이미지 복사",
      icon: <Copy size={iconSize} />,
      shortcutDisplay: "Ctrl+C",
      triggers: [{ code: "KeyC", ctrl: true }],
      action: actions.copyImageToClipboard,
      isEnabled: state.hasImage,
      category: "파일 및 부가 기능",
      scope: "viewer",
    },
    {
      id: "copyPath",
      label: "경로 복사",
      icon: <FileText size={iconSize} />,
      shortcutDisplay: "Ctrl+Shift+C",
      triggers: [{ code: "KeyC", ctrl: true, shift: true }],
      action: actions.copyPathToClipboard,
      isEnabled: state.hasImage || Boolean(state.hasSelectedItems),
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "showInFolder",
      label: "탐색기에서 보기",
      icon: <ExternalLink size={iconSize} />,
      shortcutDisplay: "",
      triggers: [],
      action: actions.showInFolder,
      isEnabled: state.hasImage && !state.isArchive,
      category: "파일 및 부가 기능",
      scope: "viewer",
    },
    {
      id: "toggleDoublePage",
      label: "양면 보기",
      icon: <BookOpen size={iconSize} />,
      shortcutDisplay: "D",
      triggers: [{ code: "KeyD" }],
      action: actions.toggleDoublePage,
      isEnabled: state.appMode === "viewer" && state.hasItems,
      isActive: state.isDoublePage,
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "cycleBg",
      label: "배경색",
      icon: <SunMedium size={iconSize} />,
      shortcutDisplay: "B",
      triggers: [{ code: "KeyB" }],
      action: actions.cycleBgMode,
      isEnabled: true,
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "toggleFilmstrip",
      label: "필름스트립",
      icon: <GalleryHorizontal size={iconSize} />,
      shortcutDisplay: "T",
      triggers: [{ code: "KeyT" }],
      action: actions.toggleFilmstrip,
      isEnabled: state.appMode === "viewer" && state.hasItems,
      isActive: state.showFilmstrip,
      category: "파일 및 부가 기능",
      scope: "viewer",
    },
    {
      id: "toggleInfo",
      label: "정보",
      icon: <Info size={iconSize} />,
      shortcutDisplay: "I",
      triggers: [{ code: "KeyI" }],
      action: actions.toggleInfoPanel,
      isEnabled: state.appMode === "viewer" ? state.hasImage : true,
      isActive: state.showInfoPanel,
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "toggleFullscreen",
      label: "전체화면",
      icon: <Tv size={iconSize} />,
      shortcutDisplay: "F / F11",
      triggers: [
        { code: "KeyF" },
        { code: "Enter" },
        { code: "F11" },
      ],
      action: actions.toggleFullscreen,
      isEnabled: true,
      isActive: state.isFullscreen,
      category: "화면 확대 및 뷰포트",
      scope: "all",
    },
    {
      id: "openSettings",
      label: "설정",
      icon: <Settings size={iconSize} />,
      shortcutDisplay: "Ctrl+,",
      triggers: [{ code: "Comma", ctrl: true }],
      action: actions.openSettingsModal,
      isEnabled: true,
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "openHelp",
      label: "도움말",
      icon: <HelpCircle size={iconSize} />,
      shortcutDisplay: "H / F1",
      triggers: [{ code: "KeyH" }, { code: "F1" }],
      action: actions.openHelpModal,
      isEnabled: true,
      category: "파일 및 부가 기능",
      scope: "all",
    },

    // 8단계 탐색기 모드 전용 명령
    {
      id: "explorerUp",
      label: "상위 폴더",
      icon: <ArrowUp size={iconSize} />,
      shortcutDisplay: "Backspace / Alt+←",
      triggers: [
        { code: "Backspace" },
        { code: "ArrowLeft", alt: true },
      ],
      action: () => actions.explorerUp?.(),
      isEnabled: state.appMode === "explorer" && Boolean(state.canGoUp),
      category: "탐색 및 이동",
      scope: "explorer",
    },
    {
      id: "explorerRefresh",
      label: "새로 고침",
      icon: <RefreshCw size={iconSize} />,
      shortcutDisplay: "F5",
      triggers: [{ code: "F5" }],
      action: () => actions.explorerRefresh?.(),
      isEnabled: state.appMode === "explorer",
      category: "탐색 및 이동",
      scope: "explorer",
    },
    {
      id: "openViewer",
      label: "뷰어로 보기",
      icon: <Eye size={iconSize} />,
      shortcutDisplay: "Enter",
      triggers: [{ code: "Enter" }],
      action: () => actions.openViewerFromExplorer?.(),
      isEnabled: state.appMode === "explorer" && Boolean(state.hasSelectedItems),
      category: "탐색 및 이동",
      scope: "explorer",
    },

    // 9단계 새 명령들
    {
      id: "flipH",
      label: "좌우 반전",
      icon: <FlipHorizontal size={iconSize} />,
      shortcutDisplay: "M",
      triggers: [{ code: "KeyM" }],
      action: () => actions.flipH?.(),
      isEnabled: state.appMode === "viewer" && state.hasImage,
      isActive: Boolean(state.isFlippedH),
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "flipV",
      label: "상하 반전",
      icon: <FlipVertical size={iconSize} />,
      shortcutDisplay: "Shift+M",
      triggers: [{ code: "KeyM", shift: true }],
      action: () => actions.flipV?.(),
      isEnabled: state.appMode === "viewer" && state.hasImage,
      isActive: Boolean(state.isFlippedV),
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "saveAs",
      label: "다른 이름",
      icon: <SaveAll size={iconSize} />,
      shortcutDisplay: "Ctrl+Shift+S",
      triggers: [{ code: "KeyS", ctrl: true, shift: true }],
      action: () => actions.saveAs?.(),
      isEnabled: state.appMode === "viewer" && state.hasImage && !state.isArchive,
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "idPhoto",
      label: "증명사진",
      icon: <UserCheck size={iconSize} />,
      shortcutDisplay: "Shift+P",
      triggers: [{ code: "KeyP", shift: true }],
      action: () => actions.createIdPhoto?.(),
      isEnabled:
        state.appMode === "viewer"
          ? state.hasImage && !state.isArchive
          : Boolean(state.hasSelectedItems),
      category: "보기 모드 및 편집",
      scope: "all",
    },
    {
      id: "resizeImage",
      label: "크기 조정",
      icon: <Scaling size={iconSize} />,
      shortcutDisplay: "Ctrl+R",
      triggers: [{ code: "KeyR", ctrl: true }],
      action: () => actions.resizeImage?.(),
      isEnabled: state.appMode === "viewer" && state.hasImage && !state.isArchive,
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "printImage",
      label: "인쇄",
      icon: <Printer size={iconSize} />,
      shortcutDisplay: "Ctrl+P",
      triggers: [{ code: "KeyP", ctrl: true }],
      action: () => actions.printImage?.(),
      isEnabled: state.appMode === "viewer" && state.hasImage,
      category: "파일 및 부가 기능",
      scope: "viewer",
    },
    {
      id: "toggleSlideshow",
      label: "슬라이드쇼",
      icon: <Play size={iconSize} />,
      shortcutDisplay: "S",
      triggers: [{ code: "KeyS" }],
      action: () => actions.toggleSlideshow?.(),
      isEnabled: state.appMode === "viewer" && state.hasItems,
      isActive: Boolean(state.isSlideshowActive),
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "toggleInterpolation",
      label: "확대 보간 (부드럽게/픽셀)",
      icon: <Grid size={iconSize} />,
      shortcutDisplay: "",
      triggers: [],
      action: () => actions.toggleInterpolation?.(),
      isEnabled: state.appMode === "viewer" && state.hasImage,
      isActive: Boolean(state.isPixelated),
      category: "화면 확대 및 뷰포트",
      scope: "viewer",
    },
    {
      id: "sortMenu",
      label: "정렬",
      icon: <ArrowUpDown size={iconSize} />,
      shortcutDisplay: "",
      triggers: [],
      action: () => actions.toggleSortMenu?.(),
      isEnabled: true,
      category: "탐색 및 이동",
      scope: "all",
    },

    // 10단계 새 명령들
    {
      id: "rename",
      label: "이름 바꾸기",
      icon: <PenLine size={iconSize} />,
      shortcutDisplay: "F2",
      triggers: [{ code: "F2" }],
      action: () => actions.rename?.(),
      isEnabled:
        state.appMode === "viewer"
          ? state.hasImage && !state.isArchive
          : Boolean(state.hasSelectedItems),
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "copyToFolder",
      label: "폴더로 복사",
      icon: <FolderInput size={iconSize} />,
      shortcutDisplay: "F7",
      triggers: [{ code: "F7" }],
      action: () => actions.copyToFolder?.(),
      isEnabled:
        state.appMode === "viewer"
          ? state.hasImage
          : Boolean(state.hasSelectedItems),
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "moveToFolder",
      label: "폴더로 이동",
      icon: <FolderOutput size={iconSize} />,
      shortcutDisplay: "F8",
      triggers: [{ code: "F8" }],
      action: () => actions.moveToFolder?.(),
      isEnabled:
        state.appMode === "viewer"
          ? state.hasImage && !state.isArchive
          : Boolean(state.hasSelectedItems),
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "newFolder",
      label: "새 폴더",
      icon: <FolderPlus size={iconSize} />,
      shortcutDisplay: "Ctrl+Shift+N",
      triggers: [{ code: "KeyN", ctrl: true, shift: true }],
      action: () => actions.newFolder?.(),
      isEnabled: state.appMode === "explorer",
      category: "파일 및 부가 기능",
      scope: "explorer",
    },
    {
      id: "undo",
      label: "실행 취소",
      icon: <Undo2 size={iconSize} />,
      shortcutDisplay: "Ctrl+Z",
      triggers: [{ code: "KeyZ", ctrl: true }],
      action: () => actions.undo?.(),
      isEnabled: Boolean(state.canUndo ?? true),
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "openExternalEditor",
      label: "외부 편집기로 열기",
      icon: <Palette size={iconSize} />,
      shortcutDisplay: "Ctrl+E",
      triggers: [{ code: "KeyE", ctrl: true }],
      action: () => actions.openExternalEditor?.(),
      isEnabled: state.hasImage && !state.isArchive,
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "setWallpaper",
      label: "바탕화면 배경으로 설정",
      icon: <Monitor size={iconSize} />,
      shortcutDisplay: "",
      triggers: [],
      action: () => actions.setWallpaper?.(),
      isEnabled: state.hasImage,
      category: "파일 및 부가 기능",
      scope: "viewer",
    },
    {
      id: "copyFiles",
      label: "파일 복사",
      icon: <Copy size={iconSize} />,
      shortcutDisplay: "Ctrl+C",
      triggers: [{ code: "KeyC", ctrl: true }],
      action: () => actions.copyFiles?.(),
      isEnabled: state.appMode === "explorer" && Boolean(state.hasSelectedItems),
      category: "파일 및 부가 기능",
      scope: "explorer",
    },
    {
      id: "pasteClipboard",
      label: state.appMode === "explorer" ? "붙여넣기" : "클립보드 이미지 열기",
      icon: <ClipboardPaste size={iconSize} />,
      shortcutDisplay: "Ctrl+V",
      triggers: [{ code: "KeyV", ctrl: true }],
      action: () => actions.pasteClipboard?.(),
      isEnabled: true,
      category: "파일 및 부가 기능",
      scope: "all",
    },
    // 14단계 B: 일괄 작업 명령들
    {
      id: "batchConvert",
      label: "일괄 크기 조정·변환",
      icon: <Layers size={iconSize} />,
      shortcutDisplay: "Ctrl+Shift+B",
      triggers: [{ code: "KeyB", ctrl: true, shift: true }],
      action: () => actions.openBatchConvert?.(),
      isEnabled:
        state.appMode === "explorer"
          ? Boolean(state.hasSelectedItems)
          : state.hasImage && !state.isArchive,
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "batchRename",
      label: "일괄 이름 바꾸기",
      icon: <PenLine size={iconSize} />,
      shortcutDisplay: "Ctrl+F2",
      triggers: [{ code: "F2", ctrl: true }],
      action: () => actions.openBatchRename?.(),
      isEnabled:
        state.appMode === "explorer"
          ? Boolean(state.hasSelectedItems)
          : state.hasImage && !state.isArchive,
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "batchRotate",
      label: "일괄 회전",
      icon: <RotateCw size={iconSize} />,
      shortcutDisplay: "Ctrl+Shift+R",
      triggers: [{ code: "KeyR", ctrl: true, shift: true }],
      action: () => actions.openBatchRotate?.(),
      isEnabled:
        state.appMode === "explorer"
          ? Boolean(state.hasSelectedItems)
          : state.hasImage && !state.isArchive,
      category: "파일 및 부가 기능",
      scope: "all",
    },
    {
      id: "mosaic",
      label: "모자이크·흐림",
      icon: <Eye size={iconSize} />,
      shortcutDisplay: "Ctrl+M",
      triggers: [{ code: "KeyM", ctrl: true }],
      action: () => actions.openMosaicEditor?.(),
      isEnabled:
        (state.appMode === "explorer" ? Boolean(state.hasSelectedItems) : state.hasImage) &&
        !state.isArchive,
      category: "보기 모드 및 편집",
      scope: "all",
    },
    {
      id: "photoCollage",
      label: "사진 합치기",
      icon: <LayoutGrid size={iconSize} />,
      shortcutDisplay: "Ctrl+Alt+C",
      triggers: [{ code: "KeyC", ctrl: true, alt: true }],
      action: () => actions.openPhotoCollage?.(),
      isEnabled: state.appMode === "explorer" && Boolean(state.hasSelectedItems),
      category: "파일 및 부가 기능",
      scope: "explorer",
    },
    {
      id: "pdfBinding",
      label: "PDF 묶기",
      icon: <FileText size={iconSize} />,
      shortcutDisplay: "Ctrl+Alt+P",
      triggers: [{ code: "KeyP", ctrl: true, alt: true }],
      action: () => actions.openPdfBinding?.(),
      isEnabled: state.appMode === "explorer" && Boolean(state.hasSelectedItems),
      category: "파일 및 부가 기능",
      scope: "explorer",
    },
    {
      id: "photoStamp",
      label: "날짜·글자",
      icon: <Stamp size={iconSize} />,
      shortcutDisplay: "Ctrl+Alt+T",
      triggers: [{ code: "KeyT", ctrl: true, alt: true }],
      action: () => actions.openPhotoStamp?.(),
      isEnabled:
        (state.appMode === "explorer" ? Boolean(state.hasSelectedItems) : state.hasImage) &&
        !state.isArchive,
      category: "보기 모드 및 편집",
      scope: "all",
    },
    {
      id: "crop",
      label: "자르기",
      icon: <Crop size={iconSize} />,
      shortcutDisplay: "Shift+X",
      triggers: [{ code: "KeyX", shift: true }],
      action: () => actions.startCrop?.(),
      isEnabled: state.appMode === "viewer" && state.hasImage && !state.isArchive,
      isActive: Boolean(state.isCropping),
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
    {
      id: "adjust",
      label: "사진 보정",
      icon: <SlidersHorizontal size={iconSize} />,
      shortcutDisplay: "Shift+E",
      triggers: [{ code: "KeyE", shift: true }],
      action: () => actions.openAdjust?.(),
      isEnabled: state.appMode === "viewer" && state.hasImage && !state.isArchive,
      category: "보기 모드 및 편집",
      scope: "viewer",
    },
  ];
}

/** 뷰어 모드 상단 툴바 버튼 그룹 */
export const TOOLBAR_GROUPS_VIEWER: CommandId[][] = [
  ["open", "pasteClipboard"],
  ["prev", "next"],
  ["fit", "actualSize", "zoomOut", "zoomIn", "toggleInterpolation"],
  ["rotateCcw", "rotateCw", "flipH", "flipV"],
  ["saveCopy", "saveAs", "crop", "adjust", "mosaic", "photoStamp", "idPhoto", "resizeImage", "printImage", "rename", "delete", "undo"],
  ["toggleSlideshow", "toggleDoublePage", "toggleFilmstrip", "toggleInfo", "sortMenu"],
  ["toggleFullscreen", "openSettings"],
];

/** 탐색기 모드 상단 툴바 버튼 그룹 */
export const TOOLBAR_GROUPS_EXPLORER: CommandId[][] = [
  ["open", "pasteClipboard"],
  ["explorerUp", "explorerRefresh", "sortMenu"],
  ["openViewer", "mosaic", "photoStamp", "idPhoto"],
  ["batchConvert", "batchRename", "batchRotate", "photoCollage", "pdfBinding"],
  ["newFolder", "rename", "copyToFolder", "moveToFolder", "delete", "undo"],
  ["toggleInfo"],
  ["toggleFullscreen", "openSettings"],
];

/** 하위 호환용 기본 TOOLBAR_GROUPS */
export const TOOLBAR_GROUPS = TOOLBAR_GROUPS_VIEWER;

/** 우클릭 컨텍스트 메뉴 그룹 순서 */
export const CONTEXT_MENU_GROUPS: CommandId[][] = [
  ["open", "pasteClipboard"],
  ["copyImage", "copyFiles", "copyPath", "showInFolder"],
  ["rotateCcw", "rotateCw", "flipH", "flipV"],
  ["saveCopy", "saveAs", "crop", "adjust", "mosaic", "photoStamp", "idPhoto", "resizeImage", "printImage"],
  ["batchConvert", "batchRename", "batchRotate", "photoCollage", "pdfBinding"],
  ["rename", "copyToFolder", "moveToFolder", "delete", "undo"],
  ["openExternalEditor", "setWallpaper"],
  ["toggleSlideshow", "sortMenu"],
  ["toggleInfo", "openSettings"],
];
