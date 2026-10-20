use std::cmp::Ordering;
use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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

/// WebView2가 직접 표시할 수 있는 이미지 확장자 (Rust에서 디코딩하지 않는다)
const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "gif", "webp", "avif", "bmp", "svg",
];

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

/// %LOCALAPPDATA%\PrismView\thumbnails 캐시 디렉토리
fn get_thumbnail_cache_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let cache_dir = base.join("PrismView").join("thumbnails");
    let _ = std::fs::create_dir_all(&cache_dir);
    cache_dir
}

/// %LOCALAPPDATA%\PrismView\zip_temp 임시 디렉토리 (ZIP 온디맨드 추출용)
fn get_zip_temp_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let temp_dir = base.join("PrismView").join("zip_temp");
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
    IMAGE_EXTENSIONS.contains(&ext.as_str()) || ext == "zip" || ext == "cbz"
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
    let dir = PathBuf::from(app_data).join("PrismView");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("settings.json"))
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
        items: Vec<(String, String)>,
    },
    Rename {
        old_path: String,
        new_path: String,
    },
    Move {
        items: Vec<(String, String)>,
    },
}

pub struct UndoState(pub Mutex<Vec<UndoAction>>);

fn get_undo_staging_dir() -> PathBuf {
    let dir = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("PrismView")
        .join("undo_trash");
    let _ = std::fs::create_dir_all(&dir);
    dir
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

                if is_image || is_archive {
                    // asset 프로토콜에 허용
                    let _ = app.asset_protocol_scope().allow_file(&entry_path);

                    let kind = if is_archive {
                        total_archives += 1;
                        "archive"
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
    let staging_root = get_undo_staging_dir();
    let batch_id = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let batch_dir = staging_root.join(format!("batch_{}", batch_id));
    let _ = std::fs::create_dir_all(&batch_dir);

    let mut staged_items = Vec::new();

    for (idx, path_str) in paths.into_iter().enumerate() {
        let p = Path::new(&path_str);
        if !p.exists() {
            continue;
        }
        let file_name = p.file_name().and_then(|n| n.to_str()).unwrap_or("item");
        let staged_target = batch_dir.join(format!("{}_{}", idx, file_name));

        let staged = if std::fs::rename(p, &staged_target).is_ok() {
            true
        } else if copy_entry_recursive(p, &staged_target).is_ok() {
            if p.is_dir() {
                let _ = trash::delete(p);
            } else {
                let _ = std::fs::remove_file(p);
            }
            true
        } else {
            false
        };

        if staged {
            staged_items.push((path_str, staged_target.to_string_lossy().into_owned()));
        }
    }

    if !staged_items.is_empty() {
        let mut stack = undo_state.0.lock().map_err(|e| e.to_string())?;
        stack.push(UndoAction::Delete { items: staged_items });
        while stack.len() > 20 {
            let evicted = stack.remove(0);
            if let UndoAction::Delete { items } = evicted {
                for (_, staged_p) in items {
                    let sp = Path::new(&staged_p);
                    if sp.exists() {
                        let _ = trash::delete(sp);
                    }
                }
            }
        }
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
        UndoAction::Delete { items } => {
            let mut restored_count = 0;
            for (orig_p_str, staged_p_str) in items {
                let orig_p = Path::new(&orig_p_str);
                let staged_p = Path::new(&staged_p_str);
                if staged_p.exists() {
                    if let Some(parent) = orig_p.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if std::fs::rename(staged_p, orig_p).is_ok() {
                        restored_count += 1;
                    } else if copy_entry_recursive(staged_p, orig_p).is_ok() {
                        let _ = if staged_p.is_dir() {
                            std::fs::remove_dir_all(staged_p)
                        } else {
                            std::fs::remove_file(staged_p)
                        };
                        restored_count += 1;
                    }
                }
            }
            Ok(format!("삭제된 항목 {}개를 원래 위치로 복원했습니다.", restored_count))
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
        let evicted = stack.remove(0);
        if let UndoAction::Delete { items } = evicted {
            for (_, staged_p) in items {
                let sp = Path::new(&staged_p);
                if sp.exists() {
                    let _ = trash::delete(sp);
                }
            }
        }
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
            "overwrite" => target_dir.join(file_name),
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
                    let _ = std::fs::remove_file(&p);
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
            let _ = if src_p.is_dir() {
                std::fs::remove_dir_all(src_p)
            } else {
                std::fs::remove_file(src_p)
            };
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
            let evicted = stack.remove(0);
            if let UndoAction::Delete { items } = evicted {
                for (_, staged_p) in items {
                    let sp = Path::new(&staged_p);
                    if sp.exists() {
                        let _ = trash::delete(sp);
                    }
                }
            }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            check_path_exists
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
