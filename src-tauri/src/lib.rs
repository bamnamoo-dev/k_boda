use std::cmp::Ordering;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::UI::Shell::DROPFILES;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_SETDESKWALLPAPER,
};

/// WebView2가 직접 표시할 수 있는 이미지 및 변환 지원 확장자
const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "gif", "webp", "avif", "bmp", "svg", "tif", "tiff", "heic", "heif",
];

/// 13단계: CAD 도면 파일 확장자
const CAD_EXTENSIONS: &[&str] = &["dwg", "dxf"];

// 캐시 최대 크기: 500MB
const MAX_CACHE_SIZE_BYTES: u64 = 500 * 1024 * 1024;
const TARGET_CACHE_SIZE_BYTES: u64 = 400 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortBy {
    Name,
    DateModified,
    DateTaken,
    FileSize,
    FileType,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortOrder {
    Asc,
    Desc,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageEntry {
    pub path: String,
    pub file_name: String,
    pub file_size: u64,
    pub modified: u64,
    pub is_archive_entry: bool,
    pub archive_path: Option<String>,
    pub entry_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScanResult {
    pub current_index: usize,
    pub items: Vec<ImageEntry>,
    pub orientation: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDetails {
    pub path: String,
    pub file_name: String,
    pub file_size: u64,
    pub modified: u64,
    pub width: u32,
    pub height: u32,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub date_time_original: Option<String>,
    pub f_number: Option<String>,
    pub exposure_time: Option<String>,
    pub iso: Option<String>,
    pub focal_length: Option<String>,
    pub ai_prompt: Option<String>,
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum KeyChunk<'a> {
    Num(u128, usize),
    Text(&'a str),
}

/// "img1.png", "img2.png", "img10.png" 순서로 정렬하는 자연 정렬(Natural Sort) 키 생성
fn natural_sort_key(s: &str) -> Vec<KeyChunk<'_>> {
    let mut chunks = Vec::new();
    let mut chars = s.char_indices().peekable();

    while let Some(&(start, c)) = chars.peek() {
        if c.is_ascii_digit() {
            let mut end = start;
            while let Some(&(idx, ch)) = chars.peek() {
                if ch.is_ascii_digit() {
                    end = idx + ch.len_utf8();
                    chars.next();
                } else {
                    break;
                }
            }
            let num_str = &s[start..end];
            let val = num_str.parse::<u128>().unwrap_or(u128::MAX);
            chunks.push(KeyChunk::Num(val, num_str.len()));
        } else {
            let mut end = start;
            while let Some(&(idx, ch)) = chars.peek() {
                if !ch.is_ascii_digit() {
                    end = idx + ch.len_utf8();
                    chars.next();
                } else {
                    break;
                }
            }
            chunks.push(KeyChunk::Text(&s[start..end]));
        }
    }
    chunks
}

fn compare_natural(a: &str, b: &str) -> Ordering {
    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();
    let key_a = natural_sort_key(&a_lower);
    let key_b = natural_sort_key(&b_lower);
    key_a.cmp(&key_b).then_with(|| a.cmp(b))
}

fn get_exif_date_taken(path: &str) -> Option<String> {
    let p = Path::new(path);
    if let Ok(file) = File::open(p) {
        let mut bufreader = BufReader::new(file);
        let exifreader = exif::Reader::new();
        if let Ok(exif_data) = exifreader.read_from_container(&mut bufreader) {
            for f in exif_data.fields() {
                if f.tag == exif::Tag::DateTimeOriginal {
                    return Some(f.display_value().to_string().trim_matches('"').to_string());
                }
            }
        }
    }
    None
}

fn sort_entries(items: &mut [ImageEntry], sort_by: SortBy, sort_order: SortOrder) {
    items.sort_by(|a, b| {
        let ord = match sort_by {
            SortBy::Name => compare_natural(&a.file_name, &b.file_name),
            SortBy::DateModified => a.modified.cmp(&b.modified),
            SortBy::DateTaken => {
                let dt_a = get_exif_date_taken(&a.path);
                let dt_b = get_exif_date_taken(&b.path);
                match (dt_a, dt_b) {
                    (Some(da), Some(db)) => da.cmp(&db),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => a.modified.cmp(&b.modified),
                }
            }
            SortBy::FileSize => a.file_size.cmp(&b.file_size),
            SortBy::FileType => {
                let ext_a = Path::new(&a.file_name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let ext_b = Path::new(&b.file_name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                ext_a.cmp(&ext_b).then_with(|| compare_natural(&a.file_name, &b.file_name))
            }
        };
        match sort_order {
            SortOrder::Asc => ord,
            SortOrder::Desc => ord.reverse(),
        }
    });
}

/// %LOCALAPPDATA%\k-boda\thumbnails 캐시 디렉토리
fn get_thumbnail_cache_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let cache_dir = base.join("k-boda").join("thumbnails");
    let _ = std::fs::create_dir_all(&cache_dir);
    cache_dir
}

/// %LOCALAPPDATA%\k-boda\zip_temp 임시 디렉토리 (ZIP 온디맨드 추출용)
fn get_zip_temp_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let temp_dir = base.join("k-boda").join("zip_temp");
    let _ = std::fs::create_dir_all(&temp_dir);
    temp_dir
}

/// 이전 임시 파일들 정리
fn clean_zip_temp_dir() {
    let temp_dir = get_zip_temp_dir();
    if let Ok(entries) = std::fs::read_dir(temp_dir) {
        for e in entries.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// 캐시 키 생성: 파일 경로 + 수정 시각 + 크기 해시
fn make_cache_filename(path: &str, modified: u64, size: u64) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    modified.hash(&mut hasher);
    size.hash(&mut hasher);
    format!("{:016x}.jpg", hasher.finish())
}

/// 캐시 폴더 용량이 500MB를 넘으면 오래된 것부터 삭제 (SQLite 미사용)
fn cleanup_cache_if_needed(cache_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };

    let mut files = Vec::new();
    let mut total_size = 0u64;

    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() {
            if let Ok(meta) = p.metadata() {
                let size = meta.len();
                let mod_time = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                total_size += size;
                files.push((p, size, mod_time));
            }
        }
    }

    if total_size > MAX_CACHE_SIZE_BYTES {
        files.sort_by_key(|item| item.2);

        for (path, size, _) in files {
            if total_size <= TARGET_CACHE_SIZE_BYTES {
                break;
            }
            if std::fs::remove_file(path).is_ok() {
                total_size = total_size.saturating_sub(size);
            }
        }
    }
}

/// ZIP 안의 바이트를 UTF-8 또는 CP949(EUC-KR)로 디코딩 (한글 깨짐 방지)
fn decode_zip_filename(raw_bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(raw_bytes) {
        return s.to_string();
    }
    let (cow, _, _) = encoding_rs::EUC_KR.decode(raw_bytes);
    cow.into_owned()
}

/// JPEG 파일의 EXIF Orientation 태그 읽기
#[tauri::command]
fn get_orientation(path: String) -> u16 {
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return 1,
    };

    let mut buf = [0u8; 4096];
    let bytes_read = match file.read(&mut buf) {
        Ok(n) if n >= 4 => n,
        _ => return 1,
    };

    if buf[0] != 0xFF || buf[1] != 0xD8 {
        return 1;
    }

    let mut idx = 2;
    while idx + 4 <= bytes_read {
        if buf[idx] != 0xFF {
            break;
        }
        let marker = buf[idx + 1];
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let seg_len = ((buf[idx + 2] as usize) << 8) | (buf[idx + 3] as usize);
        if seg_len < 2 {
            break;
        }

        if marker == 0xE1 {
            let seg_end = (idx + 2 + seg_len).min(bytes_read);
            let exif_start = idx + 4;
            if seg_end >= exif_start + 6 && &buf[exif_start..exif_start + 6] == b"Exif\0\0" {
                let tiff_start = exif_start + 6;
                let tiff_data = &buf[tiff_start..seg_end];
                if tiff_data.len() >= 8 {
                    let is_le = match &tiff_data[0..2] {
                        b"II" => true,
                        b"MM" => false,
                        _ => return 1,
                    };

                    let read_u16 = |slice: &[u8], offset: usize| -> Option<u16> {
                        if offset + 2 <= slice.len() {
                            if is_le {
                                Some(u16::from_le_bytes([slice[offset], slice[offset + 1]]))
                            } else {
                                Some(u16::from_be_bytes([slice[offset], slice[offset + 1]]))
                            }
                        } else {
                            None
                        }
                    };

                    let read_u32 = |slice: &[u8], offset: usize| -> Option<u32> {
                        if offset + 4 <= slice.len() {
                            if is_le {
                                Some(u32::from_le_bytes([
                                    slice[offset],
                                    slice[offset + 1],
                                    slice[offset + 2],
                                    slice[offset + 3],
                                ]))
                            } else {
                                Some(u32::from_be_bytes([
                                    slice[offset],
                                    slice[offset + 1],
                                    slice[offset + 2],
                                    slice[offset + 3],
                                ]))
                            }
                        } else {
                            None
                        }
                    };

                    if let Some(ifd0_offset) = read_u32(tiff_data, 4) {
                        let ifd_offset = ifd0_offset as usize;
                        if let Some(entries_count) = read_u16(tiff_data, ifd_offset) {
                            let mut entry_pos = ifd_offset + 2;
                            for _ in 0..entries_count {
                                if entry_pos + 12 > tiff_data.len() {
                                    break;
                                }
                                let tag = read_u16(tiff_data, entry_pos).unwrap_or(0);
                                if tag == 0x0112 {
                                    let val = read_u16(tiff_data, entry_pos + 8).unwrap_or(1);
                                    if (1..=8).contains(&val) {
                                        return val;
                                    }
                                    return 1;
                                }
                                entry_pos += 12;
                            }
                        }
                    }
                }
            }
            break;
        }

        idx += 2 + seg_len;
    }

    1
}

/// PNG 파일의 tEXt / iTXt 청크에서 AI 생성 정보 추출
fn extract_png_ai_parameters<P: AsRef<Path>>(path: P) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut header = [0u8; 8];
    file.read_exact(&mut header).ok()?;
    if &header != b"\x89PNG\r\n\x1a\n" {
        return None;
    }

    let mut chunk_len_buf = [0u8; 4];
    let mut chunk_type_buf = [0u8; 4];

    let mut scanned_bytes = 8u64;
    while scanned_bytes < 3 * 1024 * 1024 {
        if file.read_exact(&mut chunk_len_buf).is_err() {
            break;
        }
        if file.read_exact(&mut chunk_type_buf).is_err() {
            break;
        }
        let length = u32::from_be_bytes(chunk_len_buf) as usize;
        let chunk_type = &chunk_type_buf;

        if chunk_type == b"IEND" {
            break;
        }

        if chunk_type == b"tEXt" || chunk_type == b"iTXt" {
            let mut data = vec![0u8; length.min(512 * 1024)];
            if file.read_exact(&mut data).is_ok() {
                if let Some(null_idx) = data.iter().position(|&b| b == 0) {
                    let keyword = String::from_utf8_lossy(&data[0..null_idx]).to_lowercase();
                    if keyword == "parameters" || keyword == "prompt" || keyword == "workflow" {
                        if chunk_type == b"tEXt" {
                            let text = String::from_utf8_lossy(&data[null_idx + 1..]).to_string();
                            return Some(text);
                        } else if chunk_type == b"iTXt" {
                            let rest = &data[null_idx + 1..];
                            if rest.len() >= 2 && rest[0] == 0 {
                                let mut parts = rest[2..].split(|&b| b == 0);
                                let _lang = parts.next();
                                let _trans = parts.next();
                                if let Some(content) = parts.next() {
                                    let text = String::from_utf8_lossy(content).to_string();
                                    return Some(text);
                                }
                            }
                        }
                    }
                }
            }
            let _ = file.seek(SeekFrom::Current(4));
        } else {
            let _ = file.seek(SeekFrom::Current(length as i64 + 4));
        }

        scanned_bytes += 8 + length as u64 + 4;
    }

    None
}

/// 우측 패널 상세 정보 조회
#[tauri::command]
fn get_image_details(path: String) -> Result<ImageDetails, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| format!("메타데이터를 읽지 못했습니다: {e}"))?;
    let file_size = meta.len();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file_name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());

    let (width, height) = match image::image_dimensions(p) {
        Ok((w, h)) => (w, h),
        Err(_) => (0, 0),
    };

    let mut camera_make = None;
    let mut camera_model = None;
    let mut lens_model = None;
    let mut date_time_original = None;
    let mut f_number = None;
    let mut exposure_time = None;
    let mut iso = None;
    let mut focal_length = None;

    if let Ok(file) = File::open(p) {
        let mut bufreader = BufReader::new(file);
        let exifreader = exif::Reader::new();
        if let Ok(exif_data) = exifreader.read_from_container(&mut bufreader) {
            for f in exif_data.fields() {
                match f.tag {
                    exif::Tag::Make => camera_make = Some(f.display_value().to_string().trim_matches('"').to_string()),
                    exif::Tag::Model => camera_model = Some(f.display_value().to_string().trim_matches('"').to_string()),
                    exif::Tag::LensModel => lens_model = Some(f.display_value().to_string().trim_matches('"').to_string()),
                    exif::Tag::DateTimeOriginal => date_time_original = Some(f.display_value().to_string().trim_matches('"').to_string()),
                    exif::Tag::FNumber => f_number = Some(format!("f/{}", f.display_value())),
                    exif::Tag::ExposureTime => exposure_time = Some(format!("{}s", f.display_value())),
                    exif::Tag::PhotographicSensitivity => iso = Some(format!("ISO {}", f.display_value())),
                    exif::Tag::FocalLength => focal_length = Some(f.display_value().to_string()),
                    _ => {}
                }
            }
        }
    }

    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let ai_prompt = if ext == "png" {
        extract_png_ai_parameters(p)
    } else {
        None
    };

    Ok(ImageDetails {
        path,
        file_name,
        file_size,
        modified,
        width,
        height,
        camera_make,
        camera_model,
        lens_model,
        date_time_original,
        f_number,
        exposure_time,
        iso,
        focal_length,
        ai_prompt,
    })
}

/// 썸네일 생성 및 캐시 경로 반환
#[tauri::command]
fn get_thumbnail(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let size = meta.len();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_dir = get_thumbnail_cache_dir();
    let _ = app.asset_protocol_scope().allow_directory(&cache_dir, true);

    let cache_file_name = make_cache_filename(&path, modified, size);
    let cache_path = cache_dir.join(&cache_file_name);
    let _ = app.asset_protocol_scope().allow_file(&cache_path);

    if cache_path.exists() {
        return Ok(cache_path.to_string_lossy().into_owned());
    }

    let img = image::open(p).map_err(|e| format!("이미지를 열 수 없습니다: {e}"))?;
    let thumb = img.thumbnail(256, 256);

    thumb
        .save_with_format(&cache_path, image::ImageFormat::Jpeg)
        .map_err(|e| format!("썸네일 저장 실패: {e}"))?;

    cleanup_cache_if_needed(&cache_dir);

    Ok(cache_path.to_string_lossy().into_owned())
}

/// 윈도우 탐색기에서 해당 파일 선택하여 열기
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,\"{}\"", path))
        .spawn()
        .map_err(|e| format!("탐색기를 실행하지 못했습니다: {e}"))?;
    Ok(())
}

/// 파일 삭제 (실행 취소(Ctrl+Z)를 위해 스테이징 후 최대 20단계 스택 관리, 스택 초과시 휴지통으로 이동)
#[tauri::command]
fn delete_to_trash(path: String, undo_state: tauri::State<UndoState>) -> Result<(), String> {
    delete_paths_to_trash(vec![path], undo_state)
}

