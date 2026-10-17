import codecs
import hashlib
import http.client
import io
import json
import math
import os
import re
import secrets
import signal
import socket
import stat
import sys
import tarfile
import time
from urllib.parse import quote

MAX_ENTRIES = 50000
MAX_BYTES = 2 * 1024 * 1024 * 1024
MAX_TEXT = 65536
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC
DIRECTORY = os.O_DIRECTORY | NOFOLLOW
request = json.loads(sys.argv[1])
last_progress = 0.0
processed_bytes = 0
processed_entries = 0
last_reference_check = 0.0


def emit(value):
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)


def progress(force=False):
    global last_progress
    now = time.monotonic()
    check_live_references(force)
    if force or now - last_progress >= 0.5:
        emit({"progress": True, "bytes": processed_bytes, "entries": processed_entries})
        last_progress = now


def timeout(_signal, _frame):
    raise TimeoutError("볼륨 작업 시간이 제한을 넘었습니다. 변경된 내용은 되돌리지 않습니다.")


signal.signal(signal.SIGALRM, timeout)
signal.alarm(900 if request.get("operation") in ("clone", "export", "import", "empty") else 45)


class UnixHttp(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(15)
        self.sock.connect("/var/run/docker.sock")


def docker(path):
    connection = UnixHttp("localhost", timeout=15)
    try:
        connection.request("GET", "/v" + request["api"] + path)
        response = connection.getresponse()
        body = response.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024 or response.status != 200:
            raise RuntimeError("Docker Engine에서 볼륨 정보를 확인하지 못했습니다.")
        return json.loads(body)
    finally:
        connection.close()


def fingerprint(volume):
    return {key: volume.get(key) for key in ("Name", "Driver", "Scope", "Mountpoint", "CreatedAt", "Labels", "Options")}


def absolute_directory(path):
    if not path.startswith("/") or "\x00" in path:
        raise ValueError("볼륨의 절대 경로를 확인할 수 없습니다.")
    current = os.open("/", os.O_RDONLY | DIRECTORY)
    try:
        for part in path.split("/"):
            if not part:
                continue
            if part in (".", ".."):
                raise ValueError("상위 경로나 링크로 연결된 볼륨은 열 수 없습니다.")
            next_fd = os.open(part, os.O_RDONLY | DIRECTORY, dir_fd=current)
            os.close(current)
            current = next_fd
        return current
    except BaseException:
        os.close(current)
        raise


def references(name):
    containers = docker("/containers/json?all=1&filters=" + quote(json.dumps({"volume": [name]}, separators=(",", ":")), safe=""))
    return [item for item in containers if any(mount.get("Type") == "volume" and mount.get("Name") == name for mount in item.get("Mounts", []))]


def check_live_references(force=False):
    global last_reference_check
    operation = request.get("operation")
    if operation not in ("import", "empty", "clone", "export"):
        return
    now = time.monotonic()
    if not force and now - last_reference_check < 1.0:
        return
    current = references(request["name"])
    if operation in ("import", "empty") and current:
        raise RuntimeError("작업 중 컨테이너 참조가 생겨 변경을 중단했습니다. 이미 적용한 항목은 되돌리지 않습니다.")
    if operation in ("clone", "export") and any(item.get("State") not in ("exited", "created", "dead") for item in current):
        raise RuntimeError("작업 중 원본 볼륨을 사용하는 컨테이너가 시작되어 중단했습니다.")
    if operation == "clone" and references(request["destination"]):
        raise RuntimeError("작업 중 복제 대상 볼륨에 컨테이너 참조가 생겨 중단했습니다.")
    last_reference_check = now


def open_volume(name, expected=None, unused=False, inactive=False):
    if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}", name):
        raise ValueError("볼륨 이름이 올바르지 않습니다.")
    info = docker("/info")
    if info.get("ID") != request["engineId"] or info.get("OSType") != "linux":
        raise RuntimeError("승인한 Docker Engine이 변경되었습니다.")
    volume = docker("/volumes/" + quote(name, safe=""))
    if expected is not None and fingerprint(volume) != expected:
        raise RuntimeError("볼륨 정보가 변경되었습니다. 다시 검사하세요.")
    if volume.get("Driver") != "local" or volume.get("Scope") != "local" or volume.get("Options"):
        raise RuntimeError("파일 작업은 드라이버 옵션이 없는 local 볼륨에서 지원합니다.")
    data_root = info.get("DockerRootDir", "").rstrip("/")
    expected_path = data_root + "/volumes/" + name + "/_data"
    if not data_root.startswith("/") or volume.get("Mountpoint") != expected_path:
        raise RuntimeError("Docker 데이터 폴더 아래의 볼륨 경로를 확인할 수 없습니다.")
    refs = references(name)
    if unused and refs:
        raise RuntimeError("실행 중이거나 중지된 컨테이너가 참조하는 볼륨은 변경할 수 없습니다.")
    if inactive and any(item.get("State") not in ("exited", "created", "dead") for item in refs):
        raise RuntimeError("실행 중인 컨테이너가 참조합니다. 원본을 일관되게 읽으려면 컨테이너를 먼저 중지하세요.")
    return absolute_directory(expected_path), volume


