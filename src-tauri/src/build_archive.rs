use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

const INPUT_LIMIT: usize = 64 * 1024 * 1024;
const EXPANDED_LIMIT: usize = 128 * 1024 * 1024;
const BLOB_LIMIT: usize = 32 * 1024 * 1024;
const LOG_LIMIT: usize = 1024 * 1024;
const HISTORY_TYPE: &str = "application/vnd.buildkit.historyrecord.v0";
struct Budget(Instant);
impl Budget {
    fn new() -> Self {
        Self(Instant::now() + Duration::from_secs(15))
    }
    fn check(&self) -> Result<(), String> {
        if Instant::now() >= self.0 {
            Err("빌드 기록 처리 시간이 15초를 초과했습니다. 더 작은 기록 파일을 선택하세요.".into())
        } else {
            Ok(())
        }
    }
}

struct Bits<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl Bits<'_> {
    fn read(&mut self, count: usize) -> Result<u32, String> {
        if count > 16
            || self
                .position
                .checked_add(count)
                .is_none_or(|end| end > self.bytes.len() * 8)
        {
            return Err("잘린 DEFLATE 비트열입니다.".into());
        }
        let value = self.peek(count);
        self.position += count;
        Ok(value)
    }
    fn peek(&self, count: usize) -> u32 {
        let start = self.position / 8;
        let shift = self.position % 8;
        let mut value = 0u32;
        for offset in 0..3 {
            if let Some(byte) = self.bytes.get(start + offset) {
                value |= (*byte as u32) << (offset * 8);
            }
        }
        (value >> shift) & ((1u32 << count) - 1)
    }
    fn align(&mut self) {
        self.position = self.position.div_ceil(8) * 8;
    }
}
struct Huffman {
    table: Vec<(u16, u8)>,
    width: usize,
}
impl Huffman {
    fn new(lengths: &[u8]) -> Result<Self, String> {
        let width = lengths.iter().copied().max().unwrap_or(0) as usize;
        if width > 15 {
            return Err("Huffman 코드 길이가 올바르지 않습니다.".into());
        }
        if width == 0 {
            return Ok(Self {
                table: Vec::new(),
                width: 0,
            });
        }
        let mut counts = [0u32; 16];
        for length in lengths {
            if *length > 0 {
                counts[*length as usize] += 1;
            }
        }
        let mut available = 1i32;
        for count in counts.iter().skip(1) {
            available = available * 2 - *count as i32;
            if available < 0 {
                return Err("겹치는 Huffman 코드입니다.".into());
            }
        }
        let mut next = [0u32; 16];
        let mut code = 0;
        for length in 1..=15 {
            code = (code + counts[length - 1]) << 1;
            next[length] = code;
        }
        let mut table = vec![(0, 0); 1 << width];
        for (symbol, length) in lengths.iter().copied().enumerate() {
            if length == 0 {
                continue;
            }
            let length = length as usize;
            let code = next[length];
            next[length] += 1;
            let reversed = code.reverse_bits() >> (32 - length);
            for suffix in 0..(1usize << (width - length)) {
                let index = reversed as usize | (suffix << length);
                if table[index].1 != 0 {
                    return Err("겹치는 Huffman 코드입니다.".into());
                }
                table[index] = (symbol as u16, length as u8);
            }
        }
        Ok(Self { table, width })
    }
    fn symbol(&self, bits: &mut Bits<'_>) -> Result<u16, String> {
        if self.width == 0 {
            return Err("비어 있는 Huffman 트리를 사용했습니다.".into());
        }
        let (symbol, count) = self.table[bits.peek(self.width) as usize];
        if count == 0 || bits.position + count as usize > bits.bytes.len() * 8 {
            return Err("Huffman 코드가 올바르지 않습니다.".into());
        }
        bits.position += count as usize;
        Ok(symbol)
    }
}
fn dynamic(bits: &mut Bits<'_>) -> Result<(Huffman, Huffman), String> {
    let literals = bits.read(5)? as usize + 257;
    let distances = bits.read(5)? as usize + 1;
    let count = bits.read(4)? as usize + 4;
    if literals > 286 {
        return Err("DEFLATE 리터럴 개수가 올바르지 않습니다.".into());
    }
    const ORDER: [usize; 19] = [
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
    ];
    let mut code_lengths = [0u8; 19];
    for index in 0..count {
        code_lengths[ORDER[index]] = bits.read(3)? as u8;
    }
    let tree = Huffman::new(&code_lengths)?;
    let total = literals + distances;
    let mut lengths = Vec::with_capacity(total);
    while lengths.len() < total {
        let symbol = tree.symbol(bits)?;
        let (length, repeat) = match symbol {
            0..=15 => (symbol as u8, 1),
            16 => (
                *lengths
                    .last()
                    .ok_or("Huffman 반복 코드의 이전 값이 없습니다.")?,
                bits.read(2)? as usize + 3,
            ),
            17 => (0, bits.read(3)? as usize + 3),
            18 => (0, bits.read(7)? as usize + 11),
            _ => return Err("Huffman 길이 코드가 올바르지 않습니다.".into()),
        };
        if lengths.len() + repeat > total {
            return Err("Huffman 길이 반복이 범위를 벗어났습니다.".into());
        }
        lengths.resize(lengths.len() + repeat, length);
    }
    if lengths[256] == 0 {
        return Err("DEFLATE 종료 코드가 없습니다.".into());
    }
    Ok((
        Huffman::new(&lengths[..literals])?,
        Huffman::new(&lengths[literals..])?,
    ))
}
fn inflate(bytes: &[u8], budget: &Budget) -> Result<(Vec<u8>, usize), String> {
    let mut bits = Bits { bytes, position: 0 };
    let mut output = Vec::new();
    let mut blocks = 0usize;
    const LENGTHS: [usize; 29] = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ];
    const LENGTH_EXTRA: [usize; 29] = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ];
    const DISTANCES: [usize; 30] = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ];
    const DISTANCE_EXTRA: [usize; 30] = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
        13, 13,
    ];
    loop {
        budget.check()?;
        blocks += 1;
        if blocks > 100_000 {
            return Err("압축 블록 개수가 제한을 초과했습니다.".into());
        }
        let last = bits.read(1)? == 1;
        let kind = bits.read(2)?;
        if kind == 0 {
            bits.align();
            let size = bits.read(16)? as usize;
            let complement = bits.read(16)?;
            if (size as u32 ^ complement) != 0xffff {
                return Err("비압축 블록 길이가 올바르지 않습니다.".into());
            }
            if output.len() + size > EXPANDED_LIMIT {
                return Err("압축을 푼 기록이 128MB 제한을 초과했습니다.".into());
            }
            let start = bits.position / 8;
            let data = bytes
                .get(start..start + size)
                .ok_or("비압축 블록이 잘렸습니다.")?;
            output.extend_from_slice(data);
            bits.position += size * 8;
        } else {
            let (literals, distances) = match kind {
                1 => {
                    let mut lengths = [8u8; 288];
                    lengths[144..256].fill(9);
                    lengths[256..280].fill(7);
                    (Huffman::new(&lengths)?, Huffman::new(&[5u8; 32])?)
                }
                2 => dynamic(&mut bits)?,
                _ => return Err("예약된 DEFLATE 블록입니다.".into()),
            };
            let mut symbols = 0usize;
            loop {
                symbols += 1;
                if symbols % 4096 == 0 {
                    budget.check()?;
                }
                match literals.symbol(&mut bits)? {
                    value @ 0..=255 => {
                        if output.len() >= EXPANDED_LIMIT {
                            return Err("압축을 푼 기록이 128MB 제한을 초과했습니다.".into());
                        }
                        output.push(value as u8);
                    }
                    256 => break,
                    value @ 257..=285 => {
                        let index = value as usize - 257;
                        let length = LENGTHS[index] + bits.read(LENGTH_EXTRA[index])? as usize;
                        let symbol = distances.symbol(&mut bits)? as usize;
                        if symbol >= DISTANCES.len() {
                            return Err("예약된 DEFLATE 거리 코드입니다.".into());
                        }
                        let distance =
                            DISTANCES[symbol] + bits.read(DISTANCE_EXTRA[symbol])? as usize;
                        if distance > output.len() || output.len() + length > EXPANDED_LIMIT {
                            return Err("압축 거리 또는 128MB 확장 제한을 벗어났습니다.".into());
                        }
                        for _ in 0..length {
                            let value = output[output.len() - distance];
                            output.push(value);
                        }
                    }
                    _ => return Err("예약된 DEFLATE 길이 코드입니다.".into()),
                }
            }
        }
        if last {
            bits.align();
            return Ok((output, bits.position / 8));
        }
    }
}
fn crc32(bytes: &[u8], budget: &Budget) -> Result<u32, String> {
    let mut table = [0u32; 256];
    for (index, entry) in table.iter_mut().enumerate() {
        let mut value = index as u32;
        for _ in 0..8 {
            value = if value & 1 == 0 {
                value >> 1
            } else {
                (value >> 1) ^ 0xedb88320
            };
        }
        *entry = value;
    }
    let mut crc = !0u32;
    for (index, byte) in bytes.iter().enumerate() {
        if index % 65536 == 0 {
            budget.check()?;
        }
        crc = table[((crc ^ *byte as u32) & 255) as usize] ^ (crc >> 8);
    }
    Ok(!crc)
}
fn gzip(bytes: &[u8], budget: &Budget) -> Result<Vec<u8>, String> {
    if bytes.len() < 18
        || bytes.len() > INPUT_LIMIT
        || bytes[..3] != [0x1f, 0x8b, 8]
        || bytes[3] & 0xe0 != 0
    {
        return Err("64MB 이하의 gzip 빌드 기록을 선택하세요.".into());
    }
    let flags = bytes[3];
    let mut position = 10usize;
    if flags & 4 != 0 {
        let length = bytes
            .get(position..position + 2)
            .ok_or("gzip 추가 헤더가 잘렸습니다.")?;
        position += 2 + u16::from_le_bytes([length[0], length[1]]) as usize;
    }
    for flag in [8, 16] {
        if flags & flag != 0 {
            let start = position;
            while bytes.get(position).is_some_and(|byte| *byte != 0) {
                position += 1;
                if position - start > 4096 {
                    return Err("gzip 텍스트 헤더가 제한을 초과했습니다.".into());
                }
            }
            if bytes.get(position) != Some(&0) {
                return Err("gzip 텍스트 헤더가 잘렸습니다.".into());
            }
            position += 1;
        }
    }
    if flags & 2 != 0 {
        let value = bytes
            .get(position..position + 2)
            .ok_or("gzip 헤더 검사값이 없습니다.")?;
        if crc32(&bytes[..position], budget)? as u16 != u16::from_le_bytes([value[0], value[1]]) {
            return Err("gzip 헤더 검사값이 일치하지 않습니다.".into());
        }
        position += 2;
    }
    let compressed = bytes
        .get(position..)
        .ok_or("gzip 압축 데이터가 없습니다.")?;
    let (output, consumed) = inflate(compressed, budget)?;
    position += consumed;
    if position + 8 != bytes.len() {
        return Err("gzip 끝부분이 잘렸거나 여러 gzip 기록이 연결되어 있습니다.".into());
    }
    let checksum = u32::from_le_bytes(
        bytes[position..position + 4]
            .try_into()
            .map_err(|_| "gzip 검사값이 없습니다.")?,
    );
    let size = u32::from_le_bytes(
        bytes[position + 4..position + 8]
            .try_into()
            .map_err(|_| "gzip 크기 정보가 없습니다.")?,
    );
    if checksum != crc32(&output, budget)? || size != output.len() as u32 {
        return Err("gzip CRC32 또는 원본 크기가 일치하지 않습니다.".into());
    }
    Ok(output)
}