/// 회전 및 반전된 이미지 사본 저장 (원본 절대 덮어쓰지 않음)
#[tauri::command]
fn save_rotated_image(
    source_path: String,
    rotation: u32,
    flip_h: Option<bool>,
    flip_v: Option<bool>,
) -> Result<String, String> {
    let src = Path::new(&source_path);
    let parent = src.parent().unwrap_or_else(|| Path::new(""));
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("jpg");

    let is_flipped = flip_h.unwrap_or(false) || flip_v.unwrap_or(false);
    let suffix = if rotation % 360 != 0 && is_flipped {
        "modified"
    } else if is_flipped {
        "flipped"
    } else {
        "rotated"
    };

    let mut counter = 0;
    let target_path = loop {
        let file_name = if counter == 0 {
            format!("{}_{}.{}", stem, suffix, ext)
        } else {
            format!("{}_{}_{}.{}", stem, suffix, counter, ext)
        };
        let p = parent.join(&file_name);
        if !p.exists() {
            break p;
        }
        counter += 1;
    };

    let img = image::open(src).map_err(|e| format!("이미지를 열 수 없습니다: {e}"))?;
    let mut processed = match rotation % 360 {
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => img,
    };
    if flip_h.unwrap_or(false) {
        processed = processed.fliph();
    }
    if flip_v.unwrap_or(false) {
        processed = processed.flipv();
    }

    processed
        .save(&target_path)
        .map_err(|e| format!("사본 저장에 실패했습니다: {e}"))?;

    Ok(target_path.to_string_lossy().into_owned())
}

/// 9단계: 다른 이름으로 저장 (크기 조정 Lanczos3, 회전, 좌우/상하 반전, 품질, 포맷 변환, 메타데이터 제거)
#[tauri::command]
fn save_image_advanced(
    source_path: String,
    target_path: String,
    format: String,
    quality: u8,
    rotation: u32,
    flip_h: bool,
    flip_v: bool,
    _strip_metadata: bool,
    _strip_ai_prompt: bool,
    resize_width: Option<u32>,
    resize_height: Option<u32>,
) -> Result<String, String> {
    let src = Path::new(&source_path);
    let target = Path::new(&target_path);

    let mut img = image::open(src).map_err(|e| format!("이미지를 열 수 없습니다: {e}"))?;

    // 1. 크기 조정 (고품질 Lanczos3 필터)
    if let (Some(w), Some(h)) = (resize_width, resize_height) {
        if w > 0 && h > 0 && (w != img.width() || h != img.height()) {
            img = img.resize_exact(w, h, image::imageops::FilterType::Lanczos3);
        }
    }

    // 2. 화면에 적용된 회전 반영
    img = match rotation % 360 {
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => img,
    };

    // 3. 화면에 적용된 반전 반영
    if flip_h {
        img = img.fliph();
    }
    if flip_v {
        img = img.flipv();
    }

    // 4. 저장 포맷 및 인코딩
    let fmt_str = format.to_lowercase();
    let parent = target.parent().unwrap_or_else(|| Path::new(""));
    let _ = std::fs::create_dir_all(parent);

    let file = File::create(target).map_err(|e| format!("대상 파일을 생성할 수 없습니다: {e}"))?;
    let mut writer = std::io::BufWriter::new(file);

    match fmt_str.as_str() {
        "jpg" | "jpeg" => {
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, quality.clamp(1, 100));
            encoder.encode_image(&img).map_err(|e| format!("JPEG 인코딩 실패: {e}"))?;
        }
        "png" => {
            img.write_to(&mut writer, image::ImageFormat::Png)
                .map_err(|e| format!("PNG 저장 실패: {e}"))?;
        }
        "webp" => {
            img.write_to(&mut writer, image::ImageFormat::WebP)
                .map_err(|e| format!("WebP 저장 실패: {e}"))?;
        }
        "bmp" => {
            img.write_to(&mut writer, image::ImageFormat::Bmp)
                .map_err(|e| format!("BMP 저장 실패: {e}"))?;
        }
        _ => {
            return Err(format!("지원하지 않는 저장 형식입니다: {fmt_str}"));
        }
    }

    Ok(target.to_string_lossy().into_owned())
}

/// ZIP/CBZ 압축 파일 내부의 특정 엔트리를 zip_temp에 온디맨드로 추출하여 파일 경로 반환
#[tauri::command]
fn get_archive_entry_image(
    app: tauri::AppHandle,
    archive_path: String,
    entry_name: String,
) -> Result<String, String> {
    let zip_file = File::open(&archive_path).map_err(|e| format!("압축 파일을 열 수 없습니다: {e}"))?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| format!("ZIP 아카이브 파싱 실패: {e}"))?;

    let mut entry = archive
        .by_name(&entry_name)
        .map_err(|e| format!("압축 내부 파일을 찾을 수 없습니다: {e}"))?;

    let temp_dir = get_zip_temp_dir();
    let _ = app.asset_protocol_scope().allow_directory(&temp_dir, false);

    let mut hasher = DefaultHasher::new();
    archive_path.hash(&mut hasher);
    entry_name.hash(&mut hasher);
    let hash_val = hasher.finish();

    let ext = Path::new(&entry_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg");
    let out_path = temp_dir.join(format!("{:016x}.{}", hash_val, ext));

    if !out_path.exists() {
        let mut out_file = File::create(&out_path).map_err(|e| format!("임시 파일 생성 실패: {e}"))?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| format!("임시 파일 추출 실패: {e}"))?;
    }

    Ok(out_path.to_string_lossy().into_owned())
}

/// 파일 또는 ZIP/CBZ 압축 아카이브 열기
#[tauri::command]
fn open_image(
    app: tauri::AppHandle,
    path: String,
    sort_by: Option<SortBy>,
    sort_order: Option<SortOrder>,
) -> Result<FolderScanResult, String> {
    let target_path = Path::new(&path);
    let meta = std::fs::metadata(target_path).map_err(|_| "파일을 찾을 수 없거나 읽을 수 없습니다.".to_string())?;
    if !meta.is_file() {
        return Err("폴더는 열 수 없습니다. 이미지 또는 ZIP/CBZ 파일을 선택해 주세요.".to_string());
    }

    let ext = target_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    let cache_dir = get_thumbnail_cache_dir();
    let _ = app.asset_protocol_scope().allow_directory(&cache_dir, false);

    let temp_dir = get_zip_temp_dir();
    let _ = app.asset_protocol_scope().allow_directory(&temp_dir, false);

    // ZIP 또는 CBZ 압축 아카이브인 경우
    if ext == "zip" || ext == "cbz" {
        clean_zip_temp_dir();

        let zip_file = File::open(target_path).map_err(|e| format!("압축 파일을 열 수 없습니다: {e}"))?;
        let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| format!("ZIP 아카이브를 읽을 수 없습니다: {e}"))?;

        let mut items = Vec::new();
        for i in 0..archive.len() {
            if let Ok(entry) = archive.by_index(i) {
                if entry.is_file() {
                    let raw_name = entry.name_raw();
                    let decoded_name = decode_zip_filename(raw_name);

                    // macOS 메타데이터 등 제외
                    if decoded_name.starts_with("__MACOSX") || decoded_name.contains("/.") {
                        continue;
                    }

                    let entry_ext = Path::new(&decoded_name)
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x.to_ascii_lowercase())
                        .unwrap_or_default();

                    if IMAGE_EXTENSIONS.contains(&entry_ext.as_str()) {
                        let file_name = Path::new(&decoded_name)
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| decoded_name.clone());

                        items.push(ImageEntry {
                            path: String::new(), // 추출 전에는 빈 문자열, 첫 이미지 또는 요청 시 추출
                            file_name,
                            file_size: entry.size(),
                            modified: 0,
                            is_archive_entry: true,
                            archive_path: Some(path.clone()),
                            entry_name: Some(entry.name().to_string()),
                        });
                    }
                }
            }
        }

        if items.is_empty() {
            return Err("압축 파일 내에 지원하는 이미지 파일이 없습니다.".to_string());
        }

        // 자연 정렬 수행
        items.sort_by(|a, b| compare_natural(&a.file_name, &b.file_name));

        // 첫 번째 이미지 온디맨드 추출
        if let Some(first) = items.first_mut() {
            if let Some(ref entry_name) = first.entry_name {
                if let Ok(extracted_path) = get_archive_entry_image(app.clone(), path.clone(), entry_name.clone()) {
                    first.path = extracted_path;
                }
            }
        }

        return Ok(FolderScanResult {
            current_index: 0,
            items,
            orientation: 1,
        });
    }

    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err("지원하지 않는 파일 형식입니다. (JPG, PNG, WebP, GIF, AVIF, BMP, SVG, ZIP, CBZ)".to_string());
    }

    let mut items = Vec::new();
    let mut current_index = 0;
    let orientation = get_orientation(path.clone());

    if let Some(parent_dir) = target_path.parent() {
        let _ = app.asset_protocol_scope().allow_directory(parent_dir, false);

        if let Ok(entries) = std::fs::read_dir(parent_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let e = p
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x.to_ascii_lowercase())
                        .unwrap_or_default();
                    if IMAGE_EXTENSIONS.contains(&e.as_str()) {
                        let file_name = p
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        let path_str = p.to_string_lossy().into_owned();
                        let (file_size, modified) = match entry.metadata() {
                            Ok(m) => {
                                let size = m.len();
                                let mod_time = m
                                    .modified()
                                    .ok()
                                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                    .map(|d| d.as_secs())
                                    .unwrap_or(0);
                                (size, mod_time)
                            }
                            Err(_) => (0, 0),
                        };
                        items.push(ImageEntry {
                            path: path_str,
                            file_name,
                            file_size,
                            modified,
                            is_archive_entry: false,
                            archive_path: None,
                            entry_name: None,
                        });
                    }
                }
            }
        }
    }

    if items.is_empty() {
        let _ = app.asset_protocol_scope().allow_file(target_path);
        let file_name = target_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let file_size = meta.len();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        items.push(ImageEntry {
            path: path.clone(),
            file_name,
            file_size,
            modified,
            is_archive_entry: false,
            archive_path: None,
            entry_name: None,
        });
    } else {
        let sort_by = sort_by.unwrap_or(SortBy::Name);
        let sort_order = sort_order.unwrap_or(SortOrder::Asc);
        sort_entries(&mut items, sort_by, sort_order);

        let canonical_target = std::fs::canonicalize(target_path).ok();
        for (i, item) in items.iter().enumerate() {
            if item.path == path {
                current_index = i;
                break;
            }
            if let Some(ref can) = canonical_target {
                if let Ok(c) = std::fs::canonicalize(&item.path) {
                    if c == *can {
                        current_index = i;
                        break;
                    }
                }
            }
        }
    }

    Ok(FolderScanResult {
        current_index,
        items,
        orientation,
    })
}

/// 지원하는 이미지 또는 아카이브 파일인지 확인
fn is_supported_file(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    IMAGE_EXTENSIONS.contains(&ext.as_str())
        || ext == "zip"
        || ext == "cbz"
        || CAD_EXTENSIONS.contains(&ext.as_str())
}

fn default_true() -> bool {
    true
}

fn default_tree_width() -> u32 {
    240
}

fn default_thumbnail_size() -> u32 {
    120
}

fn default_false() -> bool {
    false
}

fn default_zoom_mode() -> String {
    "fitIfLarge".to_string()
}

fn default_wheel_action() -> String {
    "navigate".to_string()
}

fn default_interpolation() -> String {
    "smooth".to_string()
}

fn default_slideshow_interval() -> u32 {
    3
}

fn default_filter() -> String {
    "all".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecentItemEntry {
    pub path: String,
    pub name: String,
    pub is_folder: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditorEntry {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String, // "dark" | "light"
    pub sort_by: SortBy,
    pub sort_order: SortOrder,
    pub auto_next_folder: bool,
    pub default_bg: String, // "black" | "dark" | "checker"
    #[serde(default = "default_true")]
    pub show_toolbar: bool,
    #[serde(default = "default_true")]
    pub show_status_bar: bool,
    pub last_folder: Option<String>,
    #[serde(default = "default_tree_width")]
    pub folder_tree_width: u32,
    #[serde(default = "default_thumbnail_size")]
    pub thumbnail_size: u32,
    #[serde(default = "default_zoom_mode")]
    pub zoom_mode: String,
    #[serde(default = "default_wheel_action")]
    pub wheel_action: String,
    #[serde(default = "default_false")]
    pub keep_transform: bool,
    #[serde(default = "default_interpolation")]
    pub interpolation: String,
    #[serde(default = "default_slideshow_interval")]
    pub slideshow_interval: u32,
    #[serde(default = "default_false")]
    pub slideshow_random: bool,
    #[serde(default = "default_true")]
    pub slideshow_loop: bool,
    #[serde(default)]
    pub recent_items: Vec<RecentItemEntry>,
    #[serde(default)]
    pub favorite_folders: Vec<String>,
    #[serde(default)]
    pub recent_target_folders: Vec<String>,
    #[serde(default)]
    pub external_editors: Vec<ExternalEditorEntry>,
    #[serde(default = "default_filter")]
    pub explorer_filter: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            sort_by: SortBy::Name,
            sort_order: SortOrder::Asc,
            auto_next_folder: false,
            default_bg: "black".to_string(),
            show_toolbar: true,
            show_status_bar: true,
            last_folder: None,
            folder_tree_width: 240,
            thumbnail_size: 120,
            zoom_mode: "fitIfLarge".to_string(),
            wheel_action: "navigate".to_string(),
            keep_transform: false,
            interpolation: "smooth".to_string(),
            slideshow_interval: 3,
            slideshow_random: false,
            slideshow_loop: true,
            recent_items: Vec::new(),
            favorite_folders: Vec::new(),
            recent_target_folders: Vec::new(),
            external_editors: Vec::new(),
            explorer_filter: "all".to_string(),
        }
    }
}

fn get_settings_file_path() -> Option<PathBuf> {
    let app_data = std::env::var("APPDATA").ok()?;
    let dir = PathBuf::from(&app_data).join("k-boda");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("settings.json");
    if !path.exists() {
        let legacy_path = PathBuf::from(&app_data).join("PrismView").join("settings.json");
        if legacy_path.exists() {
            let _ = std::fs::copy(&legacy_path, &path);
        }
    }
    Some(path)
}

#[tauri::command]
fn load_settings() -> AppSettings {
    if let Some(path) = get_settings_file_path() {
        if let Ok(file) = File::open(&path) {
            if let Ok(settings) = serde_json::from_reader(BufReader::new(file)) {
                return settings;
            }
        }
    }
    AppSettings::default()
}

