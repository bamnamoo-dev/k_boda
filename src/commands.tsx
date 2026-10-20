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
  | "saveCopy"
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
  | "openViewer";

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
};

/**
 * 모든 단축키, 상단 툴바, 우클릭 메뉴, 도움말 표에서 단일 진실 공급원(Single Source of Truth)으로 사용되는 명령 목록을 생성합니다.
 */
export function buildCommands(actions: CommandActions, state: CommandState): AppCommand[] {
  const iconSize = 18;

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
      label: "사본으로 저장",
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
  ];
}

/** 뷰어 모드 상단 툴바 버튼 그룹 */
export const TOOLBAR_GROUPS_VIEWER: CommandId[][] = [
  ["open"],
  ["prev", "next"],
  ["fit", "actualSize", "zoomOut", "zoomIn"],
  ["rotateCcw", "rotateCw"],
  ["delete"],
  ["toggleDoublePage", "toggleFilmstrip", "toggleInfo"],
  ["toggleFullscreen", "openSettings"],
];

/** 탐색기 모드 상단 툴바 버튼 그룹 */
export const TOOLBAR_GROUPS_EXPLORER: CommandId[][] = [
  ["open"],
  ["explorerUp", "explorerRefresh"],
  ["openViewer"],
  ["delete"],
  ["toggleInfo"],
  ["toggleFullscreen", "openSettings"],
];

/** 하위 호환용 기본 TOOLBAR_GROUPS */
export const TOOLBAR_GROUPS = TOOLBAR_GROUPS_VIEWER;

/** 우클릭 컨텍스트 메뉴 그룹 순서 */
export const CONTEXT_MENU_GROUPS: CommandId[][] = [
  ["open"],
  ["copyImage", "copyPath", "showInFolder"],
  ["rotateCcw", "rotateCw", "saveCopy"],
  ["delete"],
  ["toggleInfo", "openSettings"],
];