pub(crate) fn sha256(bytes: &[u8]) -> Result<String, String> {
    sha256_budget(bytes, &Budget::new())
}
fn sha256_budget(bytes: &[u8], budget: &Budget) -> Result<String, String> {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let blocks = (bytes.len() + 9).div_ceil(64);
    let bit_length = (bytes.len() as u64).wrapping_mul(8);
    for block in 0..blocks {
        if block % 1024 == 0 {
            budget.check()?;
        }
        let mut chunk = [0u8; 64];
        let start = block * 64;
        for (offset, byte) in chunk.iter_mut().enumerate() {
            let index = start + offset;
            *byte = if index < bytes.len() {
                bytes[index]
            } else if index == bytes.len() {
                0x80
            } else {
                0
            };
        }
        if block + 1 == blocks {
            chunk[56..].copy_from_slice(&bit_length.to_be_bytes());
        }
        let mut words = [0u32; 64];
        for (index, bytes) in chunk.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        for index in 16..64 {
            let a = words[index - 15];
            let b = words[index - 2];
            let small0 = a.rotate_right(7) ^ a.rotate_right(18) ^ (a >> 3);
            let small1 = b.rotate_right(17) ^ b.rotate_right(19) ^ (b >> 10);
            words[index] = words[index - 16]
                .wrapping_add(small0)
                .wrapping_add(words[index - 7])
                .wrapping_add(small1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for index in 0..64 {
            let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choose = (e & f) ^ (!e & g);
            let first = h
                .wrapping_add(sum1)
                .wrapping_add(choose)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let second = sum0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(first);
            d = c;
            c = b;
            b = a;
            a = first.wrapping_add(second);
        }
        for (index, value) in [a, b, c, d, e, f, g, h].iter().enumerate() {
            state[index] = state[index].wrapping_add(*value);
        }
    }
    Ok(state.iter().map(|value| format!("{value:08x}")).collect())
}
fn tar_text(bytes: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(bytes.split(|byte| *byte == 0).next().unwrap_or_default())
        .map_err(|_| "TAR 경로 인코딩이 올바르지 않습니다.".into())
}
fn octal(bytes: &[u8]) -> Result<usize, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "TAR 숫자가 올바르지 않습니다.")?
        .trim_matches([' ', '\0']);
    if text.is_empty() {
        return Ok(0);
    }
    if !text.bytes().all(|byte| (b'0'..=b'7').contains(&byte)) {
        return Err("TAR 크기 형식을 지원하지 않습니다.".into());
    }
    usize::from_str_radix(text, 8).map_err(|_| "TAR 크기가 범위를 초과했습니다.".into())
}
fn archive_entries<'a>(
    bytes: &'a [u8],
    budget: &Budget,
) -> Result<HashMap<String, &'a [u8]>, String> {
    let mut position = 0usize;
    let mut entries = HashMap::new();
    let mut count = 0usize;
    loop {
        budget.check()?;
        let header = bytes
            .get(position..position + 512)
            .ok_or("TAR 헤더가 잘렸습니다.")?;
        if header.iter().all(|byte| *byte == 0) {
            let end = bytes.get(position..).ok_or("TAR 끝부분이 없습니다.")?;
            if end.len() < 1024 || end.iter().any(|byte| *byte != 0) {
                return Err("TAR 종료 블록이 올바르지 않습니다.".into());
            }
            return Ok(entries);
        }
        count += 1;
        if count > 4096 {
            return Err("TAR 항목 개수가 4096개를 초과했습니다.".into());
        }
        let checksum: usize = header
            .iter()
            .enumerate()
            .map(|(index, byte)| {
                if (148..156).contains(&index) {
                    32
                } else {
                    *byte as usize
                }
            })
            .sum();
        if checksum != octal(&header[148..156])? {
            return Err("TAR 헤더 검사값이 일치하지 않습니다.".into());
        }
        let name = tar_text(&header[..100])?;
        let prefix = tar_text(&header[345..500])?;
        let name = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        let name = name
            .strip_prefix("./")
            .unwrap_or(&name)
            .trim_end_matches('/');
        if name.is_empty()
            || name.starts_with('/')
            || name.contains(['\\', ':'])
            || name.chars().any(char::is_control)
            || name
                .split('/')
                .any(|part| part.is_empty() || part == ".." || part == ".")
        {
            return Err("TAR 경로가 보관 범위를 벗어났습니다.".into());
        }
        let size = octal(&header[124..136])?;
        if size > BLOB_LIMIT {
            return Err("TAR 파일이 32MB 제한을 초과했습니다.".into());
        }
        position += 512;
        let data = bytes
            .get(position..position + size)
            .ok_or("TAR 파일 데이터가 잘렸습니다.")?;
        position = position
            .checked_add(size.div_ceil(512) * 512)
            .ok_or("TAR 크기가 범위를 초과했습니다.")?;
        match header[156] {
            b'5' if size == 0 => continue,
            0 | b'0' => {}
            _ => return Err("TAR 링크나 특수 파일 형식은 지원하지 않습니다.".into()),
        }
        let blob = name.strip_prefix("blobs/sha256/");
        if name != "index.json"
            && name != "oci-layout"
            && !blob.is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err("빌드 기록에서 지원하지 않는 파일입니다.".into());
        }
        if let Some(hash) = blob {
            if sha256_budget(data, budget)? != hash {
                return Err("보관 파일의 SHA256이 일치하지 않습니다.".into());
            }
        }
        if entries.insert(name.to_owned(), data).is_some() {
            return Err("TAR 파일 이름이 중복되었습니다.".into());
        }
    }
}
fn field<'a>(value: &'a Value, names: &[&str]) -> &'a Value {
    names
        .iter()
        .find_map(|name| value.get(*name))
        .unwrap_or(&Value::Null)
}
fn blob<'a>(entries: &HashMap<String, &'a [u8]>, descriptor: &Value) -> Result<&'a [u8], String> {
    let digest = field(descriptor, &["digest", "Digest"])
        .as_str()
        .ok_or("기록의 blob 식별 정보가 없습니다.")?;
    let hash = digest
        .strip_prefix("sha256:")
        .filter(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or("SHA256 기록 식별자가 필요합니다.")?;
    let bytes = entries
        .get(&format!("blobs/sha256/{hash}"))
        .ok_or("보관 파일에 필요한 blob이 없습니다.")?;
    if field(descriptor, &["size", "Size"]).as_u64() != Some(bytes.len() as u64) {
        return Err("기록 blob의 크기가 일치하지 않습니다.".into());
    }
    Ok(bytes)
}
fn json_blob(entries: &HashMap<String, &[u8]>, descriptor: &Value) -> Result<Value, String> {
    let data = blob(entries, descriptor)?;
    if data.len() > 1024 * 1024 {
        return Err("빌드 메타데이터가 1MB 제한을 초과했습니다.".into());
    }
    serde_json::from_slice(data).map_err(|_| "기록 JSON 형식을 읽을 수 없습니다.".into())
}
fn manifests(
    entries: &HashMap<String, &[u8]>,
    descriptor: &Value,
    depth: usize,
    visited: &mut HashSet<String>,
    records: &mut Vec<Value>,
    budget: &Budget,
) -> Result<(), String> {
    budget.check()?;
    if depth > 4 || visited.len() >= 200 || records.len() >= 100 {
        return Err("빌드 기록 개수 또는 중첩 제한을 초과했습니다.".into());
    }
    let id = descriptor["digest"]
        .as_str()
        .ok_or("OCI 식별자가 없습니다.")?;
    if !visited.insert(id.to_owned()) {
        return Err("OCI 기록에 중복 또는 순환 참조가 있습니다.".into());
    }
    let value = json_blob(entries, descriptor)?;
    if value["schemaVersion"] != 2 {
        return Err("지원하지 않는 OCI 버전입니다.".into());
    }
    if let Some(children) = value["manifests"].as_array() {
        for child in children {
            manifests(entries, child, depth + 1, visited, records, budget)?;
        }
    } else if value["config"]["mediaType"] == HISTORY_TYPE {
        records.push(value);
    } else {
        return Err("빌드 기록 대신 이미지가 들어 있는 파일입니다.".into());
    }
    Ok(())
}
fn varint(bytes: &[u8], position: &mut usize) -> Result<u64, String> {
    let mut value = 0u64;
    for index in 0..10 {
        let next = *bytes.get(*position).ok_or("protobuf 정수가 잘렸습니다.")?;
        *position += 1;
        if index == 9 && next > 1 {
            return Err("protobuf 정수가 범위를 초과했습니다.".into());
        }
        value |= ((next & 127) as u64) << (index * 7);
        if next < 128 {
            return Ok(value);
        }
    }
    Err("protobuf 정수 길이가 올바르지 않습니다.".into())
}
fn protobuf<'a>(bytes: &'a [u8], budget: &Budget) -> Result<Vec<(u64, &'a [u8])>, String> {
    let mut position = 0usize;
    let mut fields = Vec::new();
    let mut count = 0usize;
    while position < bytes.len() {
        count += 1;
        if count % 1024 == 0 {
            budget.check()?;
        }
        if count > 100_000 {
            return Err("protobuf 필드 개수가 제한을 초과했습니다.".into());
        }
        let tag = varint(bytes, &mut position)?;
        let number = tag >> 3;
        if number == 0 {
            return Err("protobuf 필드 번호가 올바르지 않습니다.".into());
        }
        let size = match tag & 7 {
            0 => {
                varint(bytes, &mut position)?;
                continue;
            }
            1 => 8usize,
            5 => 4usize,
            2 => {
                let size = varint(bytes, &mut position)?;
                if size > BLOB_LIMIT as u64 {
                    return Err("protobuf 값이 제한을 초과했습니다.".into());
                }
                size as usize
            }
            _ => return Err("지원하지 않는 protobuf 필드 형식입니다.".into()),
        };
        let field = bytes
            .get(position..position + size)
            .ok_or("protobuf 필드가 잘렸습니다.")?;
        position += size;
        if tag & 7 == 2 {
            fields.push((number, field));
        }
    }
    Ok(fields)
}
fn logs(bytes: &[u8], budget: &Budget) -> Result<(String, bool), String> {
    let mut position = 0usize;
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    let mut truncated = false;
    let mut frames = 0usize;
    fn append(output: &mut Vec<u8>, bytes: &[u8], truncated: &mut bool) {
        let count = bytes.len().min(LOG_LIMIT.saturating_sub(output.len()));
        output.extend_from_slice(&bytes[..count]);
        if count < bytes.len() {
            *truncated = true;
        }
    }
    while position < bytes.len() {
        budget.check()?;
        frames += 1;
        if frames > 100_000 {
            return Err("빌드 로그 프레임 개수가 제한을 초과했습니다.".into());
        }
        let header = bytes
            .get(position..position + 4)
            .ok_or("빌드 로그 프레임이 잘렸습니다.")?;
        position += 4;
        let size = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
        if size > BLOB_LIMIT {
            return Err("빌드 로그 프레임이 제한을 초과했습니다.".into());
        }
        let frame = bytes
            .get(position..position + size)
            .ok_or("빌드 로그 데이터가 잘렸습니다.")?;
        position += size;
        for (number, bytes) in protobuf(frame, budget)? {
            if ![1, 3, 4].contains(&number) {
                continue;
            }
            let fields = protobuf(bytes, budget)?;
            if number == 1 {
                let digest = fields
                    .iter()
                    .find(|(number, _)| *number == 1)
                    .map(|(_, bytes)| *bytes)
                    .unwrap_or_default();
                if let Some((_, name)) = fields.iter().find(|(number, _)| *number == 3) {
                    if seen.len() >= 20_000 {
                        return Err("빌드 로그 단계 개수가 제한을 초과했습니다.".into());
                    }
                    if seen.insert(digest.to_vec()) {
                        append(&mut output, b"# ", &mut truncated);
                        append(&mut output, name, &mut truncated);
                        append(&mut output, b"\n", &mut truncated);
                    }
                }
                if let Some((_, error)) = fields.iter().find(|(number, _)| *number == 7) {
                    append(&mut output, b"ERROR: ", &mut truncated);
                    append(&mut output, error, &mut truncated);
                    append(&mut output, b"\n", &mut truncated);
                }
            } else if let Some((_, message)) = fields
                .iter()
                .find(|(field, _)| *field == if number == 3 { 4 } else { 3 })
            {
                if number == 4 {
                    append(&mut output, b"WARNING: ", &mut truncated);
                }
                append(&mut output, message, &mut truncated);
            }
        }
    }
    Ok((String::from_utf8_lossy(&output).into_owned(), truncated))
}
fn timestamp(value: &Value) -> Value {
    if let Some(value) = value.as_str() {
        return if value.len() <= 128 {
            json!(value)
        } else {
            Value::Null
        };
    }
    let Some(seconds) = field(value, &["seconds", "Seconds"])
        .as_i64()
        .filter(|seconds| (-2_208_988_800..=253_402_300_799).contains(seconds))
    else {
        return Value::Null;
    };
    let mut days = seconds.div_euclid(86_400);
    let mut year = 1970i64;
    let leap = |year: i64| year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    while days < 0 {
        year -= 1;
        days += if leap(year) { 366 } else { 365 };
    }
    loop {
        let length = if leap(year) { 366 } else { 365 };
        if days < length {
            break;
        }
        days -= length;
        year += 1;
    }
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0usize;
    while month < 11 && days >= months[month] {
        days -= months[month];
        month += 1;
    }
    let time = seconds.rem_euclid(86_400);
    json!(format!(
        "{year:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        month + 1,
        days + 1,
        time / 3600,
        (time / 60) % 60,
        time % 60
    ))
}
pub(crate) fn parse(bytes: &[u8]) -> Result<Value, String> {
    let budget = Budget::new();
    let data = gzip(bytes, &budget)?;
    let entries = archive_entries(&data, &budget)?;
    let index = entries
        .get("index.json")
        .filter(|bytes| bytes.len() <= 1024 * 1024)
        .ok_or("OCI 인덱스가 없거나 너무 큽니다.")?;
    let index: Value =
        serde_json::from_slice(index).map_err(|_| "OCI 인덱스를 읽을 수 없습니다.")?;
    if index["schemaVersion"] != 2 {
        return Err("지원하지 않는 OCI 인덱스 버전입니다.".into());
    }
    let descriptors = index["manifests"]
        .as_array()
        .ok_or("OCI 기록 목록이 없습니다.")?;
    let mut manifests_found = Vec::new();
    let mut visited = HashSet::new();
    for descriptor in descriptors {
        manifests(
            &entries,
            descriptor,
            0,
            &mut visited,
            &mut manifests_found,
            &budget,
        )?;
    }
    let mut records = Vec::new();
    for manifest in manifests_found {
        budget.check()?;
        let record = json_blob(&entries, &manifest["config"])?;
        let reference = field(&record, &["Ref", "ref"])
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 512)
            .ok_or("빌드 기록 ID가 없습니다.")?;
        let attrs = field(&record, &["FrontendAttrs", "frontendAttrs"]);
        let local = field(&record, &["localState", "LocalState"]);
        let name = field(local, &["LocalPath", "localPath"])
            .as_str()
            .filter(|value| !value.is_empty())
            .or_else(|| attrs["filename"].as_str())
            .unwrap_or(reference);
        let completed = timestamp(field(&record, &["CompletedAt", "completedAt"]));
        let error = field(&record, &["error", "Error"]);
        let logs_descriptor = field(&record, &["logs", "Logs"]);
        let (content, truncated) = if logs_descriptor.is_null() {
            (String::new(), false)
        } else {
            logs(blob(&entries, logs_descriptor)?, &budget)?
        };
        records.push(json!({"ref":reference,"name":name,"status":if !error.is_null() {"Error"}else if completed.is_null(){"Running"}else{"Completed"},"createdAt":timestamp(field(&record,&["CreatedAt","createdAt"])),"completedAt":completed,"totalSteps":field(&record,&["numTotalSteps","NumTotalSteps"]),"cachedSteps":field(&record,&["numCachedSteps","NumCachedSteps"]),"details":record,"logs":content,"truncated":truncated}));
    }
    if records.is_empty() {
        return Err("가져올 수 있는 빌드 기록이 없습니다.".into());
    }
    let value = json!({"archiveSha256":sha256_budget(bytes, &budget)?,"archiveBytes":bytes.len(),"records":records});
    if serde_json::to_vec(&value)
        .map_err(|_| "빌드 기록을 구성할 수 없습니다.")?
        .len()
        > 16 * 1024 * 1024
    {
        return Err("가져온 기록이 16MB 보관 제한을 초과했습니다.".into());
    }
    budget.check()?;
    Ok(value)
}