#[tauri::command]
fn save_settings(settings: AppSettings) -> Result<(), String> {
    let path = get_settings_file_path().ok_or_else(|| "APPDATA 디렉터리를 찾을 수 없습니다.".to_string())?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IdPhotoGuideSettings {
    pub crown_percent: f64,
    pub chin_percent: f64,
    pub eye_percent: f64,
    pub oval_width_percent: f64,
    pub oval_height_percent: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IdPhotoPreset {
    pub id: String,
    pub name: String,
    pub width_px: u32,
    pub height_px: u32,
    pub width_cm: f64,
    pub height_cm: f64,
    pub dpi: u32,
    pub max_bytes: Option<u64>,
    pub format: String,
    pub is_locked: bool,
    pub description: String,
    pub guide: IdPhotoGuideSettings,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IdPhotoValidationResult {
    pub path: String,
    pub file_size: u64,
    pub width: u32,
    pub height: u32,
    pub is_exact_size: bool,
    pub is_valid_jpg: bool,
    pub is_under_size_limit: bool,
    pub pass_official_spec: bool,
    pub message: String,
}

fn get_id_photo_presets_path() -> Option<PathBuf> {
    let app_data = std::env::var("APPDATA").ok()?;
    let dir = PathBuf::from(&app_data).join("k-boda");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("id_photo_presets.json");
    if !path.exists() {
        let legacy = PathBuf::from(&app_data).join("PrismView").join("id_photo_presets.json");
        if legacy.exists() {
            let _ = std::fs::copy(&legacy, &path);
        }
    }
    Some(path)
}

fn get_default_id_photo_presets() -> Vec<IdPhotoPreset> {
    vec![
        IdPhotoPreset {
            id: "civil_service".to_string(),
            name: "공무원증".to_string(),
            width_px: 354,
            height_px: 472,
            width_cm: 3.0,
            height_cm: 4.0,
            dpi: 300,
            max_bytes: Some(150_000), // 150,000바이트 미만
            format: "jpg".to_string(),
            is_locked: true, // 공무원증 프리셋은 삭제·수정 잠금 (실수 방지)
            description: "354×472 px, JPG, 150KB 미만, 메타데이터 제거".to_string(),
            guide: IdPhotoGuideSettings {
                crown_percent: 15.0,
                chin_percent: 78.0,
                eye_percent: 40.0,
                oval_width_percent: 54.0,
                oval_height_percent: 63.0,
            },
        },
        IdPhotoPreset {
            id: "id_photo_3x4".to_string(),
            name: "증명사진 3x4cm".to_string(),
            width_px: 354,
            height_px: 472,
            width_cm: 3.0,
            height_cm: 4.0,
            dpi: 300,
            max_bytes: Some(500_000),
            format: "jpg".to_string(),
            is_locked: false,
            description: "일반 서류·이력서용 (3x4cm)".to_string(),
            guide: IdPhotoGuideSettings {
                crown_percent: 16.0,
                chin_percent: 78.0,
                eye_percent: 41.0,
                oval_width_percent: 52.0,
                oval_height_percent: 62.0,
            },
        },
        IdPhotoPreset {
            id: "passport_35x45".to_string(),
            name: "여권·주민등록증·운전면허 3.5x4.5cm".to_string(),
            width_px: 413,
            height_px: 531,
            width_cm: 3.5,
            height_cm: 4.5,
            dpi: 300,
            max_bytes: Some(500_000),
            format: "jpg".to_string(),
            is_locked: false,
            description: "온라인 제출용 (413×531 px, JPG)".to_string(),
            guide: IdPhotoGuideSettings {
                crown_percent: 12.0,
                chin_percent: 82.0,
                eye_percent: 38.0,
                oval_width_percent: 58.0,
                oval_height_percent: 70.0,
            },
        },
        IdPhotoPreset {
            id: "half_namecard_3x4".to_string(),
            name: "반명함 3x4cm".to_string(),
            width_px: 354,
            height_px: 472,
            width_cm: 3.0,
            height_cm: 4.0,
            dpi: 300,
            max_bytes: Some(500_000),
            format: "jpg".to_string(),
            is_locked: false,
            description: "반명함판 규격 (3x4cm)".to_string(),
            guide: IdPhotoGuideSettings {
                crown_percent: 16.0,
                chin_percent: 78.0,
                eye_percent: 41.0,
                oval_width_percent: 52.0,
                oval_height_percent: 62.0,
            },
        },
    ]
}

#[tauri::command]
fn load_id_photo_presets() -> Vec<IdPhotoPreset> {
    if let Some(path) = get_id_photo_presets_path() {
        if let Ok(file) = File::open(&path) {
            if let Ok(mut presets) = serde_json::from_reader::<_, Vec<IdPhotoPreset>>(BufReader::new(file)) {
                let defaults = get_default_id_photo_presets();
                if let Some(civil) = defaults.first() {
                    if !presets.iter().any(|p| p.id == "civil_service") {
                        presets.insert(0, civil.clone());
                    } else if let Some(idx) = presets.iter().position(|p| p.id == "civil_service") {
                        if idx != 0 {
                            let item = presets.remove(idx);
                            presets.insert(0, item);
                        }
                    }
                }
                return presets;
            }
        }
    }
    let defaults = get_default_id_photo_presets();
    if let Some(path) = get_id_photo_presets_path() {
        let _ = serde_json::to_string_pretty(&defaults).map(|json| std::fs::write(path, json));
    }
    defaults
}

#[tauri::command]
fn save_id_photo_presets(mut presets: Vec<IdPhotoPreset>) -> Result<(), String> {
    let defaults = get_default_id_photo_presets();
    let civil_service = defaults.into_iter().find(|p| p.id == "civil_service").unwrap();
    if let Some(pos) = presets.iter().position(|p| p.id == "civil_service") {
        presets[pos] = civil_service;
    } else {
        presets.insert(0, civil_service);
    }

    let path = get_id_photo_presets_path().ok_or_else(|| "APPDATA 디렉터리를 찾을 수 없습니다.".to_string())?;
    let json = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_id_photo(
    source_path: String,
    target_path: String,
    crop_center_x: f64,
    crop_center_y: f64,
    crop_width: f64,
    crop_height: f64,
    rotation_deg: f64,
    target_width: u32,
    target_height: u32,
    brightness: i32,
    contrast: f32,
    saturation: f32,
    max_bytes: Option<u64>,
    _dpi: Option<u32>,
) -> Result<IdPhotoValidationResult, String> {
    let src = Path::new(&source_path);
    if !src.exists() {
        return Err("원본 이미지 파일을 찾을 수 없습니다.".to_string());
    }

    // 소문자 .jpg 강제 적용
    let mut clean_target = PathBuf::from(&target_path);
    clean_target.set_extension("jpg");

    let img = image::open(src).map_err(|e| format!("이미지를 열 수 없습니다: {e}"))?;
    let rgba_img = img.to_rgba8();
    let (orig_w, orig_h) = (rgba_img.width(), rgba_img.height());
    if orig_w == 0 || orig_h == 0 {
        return Err("유효하지 않은 이미지 크기입니다.".to_string());
    }

    let tw = target_width.max(1);
    let th = target_height.max(1);
    let rad = rotation_deg.to_radians();
    let cos_t = rad.cos();
    let sin_t = rad.sin();

    let mut out_rgba = image::RgbaImage::new(tw, th);

    // 고품질 Bilinear 서브픽셀 샘플링
    for y in 0..th {
        let ny = (y as f64 + 0.5 - (th as f64) / 2.0) / (th as f64);
        for x in 0..tw {
            let nx = (x as f64 + 0.5 - (tw as f64) / 2.0) / (tw as f64);

            let ox = crop_center_x + (nx * crop_width * cos_t - ny * crop_height * sin_t);
            let oy = crop_center_y + (nx * crop_width * sin_t + ny * crop_height * cos_t);

            let x0 = ox.floor() as i64;
            let y0 = oy.floor() as i64;
            let fx = (ox - x0 as f64).clamp(0.0, 1.0);
            let fy = (oy - y0 as f64).clamp(0.0, 1.0);

            let get_px = |ix: i64, iy: i64| -> [f64; 4] {
                let cx = ix.clamp(0, orig_w as i64 - 1) as u32;
                let cy = iy.clamp(0, orig_h as i64 - 1) as u32;
                let p = rgba_img.get_pixel(cx, cy);
                [p[0] as f64, p[1] as f64, p[2] as f64, p[3] as f64]
            };

            let p00 = get_px(x0, y0);
            let p10 = get_px(x0 + 1, y0);
            let p01 = get_px(x0, y0 + 1);
            let p11 = get_px(x0 + 1, y0 + 1);

            let mut final_channels = [0u8; 4];
            for c in 0..4 {
                let top = p00[c] * (1.0 - fx) + p10[c] * fx;
                let bot = p01[c] * (1.0 - fx) + p11[c] * fx;
                let val = (top * (1.0 - fy) + bot * fy).clamp(0.0, 255.0);
                final_channels[c] = val.round() as u8;
            }

            out_rgba.put_pixel(x, y, image::Rgba(final_channels));
        }
    }

    // 밝기, 대비, 채도 보정 및 RGB 변환 (EXIF/알파 제거, 배경 합성)
    let mut rgb_img = image::RgbImage::new(tw, th);
    let contrast_factor = contrast.clamp(0.5, 2.0);
    let saturation_factor = saturation.clamp(0.0, 2.0);
    let brightness_delta = brightness.clamp(-100, 100);

    for y in 0..th {
        for x in 0..tw {
            let p = out_rgba.get_pixel(x, y);
            let alpha = p[3] as f64 / 255.0;
            // 흰색 배경 블렌딩
            let mut r = (p[0] as f64 * alpha + 255.0 * (1.0 - alpha)) as f32;
            let mut g = (p[1] as f64 * alpha + 255.0 * (1.0 - alpha)) as f32;
            let mut b = (p[2] as f64 * alpha + 255.0 * (1.0 - alpha)) as f32;

            // 밝기
            r += brightness_delta as f32;
            g += brightness_delta as f32;
            b += brightness_delta as f32;

            // 대비
            r = ((r - 128.0) * contrast_factor) + 128.0;
            g = ((g - 128.0) * contrast_factor) + 128.0;
            b = ((b - 128.0) * contrast_factor) + 128.0;

            // 채도
            let lum = 0.299 * r + 0.587 * g + 0.114 * b;
            r = lum + (r - lum) * saturation_factor;
            g = lum + (g - lum) * saturation_factor;
            b = lum + (b - lum) * saturation_factor;

            let cr = r.clamp(0.0, 255.0).round() as u8;
            let cg = g.clamp(0.0, 255.0).round() as u8;
            let cb = b.clamp(0.0, 255.0).round() as u8;

            rgb_img.put_pixel(x, y, image::Rgb([cr, cg, cb]));
        }
    }

    // JPEG 인코딩 및 용량 조절 (150KB 미만 조건 엄격 준수, 목표 145,000바이트 이하)
    let target_limit = max_bytes.unwrap_or(u64::MAX).min(145_000);
    let mut quality = 92u8;
    let mut encoded_bytes = Vec::new();

    loop {
        encoded_bytes.clear();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded_bytes, quality);
        encoder.encode_image(&rgb_img).map_err(|e| format!("JPEG 인코딩 실패: {e}"))?;

        if (encoded_bytes.len() as u64) <= target_limit || quality <= 30 {
            break;
        }
        quality = quality.saturating_sub(2);
    }

    // 디스크 저장
    if let Some(parent) = clean_target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&clean_target, &encoded_bytes).map_err(|e| format!("파일 저장 실패: {e}"))?;

    // 저장 후 즉시 재검증 (Verification)
    let final_path_str = clean_target.to_string_lossy().into_owned();
    let meta = std::fs::metadata(&clean_target).map_err(|e| format!("저장된 파일 메타데이터 읽기 실패: {e}"))?;
    let file_size = meta.len();

    let (actual_w, actual_h) = image::image_dimensions(&clean_target).map_err(|e| format!("저장된 파일 검증 실패: {e}"))?;
    let is_exact_size = actual_w == tw && actual_h == th;

    // JPEG 매직 넘버(FF D8 FF) 확인
    let mut head = [0u8; 3];
    let is_magic_jpeg = File::open(&clean_target)
        .and_then(|mut f| f.read_exact(&mut head))
        .map(|_| head == [0xFF, 0xD8, 0xFF])
        .unwrap_or(false);

    let is_valid_jpg = is_magic_jpeg && final_path_str.to_lowercase().ends_with(".jpg");
    let is_under_size_limit = match max_bytes {
        Some(limit) => file_size < limit,
        None => true,
    };

    let pass_official_spec = is_exact_size && is_valid_jpg && is_under_size_limit;

    let message = if pass_official_spec {
        format!("✔ {}×{} · JPG · {}KB — 규격 통과", actual_w, actual_h, (file_size + 1023) / 1024)
    } else {
        let mut errs = Vec::new();
        if !is_exact_size {
            errs.push(format!("크기 불일치({}×{}, 규격: {}×{})", actual_w, actual_h, tw, th));
        }
        if !is_valid_jpg {
            errs.push("JPG 형식 오류".to_string());
        }
        if !is_under_size_limit {
            errs.push(format!("용량 초과({} 바이트 >= {} 바이트)", file_size, max_bytes.unwrap_or(0)));
        }
        format!("❌ 규격 미달: {}", errs.join(", "))
    };

    Ok(IdPhotoValidationResult {
        path: final_path_str,
        file_size,
        width: actual_w,
        height: actual_h,
        is_exact_size,
        is_valid_jpg,
        is_under_size_limit,
        pass_official_spec,
        message,
    })
}

/// 4x6인치 (1800 x 1200 px, 300DPI) 인화지 배치 생성
#[tauri::command]
fn generate_id_photo_print_sheet(
    photo_path: String,
    target_path: String,
) -> Result<String, String> {
    let p = Path::new(&photo_path);
    if !p.exists() {
        return Err("증명사진 파일이 존재하지 않습니다.".to_string());
    }

    let photo = image::open(p).map_err(|e| format!("사진을 열 수 없습니다: {e}"))?;
    let photo_rgb = photo.to_rgb8();
    let (pw, ph) = (photo_rgb.width(), photo_rgb.height());

    // 4x6인치 300DPI = 정확히 1800 x 1200 px
    let sheet_w = 1800u32;
    let sheet_h = 1200u32;
    let mut sheet = image::RgbImage::from_pixel(sheet_w, sheet_h, image::Rgb([255, 255, 255]));

    let (rows, cols) = if pw <= 360 && ph <= 480 {
        // 354x472 (3x4cm 등): 2행 4열 = 8장
        (2usize, 4usize)
    } else {
        // 413x531 (여권 등): 2행 3열 = 6장
        (2usize, 3usize)
    };

    let total_photos_w = cols as u32 * pw;
    let total_photos_h = rows as u32 * ph;

    let margin_x = (sheet_w.saturating_sub(total_photos_w)) / ((cols + 1) as u32);
    let margin_y = (sheet_h.saturating_sub(total_photos_h)) / ((rows + 1) as u32);

    let cut_mark_color = image::Rgb([180, 180, 180]); // 연한 회색 재단선

    for r in 0..rows {
        let y_pos = margin_y + (r as u32) * (ph + margin_y);
        for c in 0..cols {
            let x_pos = margin_x + (c as u32) * (pw + margin_x);

            // 사진 붙이기
            for py in 0..ph {
                for px in 0..pw {
                    let pixel = photo_rgb.get_pixel(px, py);
                    sheet.put_pixel(x_pos + px, y_pos + py, *pixel);
                }
            }

            // 테두리 재단선 (모서리 십자 마크 12px)
            let mark_len = 12u32;
            let left = x_pos;
            let right = x_pos + pw - 1;
            let top = y_pos;
            let bottom = y_pos + ph - 1;

            // 좌상단
            for i in 0..mark_len {
                if left >= i { sheet.put_pixel(left - i, top, cut_mark_color); }
                if top >= i { sheet.put_pixel(left, top - i, cut_mark_color); }
            }
            // 우상단
            for i in 0..mark_len {
                if right + i < sheet_w { sheet.put_pixel(right + i, top, cut_mark_color); }
                if top >= i { sheet.put_pixel(right, top - i, cut_mark_color); }
            }
            // 좌하단
            for i in 0..mark_len {
                if left >= i { sheet.put_pixel(left - i, bottom, cut_mark_color); }
                if bottom + i < sheet_h { sheet.put_pixel(left, bottom + i, cut_mark_color); }
            }
            // 우하단
            for i in 0..mark_len {
                if right + i < sheet_w { sheet.put_pixel(right + i, bottom, cut_mark_color); }
                if bottom + i < sheet_h { sheet.put_pixel(right, bottom + i, cut_mark_color); }
            }
        }
    }

    let mut clean_target = PathBuf::from(&target_path);
    clean_target.set_extension("jpg");
    if let Some(parent) = clean_target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let file = File::create(&clean_target).map_err(|e| format!("인화지 파일 생성 실패: {e}"))?;
    let mut writer = std::io::BufWriter::new(file);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 98);
    encoder.encode_image(&sheet).map_err(|e| format!("인화지 JPEG 저장 실패: {e}"))?;

    Ok(clean_target.to_string_lossy().into_owned())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CadConvertResult {
    pub dxf_path: String,
    pub is_cached: bool,
}

fn get_cad_cache_dir() -> PathBuf {
    let dir = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("k-boda")
        .join("cad_cache");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn get_cad_thumb_cache_dir() -> PathBuf {
    let dir = get_cad_cache_dir().join("thumbs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn find_libredwg_tool(tool_name: &str) -> Result<PathBuf, String> {
    // 1. 현재 작업 디렉터리 기준 (개발 환경)
    let dev_path = Path::new("src-tauri").join("binaries").join("libredwg").join(tool_name);
    if dev_path.exists() {
        return Ok(dev_path);
    }
    let dev_path_flat = Path::new("binaries").join("libredwg").join(tool_name);
    if dev_path_flat.exists() {
        return Ok(dev_path_flat);
    }

    // 2. 실행 파일(.exe) 디렉터리 기준 (배포 환경)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidate1 = exe_dir.join("binaries").join("libredwg").join(tool_name);
            if candidate1.exists() {
                return Ok(candidate1);
            }
            let candidate2 = exe_dir.join(tool_name);
            if candidate2.exists() {
                return Ok(candidate2);
            }
        }
    }

    // 3. PATH 환경변수 확인
    if let Ok(path_var) = std::env::var("PATH") {
        for p in std::env::split_paths(&path_var) {
            let full = p.join(tool_name);
            if full.exists() {
                return Ok(full);
            }
        }
    }

    Err(format!("LibreDWG 실행 파일({tool_name})을 찾을 수 없습니다. binaries/libredwg 폴더를 확인해 주세요."))
}

#[tauri::command]
fn convert_dwg_to_dxf(app: tauri::AppHandle, dwg_path: String) -> Result<CadConvertResult, String> {
    let src = Path::new(&dwg_path);
    if !src.exists() {
        return Err("도면 파일을 찾을 수 없습니다.".to_string());
    }

    let meta = std::fs::metadata(src).map_err(|e| format!("메타데이터 읽기 실패: {e}"))?;
    let size = meta.len();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_dir = get_cad_cache_dir();
    let _ = app.asset_protocol_scope().allow_directory(&cache_dir, true);

    let cache_filename = format!("{}.dxf", make_cache_filename(&dwg_path, modified, size));
    let cache_path = cache_dir.join(&cache_filename);

    // 3. 캐시 확인: 이미 변환된 캐시가 있으면 바로 반환!
    if cache_path.exists() {
        if let Ok(m) = std::fs::metadata(&cache_path) {
            if m.len() > 0 {
                let _ = app.asset_protocol_scope().allow_file(&cache_path);
                return Ok(CadConvertResult {
                    dxf_path: cache_path.to_string_lossy().into_owned(),
                    is_cached: true,
                });
            }
        }
    }

    // 4. dwg2dxf.exe 실행 (60초 타임아웃, 프로세스 격리)
    let tool_exe = find_libredwg_tool("dwg2dxf.exe")?;

    let temp_out = cache_path.with_extension("tmp.dxf");
    if temp_out.exists() {
        let _ = std::fs::remove_file(&temp_out);
    }

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = std::process::Command::new(&tool_exe);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.args(&[
        "-y",
        "-o",
        &temp_out.to_string_lossy(),
        &dwg_path,
    ]);

    let mut child = cmd.spawn().map_err(|e| format!("변환 프로세스 시작 실패: {e}"))?;

    let start_time = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(60);

    let mut finished = false;
    let mut exit_status = None;

    while start_time.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(status)) => {
                finished = true;
                exit_status = Some(status);
                break;
            }
            Ok(None) => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("변환기 상태 확인 오류: {e}"));
            }
        }
    }

    if !finished {
        let _ = child.kill();
        let _ = child.wait();
        if temp_out.exists() {
            let _ = std::fs::remove_file(&temp_out);
        }
        return Err("도면 변환 시간이 60초를 초과하여 중단되었습니다. (변환할 수 없는 도면)".to_string());
    }

    if temp_out.exists() {
        let _ = std::fs::rename(&temp_out, &cache_path);
        let _ = app.asset_protocol_scope().allow_file(&cache_path);
        return Ok(CadConvertResult {
            dxf_path: cache_path.to_string_lossy().into_owned(),
            is_cached: false,
        });
    }

    let code_msg = exit_status.map(|s| format!("(코드: {:?})", s.code())).unwrap_or_default();
    Err(format!("도면 변환에 실패했습니다. {code_msg} 손상되었거나 암호화된 도면일 수 있습니다."))
}

