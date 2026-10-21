export type BatchModalMode = "convert" | "rename" | "rotate";

export interface BatchConvertOptions {
  taskId: string;
  sourcePaths: string[];
  outputDir: string;
  format: "jpg" | "png" | "webp";
  quality: number;
  resizeMode: "none" | "long_edge" | "percent";
  longEdgePx?: number;
  percent?: number;
  maxKbLimit?: number;
  keepExif: boolean;
}

export interface BatchRotateOptions {
  taskId: string;
  sourcePaths: string[];
  outputDir: string;
  mode: "exif_auto" | "rotate90" | "rotate180" | "rotate270";
}

export interface BatchRenameItem {
  oldPath: string;
  newName: string;
}

export interface BatchFailureItem {
  path: string;
  error: string;
}

export interface BatchProgressPayload {
  taskId: string;
  total: number;
  currentIndex: number;
  currentName: string;
  successCount: number;
  failureCount: number;
  isFinished: boolean;
  isCancelled: boolean;
  failures: BatchFailureItem[];
  outputDir: string;
}

export interface BatchRenameResult {
  successCount: number;
  failureCount: number;
  failures: BatchFailureItem[];
}