def parts(path, allow_root=True):
    if not isinstance(path, str) or len(path) > 4096 or any(ord(char) < 32 for char in path) or "\\" in path:
        raise ValueError("볼륨 안의 상대 경로가 올바르지 않습니다.")
    if path == "" and allow_root:
        return []
    result = path.split("/")
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path) or any(part in ("", ".", "..") for part in result):
        raise ValueError("볼륨 밖으로 나가는 경로는 사용할 수 없습니다.")
    return result


def mount_id(handle):
    with open("/proc/self/fdinfo/" + str(handle), "r", encoding="ascii") as source:
        for line in source.read(4096).splitlines():
            if line.startswith("mnt_id:"):
                return int(line.split(":", 1)[1].strip())
    raise ValueError("파일시스템의 연결 정보를 확인할 수 없습니다.")


def directory_at(root, path_parts, create=False):
    current = os.dup(root)
    try:
        for part in path_parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | DIRECTORY, dir_fd=current)
            if os.fstat(next_fd).st_dev != os.fstat(root).st_dev or mount_id(next_fd) != mount_id(root):
                os.close(next_fd)
                raise ValueError("다른 파일시스템으로 연결된 디렉터리는 지원하지 않습니다.")
            os.close(current)
            current = next_fd
        return current
    except BaseException:
        os.close(current)
        raise


def inspect_tree(root):
    entries = []
    total = 0
    path_bytes = 0
    digest = hashlib.sha256()
    device = os.fstat(root).st_dev

    def walk(parent, prefix, depth):
        nonlocal total, path_bytes
        if depth > 64:
            raise ValueError("디렉터리 깊이가 64단계를 넘습니다.")
        with os.scandir(parent) as iterator:
            for item in iterator:
                relative = prefix + item.name
                parts(relative, False)
                path_bytes += len(relative.encode("utf-8", "strict"))
                if path_bytes > 16 * 1024 * 1024:
                    raise ValueError("파일 경로 정보가 허용 크기를 넘습니다.")
                meta = item.stat(follow_symlinks=False)
                if meta.st_dev != device or not (stat.S_ISREG(meta.st_mode) or stat.S_ISDIR(meta.st_mode)):
                    raise ValueError("링크·장치·별도 파일시스템을 포함한 볼륨 파일 작업은 지원하지 않습니다.")
                if stat.S_ISREG(meta.st_mode) and meta.st_nlink != 1:
                    raise ValueError("하드 링크를 포함한 볼륨 파일 작업은 지원하지 않습니다.")
                entries.append((relative, meta))
                if len(entries) > MAX_ENTRIES:
                    raise ValueError("파일 수가 50,000개 제한을 넘습니다.")
                if stat.S_ISREG(meta.st_mode):
                    total += meta.st_size
                    if total > MAX_BYTES:
                        raise ValueError("볼륨 파일 작업은 한 번에 2 GB까지 지원합니다.")
                digest.update(json.dumps([relative, meta.st_ino, meta.st_mode, meta.st_uid, meta.st_gid, meta.st_size, meta.st_mtime_ns], ensure_ascii=True, separators=(",", ":")).encode("ascii"))
                if stat.S_ISDIR(meta.st_mode):
                    child = os.open(item.name, os.O_RDONLY | DIRECTORY, dir_fd=parent)
                    try:
                        if os.fstat(child).st_ino != meta.st_ino or mount_id(child) != mount_id(root):
                            raise RuntimeError("디렉터리가 검사 중 변경되었습니다.")
                        walk(child, relative + "/", depth + 1)
                    finally:
                        os.close(child)
    walk(root, "", 0)
    return entries, {"entries": len(entries), "bytes": total, "treeId": digest.hexdigest(), "rootDevice": str(device), "rootInode": str(os.fstat(root).st_ino)}