#[tauri::command]
fn read_cad_file_text(file_path: String) -> Result<String, String> {
    let p = Path::new(&file_path);
    if !p.exists() {
        return Err("도면 파일을 찾을 수 없습니다.".to_string());
    }

    let bytes = std::fs::read(p).map_err(|e| format!("도면 파일 읽기 실패: {e}"))?;

    if let Ok(text) = String::from_utf8(bytes.clone()) {
        return Ok(text);
    }

    let (decoded, _, _) = encoding_rs::EUC_KR.decode(&bytes);
    Ok(decoded.into_owned())
}

#[tauri::command]
fn get_dwg_thumbnail(app: tauri::AppHandle, path: String) -> Result<Option<String>, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(None);
    }

    let meta = match std::fs::metadata(p) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    let size = meta.len();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let thumb_dir = get_cad_thumb_cache_dir();
    let _ = app.asset_protocol_scope().allow_directory(&thumb_dir, true);

    let base_name = make_cache_filename(&path, modified, size);
    let bmp_path = thumb_dir.join(format!("{}.bmp", base_name));
    let png_path = thumb_dir.join(format!("{}.png", base_name));

    if png_path.exists() {
        let _ = app.asset_protocol_scope().allow_file(&png_path);
        return Ok(Some(png_path.to_string_lossy().into_owned()));
    }
    if bmp_path.exists() {
        let _ = app.asset_protocol_scope().allow_file(&bmp_path);
        return Ok(Some(bmp_path.to_string_lossy().into_owned()));
    }

    if let Ok(tool) = find_libredwg_tool("dwgbmp.exe") {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let mut cmd = std::process::Command::new(tool);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let bmp_path_str = bmp_path.to_string_lossy().into_owned();
        cmd.args(&[&path, &bmp_path_str]);

        if let Ok(mut child) = cmd.spawn() {
            let _ = child.wait();
        }

        if bmp_path.exists() {
            let _ = app.asset_protocol_scope().allow_file(&bmp_path);
            return Ok(Some(bmp_path.to_string_lossy().into_owned()));
        }
    }

    Ok(None)
}

#[tauri::command]
fn open_in_cad_program(file_path: String) -> Result<(), String> {
    let p = Path::new(&file_path);
    if !p.exists() {
        return Err("파일이 존재하지 않습니다.".to_string());
    }

    std::process::Command::new("cmd")
        .args(&["/c", "start", "", &file_path])
        .spawn()
        .map_err(|e| format!("프로그램을 실행할 수 없습니다: {e}"))?;

    Ok(())
}

#[tauri::command]
fn set_cad_file_association(enable: bool) -> Result<(), String> {
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = current_exe.to_string_lossy();

    let extensions = ["dwg", "dxf"];
    for ext in extensions {
        if enable {
            let _ = std::process::Command::new("reg")
                .args(&[
                    "add",
                    &format!("HKCU\\Software\\Classes\\.{}", ext),
                    "/ve",
                    "/d",
                    "k-boda.Cad",
                    "/f",
                ])
                .output();

            let _ = std::process::Command::new("reg")
                .args(&[
                    "add",
                    "HKCU\\Software\\Classes\\k-boda.Cad\\shell\\open\\command",
                    "/ve",
                    "/d",
                    &format!("\"{}\" \"%1\"", exe_str),
                    "/f",
                ])
                .output();
        } else {
            let _ = std::process::Command::new("reg")
                .args(&[
                    "delete",
                    &format!("HKCU\\Software\\Classes\\.{}", ext),
                    "/f",
                ])
                .output();
        }
    }
    Ok(())
}

pub struct InitialFile(pub Mutex<Option<String>>);

#[tauri::command]
fn get_initial_file(state: tauri::State<InitialFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[tauri::command]
fn get_next_folder_first_image(current_path: String) -> Result<Option<String>, String> {
    let target = Path::new(&current_path);
    let parent_dir = match target.parent() {
        Some(p) => p,
        None => return Ok(None),
    };
    let grandparent_dir = match parent_dir.parent() {
        Some(p) => p,
        None => return Ok(None),
    };

    let mut sibling_dirs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(grandparent_dir) {
        for entry in entries.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    sibling_dirs.push(entry.path());
                }
            }
        }
    }
    sibling_dirs.sort_by(|a, b| {
        let a_name = a.file_name().unwrap_or_default().to_string_lossy();
        let b_name = b.file_name().unwrap_or_default().to_string_lossy();
        natural_sort_key(&a_name).cmp(&natural_sort_key(&b_name))
    });

    let current_canonical = std::fs::canonicalize(parent_dir).ok();
    let current_idx = sibling_dirs.iter().position(|p| {
        if let (Some(c1), Ok(c2)) = (&current_canonical, std::fs::canonicalize(p)) {
            c1 == &c2
        } else {
            p == parent_dir
        }
    });

    if let Some(idx) = current_idx {
        for next_dir in sibling_dirs.iter().skip(idx + 1) {
            let mut images = Vec::new();
            if let Ok(entries) = std::fs::read_dir(next_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if is_supported_file(&p) {
                        images.push(p);
                    }
                }
            }
            if !images.is_empty() {
                images.sort_by(|a, b| {
                    let a_name = a.file_name().unwrap_or_default().to_string_lossy();
                    let b_name = b.file_name().unwrap_or_default().to_string_lossy();
                    natural_sort_key(&a_name).cmp(&natural_sort_key(&b_name))
                });
                return Ok(Some(images[0].to_string_lossy().into_owned()));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
fn get_prev_folder_last_image(current_path: String) -> Result<Option<String>, String> {
    let target = Path::new(&current_path);
    let parent_dir = match target.parent() {
        Some(p) => p,
        None => return Ok(None),
    };
    let grandparent_dir = match parent_dir.parent() {
        Some(p) => p,
        None => return Ok(None),
    };

    let mut sibling_dirs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(grandparent_dir) {
        for entry in entries.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    sibling_dirs.push(entry.path());
                }
            }
        }
    }
    sibling_dirs.sort_by(|a, b| {
        let a_name = a.file_name().unwrap_or_default().to_string_lossy();
        let b_name = b.file_name().unwrap_or_default().to_string_lossy();
        natural_sort_key(&a_name).cmp(&natural_sort_key(&b_name))
    });

    let current_canonical = std::fs::canonicalize(parent_dir).ok();
    let current_idx = sibling_dirs.iter().position(|p| {
        if let (Some(c1), Ok(c2)) = (&current_canonical, std::fs::canonicalize(p)) {
            c1 == &c2
        } else {
            p == parent_dir
        }
    });

    if let Some(idx) = current_idx {
        if idx > 0 {
            for prev_dir in sibling_dirs[..idx].iter().rev() {
                let mut images = Vec::new();
                if let Ok(entries) = std::fs::read_dir(prev_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if is_supported_file(&p) {
                            images.push(p);
                        }
                    }
                }
                if !images.is_empty() {
                    images.sort_by(|a, b| {
                        let a_name = a.file_name().unwrap_or_default().to_string_lossy();
                        let b_name = b.file_name().unwrap_or_default().to_string_lossy();
                        natural_sort_key(&a_name).cmp(&natural_sort_key(&b_name))
                    });
                    return Ok(Some(images.last().unwrap().to_string_lossy().into_owned()));
                }
            }
        }
    }
    Ok(None)
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", content = "data")]
pub enum UndoAction {
    Delete {
        paths: Vec<String>,
    },
    Rename {
        old_path: String,
        new_path: String,
    },
    BatchRename {
        items: Vec<(String, String)>,
    },
    Move {
        items: Vec<(String, String)>,
    },
}

pub struct UndoState(pub Mutex<Vec<UndoAction>>);

/// 과거 임시 undo_trash 폴더에 남아있던 파일이 있다면 영구 삭제 대신 윈도우 휴지통으로 이동
fn clean_legacy_undo_staging() {
    let staging_root = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("k-boda")
        .join("undo_trash");
    if staging_root.exists() {
        if let Ok(entries) = std::fs::read_dir(&staging_root) {
            let mut paths_to_trash = Vec::new();
            for entry in entries.flatten() {
                paths_to_trash.push(entry.path());
            }
            if !paths_to_trash.is_empty() {
                let _ = trash::delete_all(&paths_to_trash);
            }
        }
    }
}

fn copy_entry_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let entry_dst = dst.join(entry.file_name());
            copy_entry_recursive(&entry.path(), &entry_dst)?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

fn get_unique_target_path(target_folder: &Path, file_name: &str) -> PathBuf {
    let p = target_folder.join(file_name);
    if !p.exists() {
        return p;
    }
    let p_path = Path::new(file_name);
    let stem = p_path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = p_path.extension().and_then(|s| s.to_str());

    let mut counter = 2;
    loop {
        let new_name = match ext {
            Some(e) => format!("{} ({}).{}", stem, counter, e),
            None => format!("{} ({})", stem, counter),
        };
        let candidate = target_folder.join(&new_name);
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

fn is_windows_reserved_name(name: &str) -> bool {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .trim();
    let upper = stem.to_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    RESERVED.contains(&upper.as_str())
}

fn validate_windows_filename(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("파일 이름을 입력해 주세요.".to_string());
    }
    const FORBIDDEN_CHARS: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    for c in trimmed.chars() {
        if FORBIDDEN_CHARS.contains(&c) {
            return Err("파일 이름에 다음 문자를 포함할 수 없습니다: \\ / : * ? \" < > |".to_string());
        }
    }
    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return Err("파일 이름은 마침표(.)나 공백으로 끝날 수 없습니다.".to_string());
    }
    if is_windows_reserved_name(trimmed) {
        return Err(format!("Windows에서 예약된 파일 이름입니다: {}", trimmed));
    }
    Ok(())
}

pub struct FolderWatcherState(pub Mutex<Option<(RecommendedWatcher, String)>>);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemLocation {
    pub name: String,
    pub path: String,
    pub kind: String, // "quickAccess" | "drive"
}

#[tauri::command]
fn get_system_locations() -> Vec<SystemLocation> {
    let mut locations = Vec::new();

    // 1. 빠른 바로가기 (USERPROFILE 기반)
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let base = PathBuf::from(user_profile);

        let pictures = base.join("Pictures");
        if pictures.exists() {
            locations.push(SystemLocation {
                name: "사진".to_string(),
                path: pictures.to_string_lossy().into_owned(),
                kind: "quickAccess".to_string(),
            });
        }

        let desktop = base.join("Desktop");
        if desktop.exists() {
            locations.push(SystemLocation {
                name: "바탕 화면".to_string(),
                path: desktop.to_string_lossy().into_owned(),
                kind: "quickAccess".to_string(),
            });
        }

        let downloads = base.join("Downloads");
        if downloads.exists() {
            locations.push(SystemLocation {
                name: "다운로드".to_string(),
                path: downloads.to_string_lossy().into_owned(),
                kind: "quickAccess".to_string(),
            });
        }

        let documents = base.join("Documents");
        if documents.exists() {
            locations.push(SystemLocation {
                name: "문서".to_string(),
                path: documents.to_string_lossy().into_owned(),
                kind: "quickAccess".to_string(),
            });
        }
    }

    // 2. Windows 드라이브 목록 (A부터 Z까지 실존하는 드라이브 검색)
    for drive_letter in b'A'..=b'Z' {
        let drive_path = format!("{}:\\", drive_letter as char);
        let path = Path::new(&drive_path);
        if path.exists() {
            locations.push(SystemLocation {
                name: format!("로컬 디스크 ({}:)", drive_letter as char),
                path: drive_path,
                kind: "drive".to_string(),
            });
        }
    }

    locations
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubfolderItem {
    pub name: String,
    pub path: String,
    pub has_children: bool,
}

