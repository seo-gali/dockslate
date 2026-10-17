use std::collections::{HashMap, HashSet};

pub struct Entry<'a> {
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub modified: Option<u64>,
    pub data: &'a [u8],
}

fn string(bytes: &[u8]) -> Result<&str, String> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    if bytes[end..].iter().any(|byte| *byte != 0) {
        return Err("TAR 문자열의 종료 형식이 올바르지 않습니다.".into());
    }
    std::str::from_utf8(&bytes[..end])
        .map_err(|_| "UTF-8이 아닌 TAR 경로는 표시할 수 없습니다.".into())
}
fn number(bytes: &[u8]) -> Result<u64, String> {
    if bytes.first().is_some_and(|byte| byte & 0x80 != 0) {
        if bytes[0] & 0x40 != 0 {
            return Err("음수 TAR 크기는 사용할 수 없습니다.".into());
        }
        return bytes
            .iter()
            .enumerate()
            .try_fold(0u64, |value, (index, byte)| {
                value
                    .checked_mul(256)
                    .and_then(|value| {
                        value.checked_add(if index == 0 {
                            (byte & 0x7f) as u64
                        } else {
                            *byte as u64
                        })
                    })
                    .ok_or_else(|| "TAR 숫자가 허용 범위를 초과했습니다.".into())
            });
    }
    let value = std::str::from_utf8(bytes)
        .map_err(|_| "TAR 숫자 형식이 올바르지 않습니다.")?
        .trim_matches(['\0', ' ']);
    if value.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(value, 8).map_err(|_| "TAR 숫자 형식이 올바르지 않습니다.".into())
}
pub fn safe_path(value: &str) -> Result<String, String> {
    if value.len() > 4096 || value.starts_with('/') || value.contains('\0') || value.contains('\\')
    {
        return Err("안전하지 않은 TAR 경로가 포함되어 있습니다.".into());
    }
    let value = value.trim_end_matches('/');
    let mut parts = Vec::new();
    for part in value.split('/') {
        if part == "." && parts.is_empty() {
            continue;
        }
        if part.is_empty() && parts.is_empty() {
            continue;
        }
        if part.is_empty() || part == "." || part == ".." {
            return Err("상위 경로나 비정상 경로가 포함된 TAR은 표시할 수 없습니다.".into());
        }
        parts.push(part);
    }
    if parts.len() > 64 {
        return Err("TAR 내부 경로가 너무 깊습니다.".into());
    }
    Ok(parts.join("/"))
}
fn pax(data: &[u8]) -> Result<HashMap<String, String>, String> {
    if data.len() > 65536 {
        return Err("TAR 확장 메타데이터가 너무 큽니다.".into());
    }
    let mut cursor = 0;
    let mut values = HashMap::new();
    let mut records = 0;
    while cursor < data.len() {
        records += 1;
        if records > 128 {
            return Err("TAR 확장 항목이 너무 많습니다.".into());
        }
        let space = data[cursor..]
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or("TAR PAX 길이를 확인하지 못했습니다.")?;
        let length = std::str::from_utf8(&data[cursor..cursor + space])
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|length| *length > space + 2)
            .ok_or("TAR PAX 길이가 올바르지 않습니다.")?;
        let end = cursor
            .checked_add(length)
            .filter(|end| *end <= data.len())
            .ok_or("TAR PAX 데이터가 중간에 끝났습니다.")?;
        if data[end - 1] != b'\n' {
            return Err("TAR PAX 종료 형식이 올바르지 않습니다.".into());
        }
        let record = &data[cursor + space + 1..end - 1];
        let equals = record
            .iter()
            .position(|byte| *byte == b'=')
            .ok_or("TAR PAX 항목 형식이 올바르지 않습니다.")?;
        let key = std::str::from_utf8(&record[..equals])
            .map_err(|_| "TAR PAX 이름 형식이 올바르지 않습니다.")?;
        if key.is_empty() || key.len() > 256 || key.bytes().any(|byte| !(33..=126).contains(&byte))
        {
            return Err("TAR PAX 이름 형식이 올바르지 않습니다.".into());
        }
        if key.starts_with("GNU.sparse") {
            return Err("Sparse TAR 파일은 미리보기할 수 없습니다.".into());
        }
        if ["path", "size", "mtime", "linkpath"].contains(&key) {
            let value = std::str::from_utf8(&record[equals + 1..])
                .map_err(|_| "TAR PAX 값 형식이 올바르지 않습니다.")?;
            if value.len() > 4096 || value.contains('\0') {
                return Err("TAR PAX 값이 허용 범위를 초과했습니다.".into());
            }
            if values.insert(key.into(), value.into()).is_some() {
                return Err("TAR PAX 항목이 중복되었습니다.".into());
            }
        }
        cursor = end;
    }
    Ok(values)
}
pub fn parse(data: &[u8]) -> Result<Vec<Entry<'_>>, String> {
    if data.len() > 16 * 1024 * 1024 || data.len() < 1024 {
        return Err("TAR 응답 크기가 허용 범위를 벗어났습니다.".into());
    }
    let mut cursor = 0usize;
    let mut entries = Vec::new();
    let mut global = HashMap::<String, String>::new();
    let mut pending = HashMap::<String, String>::new();
    let mut long_name = None;
    let mut headers = 0;
    let mut names = HashSet::new();
    while cursor + 512 <= data.len() {
        let header = &data[cursor..cursor + 512];
        if header.iter().all(|byte| *byte == 0) {
            if data
                .get(cursor + 512..cursor + 1024)
                .is_none_or(|block| block.iter().any(|byte| *byte != 0))
                || data[cursor + 1024..].iter().any(|byte| *byte != 0)
            {
                return Err("TAR 종료 블록이 올바르지 않습니다.".into());
            }
            if !pending.is_empty() || long_name.is_some() {
                return Err("TAR 확장 항목의 대상 파일이 없습니다.".into());
            }
            return Ok(entries);
        }
        headers += 1;
        if headers > 8192 {
            return Err("TAR 내부 항목이 너무 많습니다. 더 작은 하위 경로를 선택하세요.".into());
        }
        let expected = number(&header[148..156])?;
        let actual = header
            .iter()
            .enumerate()
            .map(|(index, byte)| {
                if (148..156).contains(&index) {
                    32u64
                } else {
                    *byte as u64
                }
            })
            .sum::<u64>();
        if expected != actual {
            return Err("TAR 헤더 검증에 실패했습니다.".into());
        }
        let kind = header[156];
        let metadata = matches!(kind, b'x' | b'g' | b'L' | b'K');
        let raw_size = number(&header[124..136])?;
        let override_value = |key: &str| pending.get(key).or_else(|| global.get(key));
        let size = if metadata {
            raw_size
        } else if let Some(size) = override_value("size") {
            size.parse::<u64>()
                .map_err(|_| "TAR PAX 파일 크기가 올바르지 않습니다.")?
        } else {
            raw_size
        };
        let body = cursor
            .checked_add(512)
            .ok_or("TAR 크기 계산에 실패했습니다.")?;
        let size_usize = usize::try_from(size).map_err(|_| "TAR 파일 크기가 너무 큽니다.")?;
        let end = body
            .checked_add(size_usize)
            .filter(|end| *end <= data.len())
            .ok_or("TAR 파일 데이터가 중간에 끝났습니다.")?;
        let next = body
            .checked_add(
                size_usize
                    .div_ceil(512)
                    .checked_mul(512)
                    .ok_or("TAR 크기가 너무 큽니다.")?,
            )
            .filter(|next| *next <= data.len())
            .ok_or("TAR 파일의 패딩이 올바르지 않습니다.")?;
        let contents = &data[body..end];
        cursor = next;
        if matches!(kind, b'x' | b'g') {
            let values = pax(contents)?;
            if kind == b'g' {
                global.extend(values);
            } else {
                pending.extend(values);
            }
            continue;
        }
        if matches!(kind, b'L' | b'K') {
            if contents.len() > 4097 {
                return Err("TAR 확장 경로가 너무 깁니다.".into());
            }
            let value = string(contents)?.trim_end_matches('\n').to_owned();
            if kind == b'L' {
                safe_path(&value)?;
                long_name = Some(value);
            }
            continue;
        }
        let base = string(&header[..100])?;
        let raw_name = if &header[257..263] == b"ustar\0" {
            let prefix = string(&header[345..500])?;
            if prefix.is_empty() {
                base.to_owned()
            } else {
                format!("{prefix}/{base}")
            }
        } else {
            base.to_owned()
        };
        safe_path(&raw_name)?;
        let name = long_name
            .take()
            .or_else(|| override_value("path").cloned())
            .unwrap_or(raw_name);
        let path = safe_path(&name)?;
        let modified = override_value("mtime")
            .and_then(|time| time.split('.').next())
            .and_then(|time| time.parse::<u64>().ok())
            .or_else(|| number(&header[136..148]).ok());
        let entry_kind = match kind {
            0 | b'0' | b'7' => {
                if name.ends_with('/') {
                    "directory"
                } else {
                    "file"
                }
            }
            b'5' => "directory",
            b'1' | b'2' => "symlink",
            b'3' | b'4' | b'6' => "other",
            _ => return Err("지원하지 않는 TAR 파일 형식입니다.".into()),
        };
        if (path.is_empty() && entry_kind != "directory") || !names.insert(path.clone()) {
            return Err("중복되거나 비정상적인 TAR 항목 경로입니다.".into());
        }
        if entry_kind != "file" && size != 0 {
            return Err("TAR 특수 항목에 파일 내용이 포함되어 있습니다.".into());
        }
        pending.clear();
        entries.push(Entry {
            path,
            kind: entry_kind,
            size,
            modified,
            data: if entry_kind == "file" { contents } else { &[] },
        });
    }
    Err("TAR 응답이 종료 블록 전에 끝났습니다.".into())
}