def file_at(root, relative, flags=os.O_RDONLY):
    path_parts = parts(relative, False)
    parent = directory_at(root, path_parts[:-1])
    try:
        handle = os.open(path_parts[-1], flags | NOFOLLOW, 0o600, dir_fd=parent)
    finally:
        os.close(parent)
    meta = os.fstat(handle)
    if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or meta.st_dev != os.fstat(root).st_dev or mount_id(handle) != mount_id(root):
        os.close(handle)
        raise ValueError("일반 파일만 열 수 있습니다. 링크와 장치는 지원하지 않습니다.")
    return handle


def copy_stream(source, destination, length):
    global processed_bytes
    remaining = length
    while remaining:
        chunk = source.read(min(1024 * 1024, remaining))
        if not chunk:
            raise RuntimeError("원본 파일이 읽는 중 변경되었거나 끝까지 읽히지 않았습니다.")
        destination.write(chunk)
        remaining -= len(chunk)
        processed_bytes += len(chunk)
        progress()


def validate_tar_headers(source):
    length = os.fstat(source.fileno()).st_size
    count = 0
    extension_bytes = 0
    consecutive_extensions = 0
    while source.tell() + 512 <= length:
        header = source.read(512)
        if header == bytes(512):
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    source.seek(0)
                    return
                if any(chunk):
                    raise ValueError("tar 끝에 지원하지 않는 추가 데이터가 있습니다.")
        count += 1
        if count > MAX_ENTRIES * 2:
            raise ValueError("tar 헤더 수가 지원 범위를 넘습니다.")
        size_field = header[124:136].strip(b" \x00")
        checksum_field = header[148:156].strip(b" \x00")
        if not size_field or any(byte not in b"01234567" for byte in size_field) or not checksum_field or any(byte not in b"01234567" for byte in checksum_field):
            raise ValueError("tar 헤더의 크기나 체크섬 형식이 지원되지 않습니다.")
        if int(checksum_field, 8) != sum(header[:148]) + 8 * 32 + sum(header[156:]):
            raise ValueError("tar 헤더 체크섬이 일치하지 않습니다.")
        size = int(size_field, 8)
        kind = header[156:157]
        if kind in (b"x", b"L"):
            consecutive_extensions += 1
            extension_bytes += size
            if consecutive_extensions > 2 or size > 65536 or extension_bytes > 1024 * 1024:
                raise ValueError("tar 경로 확장 정보가 허용 크기를 넘습니다.")
        elif kind not in (b"\x00", b"0", b"5"):
            raise ValueError("tar의 링크·장치·전역 확장·희소 항목은 지원하지 않습니다.")
        else:
            consecutive_extensions = 0
        padded = ((size + 511) // 512) * 512
        if size > MAX_BYTES or source.tell() + padded > length:
            raise ValueError("tar 항목이 파일 크기 범위를 벗어났습니다.")
        source.seek(padded, os.SEEK_CUR)
    raise ValueError("tar 파일이 끝까지 저장되지 않았습니다.")


def archive_members(archive):
    seen = set()
    total = 0
    result = []
    path_bytes = 0
    for member in archive:
        path = member.name.rstrip("/")
        while path.startswith("./"):
            path = path[2:]
        if path in ("", ".") and member.isdir():
            continue
        parts(path, False)
        path_bytes += len(path.encode("utf-8", "strict"))
        if path_bytes > 16 * 1024 * 1024:
            raise ValueError("tar 파일의 경로 정보가 허용 크기를 넘습니다.")
        if path in seen or len(seen) >= MAX_ENTRIES:
            raise ValueError("중복된 경로나 50,000개를 넘는 항목이 있는 tar는 지원하지 않습니다.")
        if not (member.isdir() or member.isreg()) or member.linkname or getattr(member, "sparse", None) or any(key.startswith("GNU.sparse") for key in member.pax_headers):
            raise ValueError("tar에는 일반 파일과 디렉터리만 허용합니다. 링크·장치·희소 항목은 지원하지 않습니다.")
        if member.size < 0 or (member.isdir() and member.size != 0) or member.size > MAX_BYTES:
            raise ValueError("tar 항목의 크기가 올바르지 않습니다.")
        if member.uid < 0 or member.gid < 0 or member.uid > 2147483647 or member.gid > 2147483647:
            raise ValueError("tar의 파일 소유자 정보가 지원 범위를 벗어났습니다.")
        if not isinstance(member.mtime, (int, float)) or not math.isfinite(member.mtime) or not -2147483648 <= member.mtime <= 253402300799:
            raise ValueError("tar의 파일 시각 정보가 지원 범위를 벗어났습니다.")
        seen.add(path)
        total += member.size
        if total > MAX_BYTES:
            raise ValueError("가져올 파일 합계가 2 GB 제한을 넘습니다.")
        member.name = path
        result.append(member)
    kinds = {member.name: member.isdir() for member in result}
    for member in result:
        parent = member.name.rpartition("/")[0]
        while parent:
            if parent in kinds and not kinds[parent]:
                raise ValueError("파일 아래로 이어지는 tar 경로는 사용할 수 없습니다.")
            parent = parent.rpartition("/")[0]
    return result, total


def open_archive(path):
    if not isinstance(path, str) or not path.startswith("/mnt/") or len(path) > 4096:
        raise ValueError("백엔드에서 선택한 로컬 tar 파일이 필요합니다.")
    handle = os.open(path, os.O_RDONLY | NOFOLLOW)
    meta = os.fstat(handle)
    if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or meta.st_size > MAX_BYTES or meta.st_size < 1024:
        os.close(handle)
        raise ValueError("일반 tar 파일만 가져올 수 있으며 최대 크기는 2 GB입니다.")
    return os.fdopen(handle, "rb")


def import_plan(entries, members, mode):
    if mode not in ("merge", "replace"):
        raise ValueError("가져오기 방식은 merge 또는 replace로 선택하세요.")
    existing = dict(entries)
    desired = {member.name: member.isdir() for member in members}
    implied = dict(desired)
    for path in desired:
        parent = path.rpartition("/")[0]
        while parent:
            if parent in implied and not implied[parent]:
                raise ValueError("tar에 파일 아래로 이어지는 경로가 있습니다.")
            implied[parent] = True
            if len(implied) > MAX_ENTRIES:
                raise ValueError("가져올 파일과 상위 폴더가 50,000개 제한을 넘습니다.")
            parent = parent.rpartition("/")[0]
    overwritten = []
    overwritten_bytes = 0
    if mode == "merge":
        for path, is_directory in implied.items():
            meta = existing.get(path)
            if meta is not None and stat.S_ISDIR(meta.st_mode) != is_directory:
                raise ValueError("파일과 폴더 형식이 충돌합니다: " + path + ". 전체 교체를 선택하거나 tar 경로를 수정하세요.")
        for member in members:
            if member.isreg() and member.name in existing:
                overwritten.append(member.name)
                overwritten_bytes += existing[member.name].st_size
        final_entries = len(set(existing).union(implied))
        final_bytes = sum(meta.st_size for _path, meta in entries if stat.S_ISREG(meta.st_mode)) - overwritten_bytes + sum(member.size for member in members)
        if final_entries > MAX_ENTRIES or final_bytes > MAX_BYTES:
            raise ValueError("가져오기 후 볼륨이 파일 작업 제한(2 GB·50,000개)을 넘습니다.")
    return {
        "mode": mode,
        "overwrittenFiles": len(overwritten),
        "overwrittenPaths": sorted(overwritten)[:50],
        "overwrittenPathsTruncated": len(overwritten) > 50,
        "createdFiles": sum(member.isreg() for member in members) - len(overwritten),
        "removedEntries": len(entries) if mode == "replace" else 0,
        "removedBytes": sum(meta.st_size for _path, meta in entries if stat.S_ISREG(meta.st_mode)) if mode == "replace" else 0,
        "preservedEntries": len(entries) - len(overwritten) if mode == "merge" else 0,
    }


def empty_tree(root, entries):
    global processed_entries
    for relative, meta in reversed(entries):
        path_parts = parts(relative, False)
        parent = directory_at(root, path_parts[:-1])
        try:
            current = os.stat(path_parts[-1], dir_fd=parent, follow_symlinks=False)
            if current.st_ino != meta.st_ino or current.st_dev != meta.st_dev:
                raise RuntimeError("삭제 대상이 검사 후 변경되었습니다.")
            check_live_references(True)
            if stat.S_ISDIR(meta.st_mode):
                os.rmdir(path_parts[-1], dir_fd=parent)
            else:
                os.unlink(path_parts[-1], dir_fd=parent)
            processed_entries += 1
            progress()
        finally:
            os.close(parent)


def write_archive_file(root, archive, member, existing):
    path_parts = parts(member.name, False)
    parent = directory_at(root, path_parts[:-1], True)
    temporary = ".dockslate-import-" + secrets.token_hex(12) + ".tmp"
    handle = None
    identity = None
    try:
        handle = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=parent)
        identity = os.fstat(handle).st_ino
        with os.fdopen(handle, "w+b") as destination:
            handle = None
            with archive.extractfile(member) as source:
                copy_stream(source, destination, member.size)
            destination.flush()
            os.fchown(destination.fileno(), member.uid, member.gid)
            os.fchmod(destination.fileno(), member.mode & 0o777)
            os.utime(destination.fileno(), (member.mtime, member.mtime))
            staged = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(staged.st_mode) or staged.st_ino != identity or staged.st_nlink != 1:
                raise RuntimeError("가져올 파일의 임시 저장 항목이 변경되었습니다.")
            previous = existing.get(member.name)
            check_live_references(True)
            try:
                current = os.stat(path_parts[-1], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                current = None
            if previous is None:
                if current is not None:
                    raise RuntimeError("검사 이후 대상 파일이 생겼습니다: " + member.name)
                os.link(temporary, path_parts[-1], src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            else:
                if current is None or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or current.st_dev != previous.st_dev or current.st_ino != previous.st_ino or current.st_size != previous.st_size or current.st_mtime_ns != previous.st_mtime_ns:
                    raise RuntimeError("덮어쓸 대상 파일이 검사 이후 변경되었습니다: " + member.name)
                os.replace(temporary, path_parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
            committed = os.stat(path_parts[-1], dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(committed.st_mode) or committed.st_ino != identity:
                raise RuntimeError("가져온 대상 파일의 식별 정보를 확인할 수 없습니다.")
    finally:
        if handle is not None:
            os.close(handle)
        if identity is not None:
            try:
                current = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
                if current.st_ino == identity and stat.S_ISREG(current.st_mode):
                    os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        os.close(parent)


def main():
    global processed_entries
    operation = request.get("operation")
    if operation not in ("browse", "file", "summary", "clone", "export", "archive_check", "import_plan", "import", "empty"):
        raise ValueError("지원하지 않는 볼륨 작업입니다.")
    if operation == "archive_check":
        with open_archive(request["archivePath"]) as source:
            validate_tar_headers(source)
            digest = hashlib.file_digest(source, "sha256").hexdigest()
            source.seek(0)
            with tarfile.open(fileobj=source, mode="r:") as archive:
                members, total = archive_members(archive)
                return {"entries": len(members), "bytes": total, "sha256": digest}
    root, _volume = open_volume(request["name"], request.get("expectedVolume"), unused=operation in ("empty", "import", "import_plan"), inactive=operation in ("clone", "export"))
    try:
        if operation == "browse":
            current = directory_at(root, parts(request.get("path", "")))
            try:
                result = []
                with os.scandir(current) as iterator:
                    for entry in iterator:
                        if len(result) >= 1000:
                            raise ValueError("항목이 1,000개를 넘는 폴더입니다. 더 작은 하위 폴더를 선택하세요.")
                        meta = entry.stat(follow_symlinks=False)
                        kind = "directory" if stat.S_ISDIR(meta.st_mode) else "file" if stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 else "unsupported"
                        result.append({"name": entry.name, "kind": kind, "size": meta.st_size, "modified": int(meta.st_mtime)})
                result.sort(key=lambda item: (item["kind"] != "directory", item["name"].lower()))
                return {"path": request.get("path", ""), "entries": result}
            finally:
                os.close(current)
        if operation == "file":
            handle = file_at(root, request["path"])
            with os.fdopen(handle, "rb") as source:
                raw = source.read(MAX_TEXT + 1)
                if b"\x00" in raw:
                    raise ValueError("바이너리 파일은 미리 볼 수 없습니다.")
                try:
                    content = codecs.getincrementaldecoder("utf-8")("strict").decode(raw[:MAX_TEXT], final=len(raw) <= MAX_TEXT)
                except UnicodeDecodeError:
                    raise ValueError("UTF-8 텍스트 파일만 미리 볼 수 있습니다.")
                return {"path": request["path"], "text": content, "truncated": len(raw) > MAX_TEXT, "limitBytes": MAX_TEXT}
        entries, summary = inspect_tree(root)
        if operation == "summary":
            return summary
        if operation == "import_plan":
            with open_archive(request["archivePath"]) as source:
                validate_tar_headers(source)
                digest = hashlib.file_digest(source, "sha256").hexdigest()
                source.seek(0)
                with tarfile.open(fileobj=source, mode="r:") as archive:
                    members, total = archive_members(archive)
                    plan = import_plan(entries, members, request.get("mode"))
                    return {"summary": summary, "archive": {"entries": len(members), "bytes": total, "sha256": digest}, "plan": plan}
        expected = request.get("expectedTree")
        if expected is not None and summary != expected:
            raise RuntimeError("검사 이후 볼륨 파일이 변경되었습니다. 다시 검사하세요.")
        if operation == "empty":
            if references(request["name"]):
                raise RuntimeError("검사 이후 컨테이너 참조가 생겨 비우기를 중단했습니다.")
            empty_tree(root, entries)
            progress(True)
            return {"message": "볼륨 안의 파일을 모두 비웠습니다.", "entries": processed_entries}
        if operation == "import":
            with open_archive(request["archivePath"]) as source:
                validate_tar_headers(source)
                if hashlib.file_digest(source, "sha256").hexdigest() != request["archiveSha256"]:
                    raise RuntimeError("검사한 tar 파일이 변경되었습니다.")
                source.seek(0)
                with tarfile.open(fileobj=source, mode="r:") as archive:
                    members, _total = archive_members(archive)
                    plan = import_plan(entries, members, request.get("mode"))
                    if plan != request.get("expectedPlan"):
                        raise RuntimeError("가져오기 영향이 검사 이후 변경되었습니다. 다시 검사하세요.")
                    if inspect_tree(root)[1] != summary or references(request["name"]):
                        raise RuntimeError("검사 이후 볼륨이나 컨테이너 참조가 변경되었습니다.")
                    if request["mode"] == "replace":
                        empty_tree(root, entries)
                    existing = dict(entries) if request["mode"] == "merge" else {}
                    for member in members:
                        path_parts = parts(member.name, False)
                        if member.isdir():
                            check_live_references(True)
                            target = directory_at(root, path_parts, True)
                            try:
                                os.fchmod(target, member.mode & 0o777)
                                os.fchown(target, member.uid, member.gid)
                            finally:
                                os.close(target)
                        else:
                            write_archive_file(root, archive, member, existing)
                        processed_entries += 1
                        progress()
                    for member in sorted((entry for entry in members if entry.isdir()), key=lambda entry: entry.name.count("/"), reverse=True):
                        check_live_references(True)
                        target = directory_at(root, parts(member.name, False))
                        try:
                            os.utime(target, (member.mtime, member.mtime))
                        finally:
                            os.close(target)
            progress(True)
            return {"message": "tar 파일을 볼륨으로 가져왔습니다.", "entries": processed_entries, "bytes": processed_bytes}
        destination_root = None
        output = None
        archive = None
        try:
            if operation == "clone":
                destination_root, _destination = open_volume(request["destination"], request["expectedDestination"], unused=True)
                if inspect_tree(destination_root)[0]:
                    raise RuntimeError("복제 대상 볼륨이 비어 있지 않습니다.")
            else:
                output = os.fdopen(os.open(request["archivePath"], os.O_RDWR | NOFOLLOW), "r+b", buffering=0)
                output_meta = os.fstat(output.fileno())
                if not stat.S_ISREG(output_meta.st_mode) or output_meta.st_nlink != 1 or output_meta.st_size != 0:
                    raise RuntimeError("내보내기 파일이 비어 있지 않습니다.")
                class ArchiveWriter:
                    def write(self, value):
                        global processed_bytes
                        if output.tell() + len(value) > MAX_BYTES:
                            raise ValueError("내보내기 tar 파일이 2 GB 제한을 넘습니다. 일부 파일이 남았습니다.")
                        result = output.write(value)
                        processed_bytes += result
                        progress()
                        return result
                archive = tarfile.open(fileobj=ArchiveWriter(), mode="w|", format=tarfile.USTAR_FORMAT)
            for relative, meta in entries:
                check_live_references(True)
                if operation == "clone":
                    if stat.S_ISDIR(meta.st_mode):
                        target = directory_at(destination_root, parts(relative, False), True)
                        try:
                            os.fchmod(target, meta.st_mode & 0o777)
                            os.fchown(target, meta.st_uid, meta.st_gid)
                        finally:
                            os.close(target)
                    else:
                        parent = directory_at(destination_root, parts(relative, False)[:-1], True)
                        try:
                            target = os.open(parts(relative, False)[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, meta.st_mode & 0o777, dir_fd=parent)
                        finally:
                            os.close(parent)
                        with os.fdopen(file_at(root, relative), "rb") as source, os.fdopen(target, "wb") as destination:
                            current = os.fstat(source.fileno())
                            if (current.st_ino, current.st_size, current.st_mtime_ns) != (meta.st_ino, meta.st_size, meta.st_mtime_ns):
                                raise RuntimeError("복제 중 원본 파일이 변경되었습니다.")
                            copy_stream(source, destination, meta.st_size)
                            os.fchown(destination.fileno(), meta.st_uid, meta.st_gid)
                            os.fchmod(destination.fileno(), meta.st_mode & 0o777)
                            os.utime(destination.fileno(), ns=(meta.st_atime_ns, meta.st_mtime_ns))
                else:
                    item = tarfile.TarInfo(relative)
                    item.mode, item.uid, item.gid, item.mtime = meta.st_mode & 0o777, meta.st_uid, meta.st_gid, int(meta.st_mtime)
                    if stat.S_ISDIR(meta.st_mode):
                        item.type = tarfile.DIRTYPE
                        archive.addfile(item)
                    else:
                        item.size = meta.st_size
                        with os.fdopen(file_at(root, relative), "rb") as source:
                            current = os.fstat(source.fileno())
                            if (current.st_ino, current.st_size, current.st_mtime_ns) != (meta.st_ino, meta.st_size, meta.st_mtime_ns):
                                raise RuntimeError("내보내기 중 원본 파일이 변경되었습니다.")
                            archive.addfile(item, source)
                processed_entries += 1
                progress()
            if operation == "clone":
                for relative, meta in reversed(entries):
                    if stat.S_ISDIR(meta.st_mode):
                        check_live_references(True)
                        target = directory_at(destination_root, parts(relative, False))
                        try:
                            os.utime(target, ns=(meta.st_atime_ns, meta.st_mtime_ns))
                        finally:
                            os.close(target)
            if inspect_tree(root)[1] != summary:
                raise RuntimeError("원본 볼륨이 작업 중 변경되었습니다. 대상에는 일부 파일이 남을 수 있습니다.")
            if any(item.get("State") not in ("exited", "created", "dead") for item in references(request["name"])):
                raise RuntimeError("작업 중 원본 볼륨을 사용하는 컨테이너가 시작되었습니다. 결과의 일관성을 확인하세요.")
            progress(True)
            return {"message": "볼륨 복제를 완료했습니다." if operation == "clone" else "볼륨을 tar 파일로 내보냈습니다.", "entries": len(entries), "bytes": summary["bytes"]}
        finally:
            if archive:
                archive.close()
            if output:
                output.close()
            if destination_root is not None:
                os.close(destination_root)
    finally:
        os.close(root)


try:
    emit({"result": main()})
except BaseException as error:
    emit({"error": str(error)[:4000]})
    sys.exit(1)