#[tauri::command]
fn get_subfolders(folder_path: String) -> Result<Vec<SubfolderItem>, String> {
    let p = Path::new(&folder_path);
    if !p.is_dir() {
        return Err("유효한 폴더가 아닙니다.".to_string());
    }

    let mut subfolders = Vec::new();
    if let Ok(entries) = std::fs::read_dir(p) {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if file_name.starts_with('.') || file_name.starts_with('$') {
                continue;
            }

            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    let sub_path = entry.path();
                    let mut has_children = false;
                    if let Ok(mut sub_entries) = std::fs::read_dir(&sub_path) {
                        while let Some(Ok(sub_e)) = sub_entries.next() {
                            let sn = sub_e.file_name().to_string_lossy().into_owned();
                            if !sn.starts_with('.') && !sn.starts_with('$') {
                                if let Ok(sft) = sub_e.file_type() {
                                    if sft.is_dir() {
                                        has_children = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    subfolders.push(SubfolderItem {
                        name: file_name,
                        path: sub_path.to_string_lossy().into_owned(),
                        has_children,
                    });
                }
            }
        }
    }

    subfolders.sort_by(|a, b| natural_sort_key(&a.name).cmp(&natural_sort_key(&b.name)));
    Ok(subfolders)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerItem {
    pub name: String,
    pub path: String,
    pub kind: String, // "folder" | "archive" | "image"
    pub size: u64,
    pub modified: u64,
    pub extension: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerFolderResult {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub items: Vec<ExplorerItem>,
    pub total_folders: usize,
    pub total_images: usize,
    pub total_archives: usize,
}

#[tauri::command]
fn scan_explorer_folder(
    app: tauri::AppHandle,
    folder_path: String,
    sort_by: Option<SortBy>,
    sort_order: Option<SortOrder>,
) -> Result<ExplorerFolderResult, String> {
    let p = Path::new(&folder_path);
    if !p.exists() || !p.is_dir() {
        return Err("폴더를 찾을 수 없습니다.".to_string());
    }

    let parent_path = p.parent().map(|par| par.to_string_lossy().into_owned());
    let _ = app.asset_protocol_scope().allow_directory(p, true);
    let sort_by = sort_by.unwrap_or(SortBy::Name);
    let sort_order = sort_order.unwrap_or(SortOrder::Asc);

    let mut folders = Vec::new();
    let mut files = Vec::new();

    let mut total_folders = 0;
    let mut total_images = 0;
    let mut total_archives = 0;

    if let Ok(entries) = std::fs::read_dir(p) {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if file_name.starts_with('.') || file_name.starts_with('$') {
                continue;
            }

            let entry_path = entry.path();
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            if metadata.is_dir() {
                total_folders += 1;
                folders.push(ExplorerItem {
                    name: file_name,
                    path: entry_path.to_string_lossy().into_owned(),
                    kind: "folder".to_string(),
                    size: 0,
                    modified,
                    extension: String::new(),
                });
            } else if metadata.is_file() {
                let ext = entry_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase())
                    .unwrap_or_default();

                let is_image = IMAGE_EXTENSIONS.contains(&ext.as_str());
                let is_archive = ext == "zip" || ext == "cbz";
                let is_cad = CAD_EXTENSIONS.contains(&ext.as_str());

                if is_image || is_archive || is_cad {
                    // asset 프로토콜에 허용
                    let _ = app.asset_protocol_scope().allow_file(&entry_path);

                    let kind = if is_archive {
                        total_archives += 1;
                        "archive"
                    } else if is_cad {
                        "cad"
                    } else {
                        total_images += 1;
                        "image"
                    };

                    files.push(ExplorerItem {
                        name: file_name,
                        path: entry_path.to_string_lossy().into_owned(),
                        kind: kind.to_string(),
                        size: metadata.len(),
                        modified,
                        extension: ext,
                    });
                }
            }
        }
    }

    let sort_items = |items: &mut Vec<ExplorerItem>| {
        items.sort_by(|a, b| {
            let cmp = match sort_by {
                SortBy::Name => natural_sort_key(&a.name).cmp(&natural_sort_key(&b.name)),
                SortBy::DateModified => a.modified.cmp(&b.modified).then_with(|| natural_sort_key(&a.name).cmp(&natural_sort_key(&b.name))),
                SortBy::DateTaken => {
                    let dt_a = get_exif_date_taken(&a.path);
                    let dt_b = get_exif_date_taken(&b.path);
                    match (dt_a, dt_b) {
                        (Some(da), Some(db)) => da.cmp(&db),
                        (Some(_), None) => Ordering::Less,
                        (None, Some(_)) => Ordering::Greater,
                        (None, None) => a.modified.cmp(&b.modified),
                    }
                }
                SortBy::FileSize => a.size.cmp(&b.size).then_with(|| natural_sort_key(&a.name).cmp(&natural_sort_key(&b.name))),
                SortBy::FileType => a.extension.cmp(&b.extension).then_with(|| natural_sort_key(&a.name).cmp(&natural_sort_key(&b.name))),
            };
            if sort_order == SortOrder::Desc {
                cmp.reverse()
            } else {
                cmp
            }
        });
    };

    sort_items(&mut folders);
    sort_items(&mut files);

    let mut all_items = folders;
    all_items.extend(files);

    Ok(ExplorerFolderResult {
        current_path: folder_path,
        parent_path,
        items: all_items,
        total_folders,
        total_images,
        total_archives,
    })
}

#[tauri::command]
fn delete_paths_to_trash(
    paths: Vec<String>,
    undo_state: tauri::State<UndoState>,
) -> Result<(), String> {
    let mut valid_paths = Vec::new();
    for p_str in paths {
        let p = Path::new(&p_str);
        if p.exists() {
            valid_paths.push(p_str);
        }
    }

    if valid_paths.is_empty() {
        return Ok(());
    }

    // 실제 윈도우 휴지통으로 이동 (규칙 2: 영구 삭제 금지, 휴지통 전송)
    let path_refs: Vec<&Path> = valid_paths.iter().map(|s| Path::new(s.as_str())).collect();
    trash::delete_all(&path_refs).map_err(|e| format!("휴지통으로 이동 실패: {e}"))?;

    let mut stack = undo_state.0.lock().map_err(|e| e.to_string())?;
    stack.push(UndoAction::Delete { paths: valid_paths });
    while stack.len() > 20 {
        stack.remove(0);
    }

    Ok(())
}

#[tauri::command]
fn undo_last_action(undo_state: tauri::State<UndoState>) -> Result<String, String> {
    let mut stack = undo_state.0.lock().map_err(|e| e.to_string())?;
    let action = match stack.pop() {
        Some(a) => a,
        None => return Err("되돌릴 작업이 없습니다.".to_string()),
    };

    match action {
        UndoAction::Delete { paths } => {
            let mut restored_count = 0;
            // 윈도우 휴지통 목록에서 원래 경로와 일치하는 항목 찾아 복원 시도
            if let Ok(trash_items) = trash::os_limited::list() {
                let mut to_restore = Vec::new();
                for orig_p_str in &paths {
                    let orig_p = Path::new(orig_p_str);
                    if let Some(item) = trash_items.iter().rev().find(|t| {
                        // trash::TrashItem은 original_path() 메서드를 제공
                        t.original_path() == orig_p
                    }) {
                        to_restore.push(item.clone());
                    }
                }
                if !to_restore.is_empty() {
                    if trash::os_limited::restore_all(to_restore).is_ok() {
                        restored_count = paths.len();
                    }
                }
            }

            if restored_count > 0 {
                Ok(format!("삭제된 항목 {}개를 휴지통에서 원래 위치로 복원했습니다.", restored_count))
            } else {
                Ok(format!(
                    "{}개 항목의 삭제 기록을 되돌렸습니다. (직접 복원은 윈도우 휴지통에서 가능합니다)",
                    paths.len()
                ))
            }
        }
        UndoAction::Rename { old_path, new_path } => {
            let old_p = Path::new(&old_path);
            let new_p = Path::new(&new_path);
            if !new_p.exists() {
                return Err("되돌릴 대상 파일이 존재하지 않습니다.".to_string());
            }
            std::fs::rename(new_p, old_p)
                .map_err(|e| format!("이름 바꾸기 되돌리기 실패: {}", e))?;
            let name = old_p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            Ok(format!("'{}'(으)로 이름을 되돌렸습니다.", name))
        }
        UndoAction::BatchRename { items } => {
            let mut restored_count = 0;
            for (old_p_str, new_p_str) in items.into_iter().rev() {
                let old_p = Path::new(&old_p_str);
                let new_p = Path::new(&new_p_str);
                if new_p.exists() {
                    if std::fs::rename(new_p, old_p).is_ok() {
                        restored_count += 1;
                    }
                }
            }
            Ok(format!("이름 변경된 파일 {}개를 원래 이름으로 되돌렸습니다.", restored_count))
        }
        UndoAction::Move { items } => {
            let mut restored_count = 0;
            for (orig_p_str, dest_p_str) in items {
                let orig_p = Path::new(&orig_p_str);
                let dest_p = Path::new(&dest_p_str);
                if dest_p.exists() {
                    if let Some(parent) = orig_p.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if std::fs::rename(dest_p, orig_p).is_ok() {
                        restored_count += 1;
                    } else if copy_entry_recursive(dest_p, orig_p).is_ok() {
                        let _ = if dest_p.is_dir() {
                            std::fs::remove_dir_all(dest_p)
                        } else {
                            std::fs::remove_file(dest_p)
                        };
                        restored_count += 1;
                    }
                }
            }
            Ok(format!("이동된 항목 {}개를 원래 위치로 되돌렸습니다.", restored_count))
        }
    }
}

#[tauri::command]
fn rename_file(
    old_path: String,
    new_name: String,
    undo_state: tauri::State<UndoState>,
) -> Result<String, String> {
    validate_windows_filename(&new_name)?;

    let old_p = Path::new(&old_path);
    if !old_p.exists() {
        return Err("변경할 파일이 존재하지 않습니다.".to_string());
    }

    let parent = old_p
        .parent()
        .ok_or_else(|| "부모 디렉터리를 찾을 수 없습니다.".to_string())?;
    let new_p = parent.join(&new_name);

    if new_p.exists() && old_p != new_p {
        return Err("같은 이름의 파일이 이미 존재합니다.".to_string());
    }

    std::fs::rename(old_p, &new_p).map_err(|e| format!("이름 변경 실패: {}", e))?;

    let new_path_str = new_p.to_string_lossy().into_owned();

    let mut stack = undo_state.0.lock().map_err(|e| e.to_string())?;
    stack.push(UndoAction::Rename {
        old_path: old_path.clone(),
        new_path: new_path_str.clone(),
    });
    while stack.len() > 20 {
        stack.remove(0);
    }

    Ok(new_path_str)
}

#[tauri::command]
fn copy_files_to_folder(
    source_paths: Vec<String>,
    target_folder: String,
    conflict_mode: String,
) -> Result<Vec<String>, String> {
    let target_dir = Path::new(&target_folder);
    if !target_dir.exists() {
        std::fs::create_dir_all(target_dir).map_err(|e| format!("대상 폴더 생성 실패: {}", e))?;
    }

    let mut copied_paths = Vec::new();

    for src_str in source_paths {
        let src_p = Path::new(&src_str);
        if !src_p.exists() {
            continue;
        }
        let file_name = match src_p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };

        let dest_p = match conflict_mode.as_str() {
            "overwrite" => {
                let p = target_dir.join(file_name);
                if p.exists() && p != src_p {
                    // 기존 대상 파일을 영구 삭제하지 않고 휴지통으로 안전 이동
                    let _ = trash::delete(&p);
                }
                p
            }
            "skip" => {
                let p = target_dir.join(file_name);
                if p.exists() {
                    continue;
                }
                p
            }
            "rename" | _ => get_unique_target_path(target_dir, file_name),
        };

        if src_p == dest_p {
            continue;
        }

        if let Err(e) = copy_entry_recursive(src_p, &dest_p) {
            return Err(format!("파일 복사 실패 ({}): {}", file_name, e));
        }

        copied_paths.push(dest_p.to_string_lossy().into_owned());
    }

    Ok(copied_paths)
}

#[tauri::command]
fn move_files_to_folder(
    source_paths: Vec<String>,
    target_folder: String,
    conflict_mode: String,
    undo_state: tauri::State<UndoState>,
) -> Result<Vec<String>, String> {
    let target_dir = Path::new(&target_folder);
    if !target_dir.exists() {
        std::fs::create_dir_all(target_dir).map_err(|e| format!("대상 폴더 생성 실패: {}", e))?;
    }

    let mut moved_paths = Vec::new();
    let mut undo_moves = Vec::new();

    for src_str in source_paths {
        let src_p = Path::new(&src_str);
        if !src_p.exists() {
            continue;
        }
        let file_name = match src_p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };

        let dest_p = match conflict_mode.as_str() {
            "overwrite" => {
                let p = target_dir.join(file_name);
                if p.exists() && p != src_p {
                    // 기존 대상 파일을 영구 삭제하지 않고 휴지통으로 안전 이동
                    let _ = trash::delete(&p);
                }
                p
            }
            "skip" => {
                let p = target_dir.join(file_name);
                if p.exists() {
                    continue;
                }
                p
            }
            "rename" | _ => get_unique_target_path(target_dir, file_name),
        };

        if src_p == dest_p {
            continue;
        }

        let moved = if std::fs::rename(src_p, &dest_p).is_ok() {
            true
        } else if copy_entry_recursive(src_p, &dest_p).is_ok() {
            // 다른 드라이브 간 이동 시 원본은 영구 삭제하지 않고 휴지통으로 이동
            let _ = trash::delete(src_p);
            true
        } else {
            false
        };

        if moved {
            let dest_str = dest_p.to_string_lossy().into_owned();
            undo_moves.push((src_str, dest_str.clone()));
            moved_paths.push(dest_str);
        }
    }

    if !undo_moves.is_empty() {
        let mut stack = undo_state.0.lock().map_err(|e| e.to_string())?;
        stack.push(UndoAction::Move { items: undo_moves });
        while stack.len() > 20 {
            stack.remove(0);
        }
    }

    Ok(moved_paths)
}

#[tauri::command]
fn create_new_folder(parent_path: String, folder_name: Option<String>) -> Result<String, String> {
    let parent = Path::new(&parent_path);
    if !parent.is_dir() {
        return Err("상위 폴더가 존재하지 않습니다.".to_string());
    }

    let base_name = folder_name.unwrap_or_else(|| "새 폴더".to_string());
    let mut candidate = parent.join(&base_name);
    let mut counter = 2;
    while candidate.exists() {
        candidate = parent.join(format!("{} ({})", base_name, counter));
        counter += 1;
    }

    std::fs::create_dir(&candidate).map_err(|e| format!("새 폴더 생성 실패: {}", e))?;
    Ok(candidate.to_string_lossy().into_owned())
}

#[tauri::command]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut utf16_bytes: Vec<u16> = Vec::new();
    for p in paths {
        utf16_bytes.extend(p.encode_utf16());
        utf16_bytes.push(0);
    }
    utf16_bytes.push(0);

    let dropfiles_size = std::mem::size_of::<DROPFILES>();
    let total_bytes = dropfiles_size + (utf16_bytes.len() * 2);

    unsafe {
        let h_mem = GlobalAlloc(GMEM_MOVEABLE, total_bytes);
        if h_mem.is_null() {
            return Err("클립보드 메모리 할당 실패".to_string());
        }

        let ptr = GlobalLock(h_mem) as *mut u8;
        if ptr.is_null() {
            return Err("클립보드 메모리 잠금 실패".to_string());
        }

        let df = DROPFILES {
            pFiles: dropfiles_size as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: 0,
            fWide: 1,
        };

        std::ptr::copy_nonoverlapping(&df as *const _ as *const u8, ptr, dropfiles_size);
        std::ptr::copy_nonoverlapping(
            utf16_bytes.as_ptr() as *const u8,
            ptr.add(dropfiles_size),
            utf16_bytes.len() * 2,
        );

        GlobalUnlock(h_mem);

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("클립보드를 열 수 없습니다.".to_string());
        }

        EmptyClipboard();
        const CF_HDROP: u32 = 15;
        let res = SetClipboardData(CF_HDROP, h_mem);
        CloseClipboard();

        if res.is_null() {
            return Err("클립보드 데이터 설정 실패".to_string());
        }
    }

    Ok(())
}

#[tauri::command]
fn paste_files_from_clipboard(
    target_folder: String,
    _undo_state: tauri::State<UndoState>,
) -> Result<Vec<String>, String> {
    const CF_HDROP: u32 = 15;
    let paths = unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return Ok(Vec::new());
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("클립보드를 열 수 없습니다.".to_string());
        }
        let h_data = GetClipboardData(CF_HDROP);
        if h_data.is_null() {
            CloseClipboard();
            return Ok(Vec::new());
        }

        let ptr = GlobalLock(h_data) as *const u8;
        if ptr.is_null() {
            CloseClipboard();
            return Ok(Vec::new());
        }

        let df = &*(ptr as *const DROPFILES);
        let files_offset = df.pFiles as usize;
        let is_wide = df.fWide != 0;

        let mut extracted_paths = Vec::new();
        if is_wide {
            let u16_ptr = ptr.add(files_offset) as *const u16;
            let mut i = 0;
            loop {
                let start = i;
                while *u16_ptr.add(i) != 0 {
                    i += 1;
                }
                if i == start {
                    break;
                }
                let slice = std::slice::from_raw_parts(u16_ptr.add(start), i - start);
                let path_str = String::from_utf16_lossy(slice);
                extracted_paths.push(path_str);
                i += 1;
            }
        }

        GlobalUnlock(h_data);
        CloseClipboard();
        extracted_paths
    };

    if paths.is_empty() {
        return Ok(Vec::new());
    }

    copy_files_to_folder(paths, target_folder, "rename".to_string())
}

#[tauri::command]
fn open_in_external_editor(path: String, custom_app: Option<String>) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("파일이 존재하지 않습니다.".to_string());
    }

    if let Some(app) = custom_app {
        if !app.trim().is_empty() {
            std::process::Command::new(app)
                .arg(&path)
                .spawn()
                .map_err(|e| format!("외부 편집기를 실행할 수 없습니다: {}", e))?;
            return Ok(());
        }
    }

    if std::process::Command::new("mspaint").arg(&path).spawn().is_err() {
        std::process::Command::new("cmd")
            .args(&["/c", "start", "", &path])
            .spawn()
            .map_err(|e| format!("기본 프로그램을 실행할 수 없습니다: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
fn set_as_desktop_wallpaper(
    app: tauri::AppHandle,
    image_path: String,
    style: String,
    is_archive: bool,
    archive_path: Option<String>,
    entry_name: Option<String>,
) -> Result<(), String> {
    let resolved_path = if is_archive {
        if let (Some(arch), Some(entry)) = (archive_path, entry_name) {
            get_archive_entry_image(app, arch, entry)?
        } else {
            return Err("압축 파일 정보를 찾을 수 없습니다.".to_string());
        }
    } else {
        image_path
    };

    let p = Path::new(&resolved_path);
    if !p.exists() {
        return Err("이미지 파일이 존재하지 않습니다.".to_string());
    }

    let style_val = match style.as_str() {
        "fit" => "6",
        "center" => "0",
        "fill" | _ => "10",
    };

    let _ = std::process::Command::new("reg")
        .args(&[
            "add",
            "HKCU\\Control Panel\\Desktop",
            "/v",
            "WallpaperStyle",
            "/t",
            "REG_SZ",
            "/d",
            style_val,
            "/f",
        ])
        .output();

    let _ = std::process::Command::new("reg")
        .args(&[
            "add",
            "HKCU\\Control Panel\\Desktop",
            "/v",
            "TileWallpaper",
            "/t",
            "REG_SZ",
            "/d",
            "0",
            "/f",
        ])
        .output();

    let mut wide_path: Vec<u16> = resolved_path.encode_utf16().collect();
    wide_path.push(0);

    unsafe {
        let ret = SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            wide_path.as_ptr() as *mut _,
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        );
        if ret == 0 {
            return Err("바탕화면 배경 설정 실패".to_string());
        }
    }

    Ok(())
}

#[tauri::command]
fn save_clipboard_image(base64_data: String, target_path: String) -> Result<String, String> {
    use std::io::Write;
    let target = Path::new(&target_path);
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let raw_b64 = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw_b64.trim())
        .map_err(|e| format!("Base64 디코딩 실패: {}", e))?;

    let mut file = File::create(target).map_err(|e| format!("파일 생성 실패: {}", e))?;
    file.write_all(&bytes).map_err(|e| format!("파일 쓰기 실패: {}", e))?;

    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn check_path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn watch_folder(
    app: tauri::AppHandle,
    state: tauri::State<FolderWatcherState>,
    folder_path: String,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    if let Some((_, current)) = &*guard {
        if current == &folder_path {
            return Ok(());
        }
    }

    *guard = None;

    let path = Path::new(&folder_path);
    if !path.is_dir() {
        return Err("유효한 폴더가 아닙니다.".to_string());
    }

    let app_handle = app.clone();
    let watched_path_clone = folder_path.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                match event.kind {
                    EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_) => {
                        let _ = app_handle.emit("folder-changed", &watched_path_clone);
                    }
                    _ => {}
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(path, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    *guard = Some((watcher, folder_path));
    Ok(())
}

#[tauri::command]
fn unwatch_folder(state: tauri::State<FolderWatcherState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

// -------------------------------------------------------------
// 14단계 B: 탐색기 모드 다중 파일 일괄 작업 (변환, 이름바꾸기, 회전)
// -------------------------------------------------------------

pub struct BatchTaskManager {
    pub cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl BatchTaskManager {
    pub fn new() -> Self {
        Self {
            cancel_flags: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchConvertOptions {
    pub task_id: String,
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub format: String,
    pub quality: u8,
    pub resize_mode: String,
    pub long_edge_px: Option<u32>,
    pub percent: Option<f64>,
    pub max_kb_limit: Option<u32>,
    pub keep_exif: bool,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchRotateOptions {
    pub task_id: String,
    pub source_paths: Vec<String>,
    pub output_dir: String,
    pub mode: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameItem {
    pub old_path: String,
    pub new_name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailureItem {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgressPayload {
    pub task_id: String,
    pub total: usize,
    pub current_index: usize,
    pub current_name: String,
    pub success_count: usize,
    pub failure_count: usize,
    pub is_finished: bool,
    pub is_cancelled: bool,
    pub failures: Vec<BatchFailureItem>,
    pub output_dir: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameResult {
    pub success_count: usize,
    pub failure_count: usize,
    pub failures: Vec<BatchFailureItem>,
}

fn read_exif_orientation(p: &Path) -> u32 {
    if let Ok(file) = File::open(p) {
        let mut buf_reader = BufReader::new(file);
        let exifreader = exif::Reader::new();
        if let Ok(exif_data) = exifreader.read_from_container(&mut buf_reader) {
            if let Some(f) = exif_data.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
                return match f.value {
                    exif::Value::Short(ref v) => v.first().copied().unwrap_or(1) as u32,
                    _ => 1,
                };
            }
        }
    }
    1
}

fn apply_exif_orientation(mut img: image::DynamicImage, orientation: u32) -> image::DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => {
            img = img.rotate90();
            img.fliph()
        }
        6 => img.rotate90(),
        7 => {
            img = img.rotate270();
            img.fliph()
        }
        8 => img.rotate270(),
        _ => img,
    }
}

fn days_to_ymd(days: i64) -> (i64, i64, i64) {
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1024 + doe / 1461 - doe / 142401) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as i64;
    let m = (mp as i64 + if mp < 10 { 3 } else { -9 }) as i64;
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

#[tauri::command]
fn get_batch_file_dates(paths: Vec<String>) -> HashMap<String, String> {
    let mut results = HashMap::new();
    for p_str in paths {
        let p = Path::new(&p_str);
        if !p.exists() {
            continue;
        }

        let mut date_str: Option<String> = None;

        if let Ok(file) = File::open(p) {
            let mut buf_reader = BufReader::new(file);
            let exifreader = exif::Reader::new();
            if let Ok(exif_data) = exifreader.read_from_container(&mut buf_reader) {
                if let Some(f) = exif_data.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
                    let raw = f.display_value().to_string();
                    let trimmed = raw.trim_matches('"');
                    if trimmed.len() >= 10 {
                        let y = &trimmed[0..4];
                        let m = &trimmed[5..7];
                        let d = &trimmed[8..10];
                        date_str = Some(format!("{}-{}-{}", y, m, d));
                    }
                }
            }
        }

        if date_str.is_none() {
            if let Ok(meta) = p.metadata() {
                if let Ok(mtime) = meta.modified() {
                    let d = mtime.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                    let days = (d / 86400) as i64;
                    let (y, m, day) = days_to_ymd(days);
                    date_str = Some(format!("{:04}-{:02}-{:02}", y, m, day));
                }
            }
        }

        if let Some(d) = date_str {
            results.insert(p_str, d);
        }
    }
    results
}

#[tauri::command]
fn cancel_batch_task(
    manager: tauri::State<BatchTaskManager>,
    task_id: String,
) -> Result<(), String> {
    if let Ok(flags) = manager.cancel_flags.lock() {
        if let Some(flag) = flags.get(&task_id) {
            flag.store(true, AtomicOrdering::Relaxed);
        }
    }
    Ok(())
}

#[tauri::command]
fn execute_batch_rename(
    undo_state: tauri::State<UndoState>,
    items: Vec<BatchRenameItem>,
) -> Result<BatchRenameResult, String> {
    let mut staged_renames = Vec::new();
    let mut failures = Vec::new();

    for item in items {
        if let Err(e) = validate_windows_filename(&item.new_name) {
            failures.push(BatchFailureItem {
                path: item.old_path.clone(),
                error: e,
            });
            continue;
        }

        let old_p = Path::new(&item.old_path);
        if !old_p.exists() {
            failures.push(BatchFailureItem {
                path: item.old_path.clone(),
                error: "원본 파일이 존재하지 않습니다.".to_string(),
            });
            continue;
        }

        let parent = match old_p.parent() {
            Some(p) => p,
            None => {
                failures.push(BatchFailureItem {
                    path: item.old_path.clone(),
                    error: "상위 디렉터리를 찾을 수 없습니다.".to_string(),
                });
                continue;
            }
        };

        let new_p = parent.join(&item.new_name);

        if old_p == new_p {
            staged_renames.push((item.old_path.clone(), new_p.to_string_lossy().into_owned()));
            continue;
        }

        if new_p.exists() {
            failures.push(BatchFailureItem {
                path: item.old_path.clone(),
                error: format!("'{}' 파일이 이미 존재합니다.", item.new_name),
            });
            continue;
        }

        match std::fs::rename(old_p, &new_p) {
            Ok(_) => {
                staged_renames.push((item.old_path.clone(), new_p.to_string_lossy().into_owned()));
            }
            Err(e) => {
                failures.push(BatchFailureItem {
                    path: item.old_path.clone(),
                    error: format!("이름 변경 실패: {e}"),
                });
            }
        }
    }

    let success_count = staged_renames.len();
    let failure_count = failures.len();

    if !staged_renames.is_empty() {
        if let Ok(mut stack) = undo_state.0.lock() {
            stack.push(UndoAction::BatchRename { items: staged_renames });
            while stack.len() > 20 {
                stack.remove(0);
            }
        }
    }

    Ok(BatchRenameResult {
        success_count,
        failure_count,
        failures,
    })
}

fn process_single_convert(src_p: &Path, opts: &BatchConvertOptions) -> Result<PathBuf, String> {
    if !src_p.exists() {
        return Err("파일이 존재하지 않습니다.".to_string());
    }

    let mut img = image::open(src_p).map_err(|e| format!("이미지를 열 수 없습니다: {e}"))?;

    // EXIF 센서 방향 태그에 맞춰 자동 회전
    let orientation = read_exif_orientation(src_p);
    if orientation > 1 {
        img = apply_exif_orientation(img, orientation);
    }

    let (w, h) = (img.width(), img.height());

    // 1. 크기 조정 (고품질 Lanczos3 필터)
    if opts.resize_mode == "long_edge" {
        if let Some(target_edge) = opts.long_edge_px {
            if target_edge > 0 {
                let max_edge = w.max(h) as f64;
                if max_edge > 0.0 {
                    let scale = (target_edge as f64) / max_edge;
                    let new_w = (w as f64 * scale).round().max(1.0) as u32;
                    let new_h = (h as f64 * scale).round().max(1.0) as u32;
                    if new_w != w || new_h != h {
                        img = img.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3);
                    }
                }
            }
        }
    } else if opts.resize_mode == "percent" {
        if let Some(pct) = opts.percent {
            if pct > 0.0 && (pct - 100.0).abs() > 0.01 {
                let scale = pct / 100.0;
                let new_w = (w as f64 * scale).round().max(1.0) as u32;
                let new_h = (h as f64 * scale).round().max(1.0) as u32;
                img = img.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3);
            }
        }
    }

    // 2. 출력 파일명 생성
    let stem = src_p.file_stem().unwrap_or_default().to_string_lossy();
    let ext = match opts.format.to_lowercase().as_str() {
        "png" => "png",
        "webp" => "webp",
        _ => "jpg",
    };
    let target_path = Path::new(&opts.output_dir).join(format!("{}.{}", stem, ext));

    // 3. 인코딩 및 최대 용량(KB) 제한 처리
    let max_bytes = opts.max_kb_limit.map(|kb| (kb as u64) * 1024);
    let fmt_lower = opts.format.to_lowercase();
    let mut encoded_bytes: Vec<u8> = Vec::new();

    match fmt_lower.as_str() {
        "png" => {
            let mut cur = std::io::Cursor::new(&mut encoded_bytes);
            img.write_to(&mut cur, image::ImageFormat::Png)
                .map_err(|e| format!("PNG 인코딩 실패: {e}"))?;
        }
        "webp" => {
            let mut cur = std::io::Cursor::new(&mut encoded_bytes);
            img.write_to(&mut cur, image::ImageFormat::WebP)
                .map_err(|e| format!("WebP 인코딩 실패: {e}"))?;
        }
        _ => {
            let rgb = img.to_rgb8();
            let mut current_q = opts.quality.clamp(1, 100);

            loop {
                encoded_bytes.clear();
                {
                    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(
                        &mut encoded_bytes,
                        current_q,
                    );
                    enc.encode(
                        rgb.as_raw(),
                        rgb.width(),
                        rgb.height(),
                        image::ExtendedColorType::Rgb8,
                    )
                    .map_err(|e| format!("JPEG 인코딩 실패: {e}"))?;
                }

                if let Some(max_b) = max_bytes {
                    if (encoded_bytes.len() as u64) <= max_b || current_q <= 10 {
                        break;
                    }
                    current_q = if current_q > 30 {
                        current_q - 10
                    } else {
                        current_q - 5
                    };
                } else {
                    break;
                }
            }

            // 품질 10으로도 max_bytes를 초과하면 해상도를 점진적으로 축소
            if let Some(max_b) = max_bytes {
                let mut current_rgb = rgb;
                while (encoded_bytes.len() as u64) > max_b
                    && current_rgb.width() > 100
                    && current_rgb.height() > 100
                {
                    let nw = (current_rgb.width() as f64 * 0.85).round() as u32;
                    let nh = (current_rgb.height() as f64 * 0.85).round() as u32;
                    let resized_dyn = image::DynamicImage::ImageRgb8(current_rgb).resize_exact(
                        nw,
                        nh,
                        image::imageops::FilterType::Triangle,
                    );
                    current_rgb = resized_dyn.to_rgb8();
                    encoded_bytes.clear();
                    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(
                        &mut encoded_bytes,
                        20,
                    );
                    enc.encode(
                        current_rgb.as_raw(),
                        current_rgb.width(),
                        current_rgb.height(),
                        image::ExtendedColorType::Rgb8,
                    )
                    .map_err(|e| format!("JPEG 압축 실패: {e}"))?;
                }
            }
        }
    }

    std::fs::write(&target_path, &encoded_bytes)
        .map_err(|e| format!("파일 저장 실패: {e}"))?;

    Ok(target_path)
}

fn run_batch_convert(
    app: tauri::AppHandle,
    cancel_flag: Arc<AtomicBool>,
    opts: BatchConvertOptions,
) {
    let total = opts.source_paths.len();
    let out_dir = Path::new(&opts.output_dir);
    if let Err(e) = std::fs::create_dir_all(out_dir) {
        let payload = BatchProgressPayload {
            task_id: opts.task_id.clone(),
            total,
            current_index: 0,
            current_name: String::new(),
            success_count: 0,
            failure_count: total,
            is_finished: true,
            is_cancelled: false,
            failures: vec![BatchFailureItem {
                path: opts.output_dir.clone(),
                error: format!("출력 폴더 생성 실패: {e}"),
            }],
            output_dir: opts.output_dir.clone(),
        };
        let _ = app.emit("batch-progress", payload);
        return;
    }

    let _ = app.asset_protocol_scope().allow_directory(out_dir, true);

    let items: Arc<Mutex<Vec<(usize, String)>>> = Arc::new(Mutex::new(
        opts.source_paths.iter().cloned().enumerate().collect(),
    ));
    let success_count = Arc::new(AtomicUsize::new(0));
    let failure_count = Arc::new(AtomicUsize::new(0));
    let failures: Arc<Mutex<Vec<BatchFailureItem>>> = Arc::new(Mutex::new(Vec::new()));

    let num_workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);

    std::thread::scope(|s| {
        for _ in 0..num_workers {
            let items = Arc::clone(&items);
            let success_count = Arc::clone(&success_count);
            let failure_count = Arc::clone(&failure_count);
            let failures = Arc::clone(&failures);
            let cancel_flag = Arc::clone(&cancel_flag);
            let app = app.clone();
            let opts = opts.clone();

            s.spawn(move || {
                loop {
                    if cancel_flag.load(AtomicOrdering::Relaxed) {
                        break;
                    }

                    let next_item = {
                        let mut lock = items.lock().unwrap();
                        lock.pop()
                    };

                    let (_idx, src_path) = match next_item {
                        Some(item) => item,
                        None => break,
                    };

                    let src_p = Path::new(&src_path);
                    let file_name = src_p
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "image".to_string());

                    let res = process_single_convert(&src_p, &opts);
                    match res {
                        Ok(target_path) => {
                            let _ = app.asset_protocol_scope().allow_file(&target_path);
                            let s = success_count.fetch_add(1, AtomicOrdering::Relaxed) + 1;
                            let f = failure_count.load(AtomicOrdering::Relaxed);
                            let payload = BatchProgressPayload {
                                task_id: opts.task_id.clone(),
                                total,
                                current_index: s + f,
                                current_name: file_name,
                                success_count: s,
                                failure_count: f,
                                is_finished: false,
                                is_cancelled: false,
                                failures: Vec::new(),
                                output_dir: opts.output_dir.clone(),
                            };
                            let _ = app.emit("batch-progress", payload);
                        }
                        Err(e) => {
                            let f = failure_count.fetch_add(1, AtomicOrdering::Relaxed) + 1;
                            let s = success_count.load(AtomicOrdering::Relaxed);
                            {
                                let mut fl = failures.lock().unwrap();
                                fl.push(BatchFailureItem {
                                    path: src_path.clone(),
                                    error: e,
                                });
                            }
                            let payload = BatchProgressPayload {
                                task_id: opts.task_id.clone(),
                                total,
                                current_index: s + f,
                                current_name: file_name,
                                success_count: s,
                                failure_count: f,
                                is_finished: false,
                                is_cancelled: false,
                                failures: Vec::new(),
                                output_dir: opts.output_dir.clone(),
                            };
                            let _ = app.emit("batch-progress", payload);
                        }
                    }
                }
            });
        }
    });

    let is_cancelled = cancel_flag.load(AtomicOrdering::Relaxed);
    let final_failures = failures.lock().unwrap().clone();
    let s = success_count.load(AtomicOrdering::Relaxed);
    let f = failure_count.load(AtomicOrdering::Relaxed);

    let final_payload = BatchProgressPayload {
        task_id: opts.task_id.clone(),
        total,
        current_index: s + f,
        current_name: String::new(),
        success_count: s,
        failure_count: f,
        is_finished: true,
        is_cancelled,
        failures: final_failures,
        output_dir: opts.output_dir.clone(),
    };
    let _ = app.emit("batch-progress", final_payload);

    if let Some(manager) = app.try_state::<BatchTaskManager>() {
        if let Ok(mut map) = manager.cancel_flags.lock() {
            map.remove(&opts.task_id);
        }
    }
}

#[tauri::command]
fn start_batch_convert(
    app: tauri::AppHandle,
    manager: tauri::State<BatchTaskManager>,
    opts: BatchConvertOptions,
) -> Result<(), String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = manager.cancel_flags.lock() {
        map.insert(opts.task_id.clone(), cancel_flag.clone());
    }

    std::thread::spawn(move || {
        run_batch_convert(app, cancel_flag, opts);
    });

    Ok(())
}

fn process_single_rotate(src_p: &Path, opts: &BatchRotateOptions) -> Result<PathBuf, String> {
    if !src_p.exists() {
        return Err("파일이 존재하지 않습니다.".to_string());
    }

    let mut img = image::open(src_p).map_err(|e| format!("이미지를 열 수 없습니다: {e}"))?;

    match opts.mode.as_str() {
        "exif_auto" => {
            let orientation = read_exif_orientation(src_p);
            if orientation > 1 {
                img = apply_exif_orientation(img, orientation);
            }
        }
        "rotate90" => {
            img = img.rotate90();
        }
        "rotate180" => {
            img = img.rotate180();
        }
        "rotate270" => {
            img = img.rotate270();
        }
        _ => {}
    }

    let file_name = src_p.file_name().unwrap_or_default();
    let target_path = Path::new(&opts.output_dir).join(file_name);

    let ext = src_p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();
    match ext.as_str() {
        "png" => {
            img.save_with_format(&target_path, image::ImageFormat::Png)
                .map_err(|e| format!("PNG 저장 실패: {e}"))?;
        }
        "webp" => {
            img.save_with_format(&target_path, image::ImageFormat::WebP)
                .map_err(|e| format!("WebP 저장 실패: {e}"))?;
        }
        _ => {
            let rgb = img.to_rgb8();
            let file = File::create(&target_path).map_err(|e| format!("파일 생성 실패: {e}"))?;
            let mut writer = std::io::BufWriter::new(file);
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 95);
            enc.encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| format!("JPEG 저장 실패: {e}"))?;
        }
    }

    Ok(target_path)
}

fn run_batch_rotate(
    app: tauri::AppHandle,
    cancel_flag: Arc<AtomicBool>,
    opts: BatchRotateOptions,
) {
    let total = opts.source_paths.len();
    let out_dir = Path::new(&opts.output_dir);
    if let Err(e) = std::fs::create_dir_all(out_dir) {
        let payload = BatchProgressPayload {
            task_id: opts.task_id.clone(),
            total,
            current_index: 0,
            current_name: String::new(),
            success_count: 0,
            failure_count: total,
            is_finished: true,
            is_cancelled: false,
            failures: vec![BatchFailureItem {
                path: opts.output_dir.clone(),
                error: format!("출력 폴더 생성 실패: {e}"),
            }],
            output_dir: opts.output_dir.clone(),
        };
        let _ = app.emit("batch-progress", payload);
        return;
    }

    let _ = app.asset_protocol_scope().allow_directory(out_dir, true);

    let items: Arc<Mutex<Vec<(usize, String)>>> = Arc::new(Mutex::new(
        opts.source_paths.iter().cloned().enumerate().collect(),
    ));
    let success_count = Arc::new(AtomicUsize::new(0));
    let failure_count = Arc::new(AtomicUsize::new(0));
    let failures: Arc<Mutex<Vec<BatchFailureItem>>> = Arc::new(Mutex::new(Vec::new()));

    let num_workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);

    std::thread::scope(|s| {
        for _ in 0..num_workers {
            let items = Arc::clone(&items);
            let success_count = Arc::clone(&success_count);
            let failure_count = Arc::clone(&failure_count);
            let failures = Arc::clone(&failures);
            let cancel_flag = Arc::clone(&cancel_flag);
            let app = app.clone();
            let opts = opts.clone();

            s.spawn(move || {
                loop {
                    if cancel_flag.load(AtomicOrdering::Relaxed) {
                        break;
                    }

                    let next_item = {
                        let mut lock = items.lock().unwrap();
                        lock.pop()
                    };

                    let (_idx, src_path) = match next_item {
                        Some(item) => item,
                        None => break,
                    };

                    let src_p = Path::new(&src_path);
                    let file_name = src_p
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "image".to_string());

                    let res = process_single_rotate(&src_p, &opts);
                    match res {
                        Ok(target_path) => {
                            let _ = app.asset_protocol_scope().allow_file(&target_path);
                            let s = success_count.fetch_add(1, AtomicOrdering::Relaxed) + 1;
                            let f = failure_count.load(AtomicOrdering::Relaxed);
                            let payload = BatchProgressPayload {
                                task_id: opts.task_id.clone(),
                                total,
                                current_index: s + f,
                                current_name: file_name,
                                success_count: s,
                                failure_count: f,
                                is_finished: false,
                                is_cancelled: false,
                                failures: Vec::new(),
                                output_dir: opts.output_dir.clone(),
                            };
                            let _ = app.emit("batch-progress", payload);
                        }
                        Err(e) => {
                            let f = failure_count.fetch_add(1, AtomicOrdering::Relaxed) + 1;
                            let s = success_count.load(AtomicOrdering::Relaxed);
                            {
                                let mut fl = failures.lock().unwrap();
                                fl.push(BatchFailureItem {
                                    path: src_path.clone(),
                                    error: e,
                                });
                            }
                            let payload = BatchProgressPayload {
                                task_id: opts.task_id.clone(),
                                total,
                                current_index: s + f,
                                current_name: file_name,
                                success_count: s,
                                failure_count: f,
                                is_finished: false,
                                is_cancelled: false,
                                failures: Vec::new(),
                                output_dir: opts.output_dir.clone(),
                            };
                            let _ = app.emit("batch-progress", payload);
                        }
                    }
                }
            });
        }
    });

    let is_cancelled = cancel_flag.load(AtomicOrdering::Relaxed);
    let final_failures = failures.lock().unwrap().clone();
    let s = success_count.load(AtomicOrdering::Relaxed);
    let f = failure_count.load(AtomicOrdering::Relaxed);

    let final_payload = BatchProgressPayload {
        task_id: opts.task_id.clone(),
        total,
        current_index: s + f,
        current_name: String::new(),
        success_count: s,
        failure_count: f,
        is_finished: true,
        is_cancelled,
        failures: final_failures,
        output_dir: opts.output_dir.clone(),
    };
    let _ = app.emit("batch-progress", final_payload);

    if let Some(manager) = app.try_state::<BatchTaskManager>() {
        if let Ok(mut map) = manager.cancel_flags.lock() {
            map.remove(&opts.task_id);
        }
    }
}

#[tauri::command]
fn start_batch_rotate(
    app: tauri::AppHandle,
    manager: tauri::State<BatchTaskManager>,
    opts: BatchRotateOptions,
) -> Result<(), String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = manager.cancel_flags.lock() {
        map.insert(opts.task_id.clone(), cancel_flag.clone());
    }

    std::thread::spawn(move || {
        run_batch_rotate(app, cancel_flag, opts);
    });

    Ok(())
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PdfImageItem {
    pub path: String,
    pub filename: String,
    pub caption_base64: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePdfOptions {
    pub items: Vec<PdfImageItem>,
    pub output_path: String,
    pub orientation: String, // "portrait", "landscape", "auto"
    pub layout: u32,         // 1, 2, 4
    pub margin_mm: f32,      // 0.0, 10.0, 20.0
    pub show_filename: bool,
    pub target_dpi: u32,     // 150, 300
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePdfResult {
    pub output_path: String,
    pub page_count: usize,
    pub file_size: u64,
}

#[tauri::command]
fn save_edited_image(
    base64_data: String,
    target_path: String,
    _strip_exif: Option<bool>,
) -> Result<String, String> {
    use std::io::Write;
    use base64::Engine;

    let target = Path::new(&target_path);
    let parent = target.parent().unwrap_or_else(|| Path::new(""));
    if !parent.as_os_str().is_empty() {
        let _ = std::fs::create_dir_all(parent);
    }

    // 규칙 3 준수: 기존 파일이 있으면 덮어쓰지 않고 _(2), _(3) 넘버링으로 안전하게 사본 저장
    let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("jpg");

    let mut actual_target = target.to_path_buf();
    let mut count = 2;
    while actual_target.exists() {
        actual_target = parent.join(format!("{stem} ({count}).{ext}"));
        count += 1;
    }

    let raw_b64 = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw_b64.trim())
        .map_err(|e| format!("Base64 디코딩 실패: {}", e))?;

    let mut file = File::create(&actual_target).map_err(|e| format!("파일 생성 실패: {}", e))?;
    file.write_all(&bytes).map_err(|e| format!("파일 쓰기 실패: {}", e))?;

    Ok(actual_target.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TiffPageResult {
    pub total_pages: u32,
    pub page_index: u32,
    pub display_path: String,
}

/// 14-A: 다중 페이지 TIFF 디코딩 및 페이지별 임시 캐시 생성
#[tauri::command]
fn get_tiff_page(app: tauri::AppHandle, path: String, page_index: u32) -> Result<TiffPageResult, String> {
    let file = File::open(&path).map_err(|e| format!("TIFF 파일 열기 실패: {e}"))?;
    let mut reader = std::io::BufReader::new(file);
    let mut decoder = tiff::decoder::Decoder::new(&mut reader)
        .map_err(|e| format!("TIFF 디코딩 실패: {e}"))?;

    let mut total_pages = 1;
    while decoder.more_images() {
        if decoder.next_image().is_err() {
            break;
        }
        total_pages += 1;
    }

    let file2 = File::open(&path).map_err(|e| format!("TIFF 파일 열기 실패: {e}"))?;
    let mut reader2 = std::io::BufReader::new(file2);
    let mut decoder2 = tiff::decoder::Decoder::new(&mut reader2)
        .map_err(|e| format!("TIFF 디코딩 실패: {e}"))?;

    let valid_page = page_index.min(total_pages - 1);
    for _ in 0..valid_page {
        if decoder2.more_images() {
            let _ = decoder2.next_image();
        }
    }

    let (width, height) = decoder2.dimensions().map_err(|e| format!("TIFF 규격 읽기 실패: {e}"))?;
    let decoded = decoder2.read_image().map_err(|e| format!("TIFF 픽셀 읽기 실패: {e}"))?;

    let dyn_img = match decoded {
        tiff::decoder::DecodingResult::U8(v) => {
            if v.len() == (width * height * 4) as usize {
                image::RgbaImage::from_raw(width, height, v).map(image::DynamicImage::ImageRgba8)
            } else if v.len() == (width * height * 3) as usize {
                image::RgbImage::from_raw(width, height, v).map(image::DynamicImage::ImageRgb8)
            } else if v.len() == (width * height) as usize {
                image::GrayImage::from_raw(width, height, v).map(image::DynamicImage::ImageLuma8)
            } else {
                None
            }
        }
        tiff::decoder::DecodingResult::U16(v) => {
            let u8_vec: Vec<u8> = v.into_iter().map(|val| (val >> 8) as u8).collect();
            if u8_vec.len() == (width * height * 4) as usize {
                image::RgbaImage::from_raw(width, height, u8_vec).map(image::DynamicImage::ImageRgba8)
            } else if u8_vec.len() == (width * height * 3) as usize {
                image::RgbImage::from_raw(width, height, u8_vec).map(image::DynamicImage::ImageRgb8)
            } else if u8_vec.len() == (width * height) as usize {
                image::GrayImage::from_raw(width, height, u8_vec).map(image::DynamicImage::ImageLuma8)
            } else {
                None
            }
        }
        _ => None,
    }.ok_or_else(|| "지원하지 않는 TIFF 픽셀 규격입니다.".to_string())?;

    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mod_time = meta.modified().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_dir = get_thumbnail_cache_dir();
    let cache_filename = format!("tiff_{}_p{}.png", make_cache_filename(&path, mod_time, meta.len()), valid_page);
    let cache_path = cache_dir.join(cache_filename);

    if !cache_path.exists() {
        dyn_img.save(&cache_path).map_err(|e| format!("TIFF 캐시 저장 실패: {e}"))?;
    }
    let _ = app.asset_protocol_scope().allow_file(&cache_path);

    Ok(TiffPageResult {
        total_pages,
        page_index: valid_page,
        display_path: cache_path.to_string_lossy().into_owned(),
    })
}

/// 14-A: 윈도우 내장 코덱을 활용한 HEIC 이미지 디코딩 및 캐시 생성
#[tauri::command]
fn get_heic_display_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let mod_time = meta.modified().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let cache_dir = get_thumbnail_cache_dir();
    let cache_filename = format!("heic_{}.png", make_cache_filename(&path, mod_time, meta.len()));
    let cache_path = cache_dir.join(cache_filename);

    if cache_path.exists() {
        let _ = app.asset_protocol_scope().allow_file(&cache_path);
        return Ok(cache_path.to_string_lossy().into_owned());
    }

    let ps_script = format!(
        r#"$src = [System.IO.Path]::GetFullPath('{src}'); $dst = [System.IO.Path]::GetFullPath('{dst}'); try {{ Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap($src); $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); exit 0; }} catch {{ exit 2; }}"#,
        src = path.replace("'", "''"),
        dst = cache_path.to_string_lossy().replace("'", "''")
    );

    let output = std::process::Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .output()
        .map_err(|e| format!("PowerShell 실행 실패: {e}"))?;

    if !output.status.success() || !cache_path.exists() {
        return Err("HEIC_CODEC_MISSING".to_string());
    }

    let _ = app.asset_protocol_scope().allow_file(&cache_path);
    Ok(cache_path.to_string_lossy().into_owned())
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CropParams {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdjustParams {
    pub brightness: f32, // -100 ~ 100
    pub contrast: f32,   // -100 ~ 100
    pub saturation: f32, // -100 ~ 100
    pub sharpness: f32,  // 0 ~ 100
}

/// 14-A: 회전/반전/자르기/보정을 통합하여 원본 손상 없이 사본으로 저장
#[tauri::command]
fn save_edited_advanced(
    source_path: String,
    crop: Option<CropParams>,
    adjust: Option<AdjustParams>,
    rotation: u32,
    flip_h: Option<bool>,
    flip_v: Option<bool>,
    target_path: Option<String>,
) -> Result<String, String> {
    let src = Path::new(&source_path);
    let mut img = image::open(src).map_err(|e| format!("이미지를 열 수 없습니다: {e}"))?;

    // 1. 회전 및 반전 적용
    match rotation % 360 {
        90 => img = img.rotate90(),
        180 => img = img.rotate180(),
        270 => img = img.rotate270(),
        _ => {}
    }
    if flip_h.unwrap_or(false) {
        img = img.fliph();
    }
    if flip_v.unwrap_or(false) {
        img = img.flipv();
    }

    // 2. 자르기 적용
    if let Some(c) = crop {
        let img_w = img.width() as f64;
        let img_h = img.height() as f64;
        let x = c.x.max(0.0).min(img_w - 1.0) as u32;
        let y = c.y.max(0.0).min(img_h - 1.0) as u32;
        let w = c.width.max(1.0).min(img_w - x as f64) as u32;
        let h = c.height.max(1.0).min(img_h - y as f64) as u32;
        img = img.crop_imm(x, y, w, h);
    }

    // 3. 보정 적용 (밝기, 대비, 선명도)
    if let Some(a) = adjust {
        if a.brightness != 0.0 {
            let b_val = (a.brightness * 2.55) as i32;
            img = img.brighten(b_val);
        }
        if a.contrast != 0.0 {
            img = img.adjust_contrast(a.contrast);
        }
        if a.sharpness > 0.0 {
            let sigma = a.sharpness / 25.0;
            img = img.unsharpen(sigma, 1);
        }
    }

    // 4. 대상 경로 결정 (사본 저장 및 넘버링 - 원본 절대 덮어쓰지 않음)
    let parent = src.parent().unwrap_or_else(|| Path::new(""));
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("jpg");

    let final_path = if let Some(t) = target_path {
        PathBuf::from(t)
    } else {
        let mut p = parent.join(format!("{stem}_edited.{ext}"));
        let mut count = 2;
        while p.exists() {
            p = parent.join(format!("{stem}_edited ({count}).{ext}"));
            count += 1;
        }
        p
    };

    img.save(&final_path).map_err(|e| format!("저장 실패: {e}"))?;
    Ok(final_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn generate_images_pdf(opts: GeneratePdfOptions) -> Result<GeneratePdfResult, String> {
    use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref};
    use base64::Engine;

    if opts.items.is_empty() {
        return Err("PDF로 묶을 이미지를 선택해 주세요.".to_string());
    }

    let out_p = Path::new(&opts.output_path);
    if let Some(parent) = out_p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut pdf = Pdf::new();
    let mut ref_alloc = 1;
    let mut next_ref = || {
        let r = Ref::new(ref_alloc);
        ref_alloc += 1;
        r
    };

    let catalog_id = next_ref();
    let page_tree_id = next_ref();

    let layout = match opts.layout {
        2 => 2,
        4 => 4,
        _ => 1,
    };

    let items_chunks: Vec<&[PdfImageItem]> = opts.items.chunks(layout as usize).collect();
    let page_count = items_chunks.len();

    let mut page_ids = Vec::new();

    struct PageData {
        page_id: Ref,
        content_id: Ref,
        page_rect: Rect,
        images: Vec<(Ref, Vec<u8>, u32, u32)>,
        captions: Vec<(Ref, Vec<u8>, u32, u32)>,
        placements: Vec<(usize, f32, f32, f32, f32)>,
        caption_placements: Vec<(usize, f32, f32, f32, f32)>,
    }

    let mut pages_data = Vec::new();

    let a4_w = 595.28f32;
    let a4_h = 841.89f32;
    let margin_pt = (opts.margin_mm / 25.4 * 72.0).max(0.0);

    for chunk in items_chunks {
        let page_id = next_ref();
        let content_id = next_ref();
        page_ids.push(page_id);

        let (page_w, page_h) = if opts.orientation == "landscape" {
            (a4_h, a4_w)
        } else if opts.orientation == "portrait" {
            (a4_w, a4_h)
        } else {
            let first_p = Path::new(&chunk[0].path);
            let is_landscape = if let Ok((w, h)) = image::image_dimensions(first_p) {
                let orient = read_exif_orientation(first_p);
                let (eff_w, eff_h) = if (5..=8).contains(&orient) { (h, w) } else { (w, h) };
                eff_w > eff_h
            } else {
                false
            };
            if is_landscape { (a4_h, a4_w) } else { (a4_w, a4_h) }
        };

        let page_rect = Rect::new(0.0, 0.0, page_w, page_h);

        let content_x = margin_pt;
        let content_y = margin_pt;
        let content_w = (page_w - 2.0 * margin_pt).max(10.0);
        let content_h = (page_h - 2.0 * margin_pt).max(10.0);

        let slot_boxes: Vec<(f32, f32, f32, f32)> = if layout == 1 {
            vec![(content_x, content_y, content_w, content_h)]
        } else if layout == 2 {
            let gap = 14.0f32;
            if page_h >= page_w {
                let sh = ((content_h - gap) / 2.0).max(10.0);
                vec![
                    (content_x, content_y + sh + gap, content_w, sh),
                    (content_x, content_y, content_w, sh),
                ]
            } else {
                let sw = ((content_w - gap) / 2.0).max(10.0);
                vec![
                    (content_x, content_y, sw, content_h),
                    (content_x + sw + gap, content_y, sw, content_h),
                ]
            }
        } else {
            let gap = 12.0f32;
            let sw = ((content_w - gap) / 2.0).max(10.0);
            let sh = ((content_h - gap) / 2.0).max(10.0);
            vec![
                (content_x, content_y + sh + gap, sw, sh),
                (content_x + sw + gap, content_y + sh + gap, sw, sh),
                (content_x, content_y, sw, sh),
                (content_x + sw + gap, content_y, sw, content_h),
            ]
        };

        let mut page_images = Vec::new();
        let mut page_captions = Vec::new();
        let mut page_placements = Vec::new();
        let mut page_caption_placements = Vec::new();

        for (i, item) in chunk.iter().enumerate() {
            if i >= slot_boxes.len() {
                break;
            }
            let (sx, sy, sw, sh) = slot_boxes[i];
            let item_p = Path::new(&item.path);
            if !item_p.exists() {
                continue;
            }

            let mut img = match image::open(item_p) {
                Ok(im) => im,
                Err(_) => continue,
            };

            let orient = read_exif_orientation(item_p);
            if orient > 1 {
                img = apply_exif_orientation(img, orient);
            }

            let caption_h = if opts.show_filename { 18.0f32 } else { 0.0f32 };
            let img_area_h = (sh - caption_h).max(10.0);
            let img_area_y = sy + caption_h;

            let dpi = if opts.target_dpi == 150 { 150.0 } else { 300.0 };
            let max_w_px = (sw / 72.0 * dpi).round().max(100.0) as u32;
            let max_h_px = (img_area_h / 72.0 * dpi).round().max(100.0) as u32;

            let (cur_w, cur_h) = (img.width(), img.height());
            if cur_w > max_w_px || cur_h > max_h_px {
                let scale = ((max_w_px as f64) / (cur_w as f64)).min((max_h_px as f64) / (cur_h as f64));
                let nw = (cur_w as f64 * scale).round().max(1.0) as u32;
                let nh = (cur_h as f64 * scale).round().max(1.0) as u32;
                img = img.resize_exact(nw, nh, image::imageops::FilterType::Triangle);
            }

            let rgb_img = img.to_rgb8();
            let (enc_w, enc_h) = (rgb_img.width(), rgb_img.height());
            let mut jpeg_bytes = Vec::new();
            let quality = if opts.target_dpi == 150 { 82 } else { 92 };
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, quality);
            if encoder.encode(rgb_img.as_raw(), enc_w, enc_h, image::ExtendedColorType::Rgb8).is_err() {
                continue;
            }

            let img_ref = next_ref();
            let img_idx = page_images.len();
            page_images.push((img_ref, jpeg_bytes, enc_w, enc_h));

            let aspect = (enc_w as f32) / (enc_h as f32);
            let box_aspect = sw / img_area_h;
            let (render_w, render_h) = if aspect > box_aspect {
                (sw, sw / aspect)
            } else {
                (img_area_h * aspect, img_area_h)
            };
            let render_x = sx + (sw - render_w) / 2.0;
            let render_y = img_area_y + (img_area_h - render_h) / 2.0;
            page_placements.push((img_idx, render_x, render_y, render_w, render_h));

            if opts.show_filename {
                if let Some(cap_b64) = &item.caption_base64 {
                    let raw_b64 = if let Some(idx) = cap_b64.find(',') {
                        &cap_b64[idx + 1..]
                    } else {
                        cap_b64
                    };
                    if let Ok(cap_bytes) = base64::engine::general_purpose::STANDARD.decode(raw_b64.trim()) {
                        if let Ok(cap_dyn) = image::load_from_memory(&cap_bytes) {
                            let cap_rgb = cap_dyn.to_rgb8();
                            let (cw, ch) = (cap_rgb.width(), cap_rgb.height());
                            let mut cap_jpg = Vec::new();
                            let mut cap_enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cap_jpg, 85);
                            if cap_enc.encode(cap_rgb.as_raw(), cw, ch, image::ExtendedColorType::Rgb8).is_ok() {
                                let cap_ref = next_ref();
                                let cap_idx = page_captions.len();
                                page_captions.push((cap_ref, cap_jpg, cw, ch));

                                let cap_aspect = (cw as f32) / (ch as f32);
                                let cap_fit_h = (caption_h - 2.0).max(6.0);
                                let cap_fit_w = (cap_fit_h * cap_aspect).min(sw);
                                let cap_fit_x = sx + (sw - cap_fit_w) / 2.0;
                                let cap_fit_y = sy + 1.0;
                                page_caption_placements.push((cap_idx, cap_fit_x, cap_fit_y, cap_fit_w, cap_fit_h));
                            }
                        }
                    }
                }
            }
        }

        pages_data.push(PageData {
            page_id,
            content_id,
            page_rect,
            images: page_images,
            captions: page_captions,
            placements: page_placements,
            caption_placements: page_caption_placements,
        });
    }

    pdf.catalog(catalog_id).pages(page_tree_id);
    pdf.pages(page_tree_id).kids(page_ids.iter().copied()).count(page_ids.len() as i32);

    for page_item in &pages_data {
        let mut page = pdf.page(page_item.page_id);
        page.media_box(page_item.page_rect);
        page.parent(page_tree_id);
        page.contents(page_item.content_id);

        let mut res = page.resources();
        let mut xobjs = res.x_objects();
        for (idx, (img_ref, _, _, _)) in page_item.images.iter().enumerate() {
            let name_str = format!("Im{}", idx);
            xobjs.pair(Name(name_str.as_bytes()), *img_ref);
        }
        for (idx, (cap_ref, _, _, _)) in page_item.captions.iter().enumerate() {
            let name_str = format!("Cap{}", idx);
            xobjs.pair(Name(name_str.as_bytes()), *cap_ref);
        }
        xobjs.finish();
        res.finish();
        page.finish();

        for (_, (img_ref, bytes, w, h)) in page_item.images.iter().enumerate() {
            let mut ximg = pdf.image_xobject(*img_ref, bytes);
            ximg.filter(Filter::DctDecode);
            ximg.width(*w as i32);
            ximg.height(*h as i32);
            ximg.color_space().device_rgb();
            ximg.bits_per_component(8);
            ximg.finish();
        }

        for (_, (cap_ref, bytes, w, h)) in page_item.captions.iter().enumerate() {
            let mut xcap = pdf.image_xobject(*cap_ref, bytes);
            xcap.filter(Filter::DctDecode);
            xcap.width(*w as i32);
            xcap.height(*h as i32);
            xcap.color_space().device_rgb();
            xcap.bits_per_component(8);
            xcap.finish();
        }

        let mut content = Content::new();
        for (img_idx, rx, ry, rw, rh) in &page_item.placements {
            let name_str = format!("Im{}", img_idx);
            content.save_state();
            content.transform([*rw, 0.0, 0.0, *rh, *rx, *ry]);
            content.x_object(Name(name_str.as_bytes()));
            content.restore_state();
        }
        for (cap_idx, cx, cy, cw, ch) in &page_item.caption_placements {
            let name_str = format!("Cap{}", cap_idx);
            content.save_state();
            content.transform([*cw, 0.0, 0.0, *ch, *cx, *cy]);
            content.x_object(Name(name_str.as_bytes()));
            content.restore_state();
        }
        pdf.stream(page_item.content_id, &content.finish());
    }

    let pdf_bytes = pdf.finish();
    let file_size = pdf_bytes.len() as u64;
    std::fs::write(&opts.output_path, &pdf_bytes)
        .map_err(|e| format!("PDF 파일 쓰기 실패: {}", e))?;

    Ok(GeneratePdfResult {
        output_path: opts.output_path,
        page_count,
        file_size,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 과거 임시 스테이징 폴더에 남은 고아 파일들을 안전하게 실제 휴지통으로 이동
    clean_legacy_undo_staging();

    let mut initial_path = None;
    for arg in std::env::args().skip(1) {
        let p = Path::new(&arg);
        if is_supported_file(p) {
            initial_path = Some(arg);
            break;
        }
    }

    tauri::Builder::default()
        .manage(InitialFile(Mutex::new(initial_path)))
        .manage(FolderWatcherState(Mutex::new(None)))
        .manage(UndoState(Mutex::new(Vec::new())))
        .manage(BatchTaskManager::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            for arg in argv.into_iter().skip(1) {
                let p = Path::new(&arg);
                if is_supported_file(p) {
                    let _ = app.asset_protocol_scope().allow_file(p);
                    let _ = app.emit("open-file", arg);
                    break;
                }
            }
        }))
        .invoke_handler(tauri::generate_handler![
            open_image,
            get_orientation,
            get_thumbnail,
            get_image_details,
            show_in_folder,
            delete_to_trash,
            delete_paths_to_trash,
            undo_last_action,
            rename_file,
            copy_files_to_folder,
            move_files_to_folder,
            create_new_folder,
            copy_files_to_clipboard,
            paste_files_from_clipboard,
            open_in_external_editor,
            set_as_desktop_wallpaper,
            save_clipboard_image,
            save_rotated_image,
            save_image_advanced,
            get_archive_entry_image,
            load_settings,
            save_settings,
            get_initial_file,
            get_next_folder_first_image,
            get_prev_folder_last_image,
            get_system_locations,
            get_subfolders,
            scan_explorer_folder,
            watch_folder,
            unwatch_folder,
            check_path_exists,
            load_id_photo_presets,
            save_id_photo_presets,
            save_id_photo,
            generate_id_photo_print_sheet,
            convert_dwg_to_dxf,
            read_cad_file_text,
            get_dwg_thumbnail,
            open_in_cad_program,
            set_cad_file_association,
            get_batch_file_dates,
            cancel_batch_task,
            execute_batch_rename,
            start_batch_convert,
            start_batch_rotate,
            save_edited_image,
            generate_images_pdf,
            get_tiff_page,
            get_heic_display_path,
            save_edited_advanced
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
